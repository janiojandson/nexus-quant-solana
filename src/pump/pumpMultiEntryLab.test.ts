import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildExecutableReplayPath,
  dueEntryWindows,
  entryWindowToCohort,
  strategySummaryKey
} from './pumpMultiEntryLab.js';

test('multi-entry agenda lançamento, 30s, 3m e 5m separadamente para o mesmo mint', () => {
  const seen = new Set<any>();
  assert.deepEqual(dueEntryWindows({ ageMs: 10_000, progressPct: 5, complete: false, seen }), ['LAUNCH_0_15S']);
  seen.add('LAUNCH_0_15S');

  assert.deepEqual(dueEntryWindows({ ageMs: 35_000, progressPct: 10, complete: false, seen }), ['ENTRY_30S']);
  seen.add('ENTRY_30S');

  assert.deepEqual(dueEntryWindows({ ageMs: 180_000, progressPct: 15, complete: false, seen }), ['ENTRY_3M']);
  seen.add('ENTRY_3M');

  assert.deepEqual(dueEntryWindows({ ageMs: 300_000, progressPct: 20, complete: false, seen }), ['ENTRY_5M']);
});

test('multi-entry usa a faixa atual de graduação sem preencher faixas antigas retroativamente', () => {
  const seen = new Set<any>();
  assert.deepEqual(dueEntryWindows({ ageMs: 90_000, progressPct: 67, complete: false, seen }), ['NEAR_GRAD_60_80']);
  seen.add('NEAR_GRAD_60_80');
  assert.deepEqual(dueEntryWindows({ ageMs: 120_000, progressPct: 84, complete: false, seen }), ['NEAR_GRAD_80_95']);
  seen.add('NEAR_GRAD_80_95');
  assert.deepEqual(dueEntryWindows({ ageMs: 140_000, progressPct: 97, complete: false, seen }), ['NEAR_GRAD_95_100']);

  const late = new Set<any>();
  assert.deepEqual(dueEntryWindows({ ageMs: 140_000, progressPct: 97, complete: false, seen: late }), ['NEAR_GRAD_95_100']);
});

test('multi-entry mede pós-graduação em 0-2m e 2-10m', () => {
  const seen = new Set<any>();
  assert.deepEqual(dueEntryWindows({
    ageMs: 200_000,
    progressPct: 100,
    complete: true,
    sinceGraduationMs: 45_000,
    seen
  }), ['POST_GRAD_0_2M']);
  seen.add('POST_GRAD_0_2M');
  assert.deepEqual(dueEntryWindows({
    ageMs: 400_000,
    progressPct: 100,
    complete: true,
    sinceGraduationMs: 180_000,
    seen
  }), ['POST_GRAD_2_10M']);
});

test('janela explícita continua mapeada ao cohort estatístico original', () => {
  assert.equal(entryWindowToCohort('LAUNCH_0_15S'), 'BIRTH_0_15S');
  assert.equal(entryWindowToCohort('ENTRY_30S'), 'BIRTH_15_60S');
  assert.equal(entryWindowToCohort('ENTRY_3M'), 'EARLY_1_5M');
  assert.equal(entryWindowToCohort('ENTRY_5M'), 'CURVE_5_15M');
});

test('resumo separa a entrada do horizonte de saída', () => {
  assert.equal(strategySummaryKey('ENTRY_3M', '5m'), 'ENTRY_3M@5m');
  assert.equal(strategySummaryKey('NEAR_GRAD_95_100', '30s'), 'NEAR_GRAD_95_100@30s');
});

test('replay ignora marcas sem saída executável e ordena o caminho', () => {
  assert.deepEqual(buildExecutableReplayPath(1, 1_000, [
    { observedAtMs: 31_000, grossExitValueSol: 1.5, executable: true },
    { observedAtMs: 16_000, grossExitValueSol: 1.2, executable: true },
    { observedAtMs: 21_000, grossExitValueSol: 0, executable: false }
  ]), [
    { atMs: 1_000, valueSol: 1 },
    { atMs: 16_000, valueSol: 1.2 },
    { atMs: 31_000, valueSol: 1.5 }
  ]);
});


test('janela de graduação não impede a janela temporal do mesmo mint no tick seguinte', () => {
  const seen = new Set<any>();
  assert.deepEqual(dueEntryWindows({ ageMs: 180_000, progressPct: 70, complete: false, seen }), ['NEAR_GRAD_60_80']);
  seen.add('NEAR_GRAD_60_80');
  assert.deepEqual(dueEntryWindows({ ageMs: 180_001, progressPct: 70, complete: false, seen }), ['ENTRY_3M']);
});

test('entrada de minuto 5 e faixa de 5-15m geram evidências distintas sem retroagir', () => {
  const seen = new Set<any>(['ENTRY_5M']);
  assert.deepEqual(dueEntryWindows({ ageMs: 360_000, progressPct: 20, complete: false, seen }), ['CURVE_5_15M']);
  assert.deepEqual(dueEntryWindows({ ageMs: 720_000, progressPct: 20, complete: false, seen: new Set() }), ['CURVE_5_15M']);
  assert.equal(entryWindowToCohort('CURVE_5_15M' as any), 'CURVE_5_15M');
  seen.add('CURVE_5_15M');
  assert.deepEqual(dueEntryWindows({ ageMs: 900_000, progressPct: 20, complete: false, seen }), []);
});
