import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyPumpCohort } from './pumpCohorts.js';

test('classifies all pre-graduation age and progress boundaries deterministically', () => {
  assert.equal(classifyPumpCohort({ ageMs: 14_999, progressPct: 10, nowMs: 0 }), 'BIRTH_0_15S');
  assert.equal(classifyPumpCohort({ ageMs: 15_000, progressPct: 10, nowMs: 0 }), 'BIRTH_15_60S');
  assert.equal(classifyPumpCohort({ ageMs: 60_000, progressPct: 10, nowMs: 0 }), 'EARLY_1_5M');
  assert.equal(classifyPumpCohort({ ageMs: 300_000, progressPct: 10, nowMs: 0 }), 'CURVE_5_15M');
  assert.equal(classifyPumpCohort({ ageMs: 100_000, progressPct: 60, nowMs: 0 }), 'NEAR_GRAD_60_80');
  assert.equal(classifyPumpCohort({ ageMs: 100_000, progressPct: 80, nowMs: 0 }), 'NEAR_GRAD_80_95');
  assert.equal(classifyPumpCohort({ ageMs: 100_000, progressPct: 95, nowMs: 0 }), 'NEAR_GRAD_95_100');
});

test('post-graduation cohorts override curve progress and expire after ten minutes', () => {
  assert.equal(classifyPumpCohort({ ageMs: 999_999, progressPct: 100, graduatedAtMs: 1_000_000, nowMs: 1_119_999 }), 'POST_GRAD_0_2M');
  assert.equal(classifyPumpCohort({ ageMs: 999_999, progressPct: 100, graduatedAtMs: 1_000_000, nowMs: 1_120_000 }), 'POST_GRAD_2_10M');
  assert.equal(classifyPumpCohort({ ageMs: 999_999, progressPct: 100, graduatedAtMs: 1_000_000, nowMs: 1_600_001 }), undefined);
});
