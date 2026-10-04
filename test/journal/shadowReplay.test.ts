import test from 'node:test';
import * as assert from 'node:assert/strict';
import {
  isShadowJournalEnabled,
  syntheticReplayId,
  reconstructIncidentJournal
} from '../../src/journal/shadowJournal';
import { InMemoryExitJournalRepository } from '../../src/journal/repository';

test('Nexus V2.1A — Shadow Journal & Historical Replay Validation (C5)', async (t) => {
  // 1. Shadow flag default is false
  await t.test('1. NEXUS_V2_JOURNAL_SHADOW_ENABLED é falso por padrão', () => {
    const originalEnv = process.env.NEXUS_V2_JOURNAL_SHADOW_ENABLED;
    delete process.env.NEXUS_V2_JOURNAL_SHADOW_ENABLED;
    try {
      assert.strictEqual(isShadowJournalEnabled(), false);
      process.env.NEXUS_V2_JOURNAL_SHADOW_ENABLED = 'false';
      assert.strictEqual(isShadowJournalEnabled(), false);
      process.env.NEXUS_V2_JOURNAL_SHADOW_ENABLED = 'true';
      assert.strictEqual(isShadowJournalEnabled(), true);
    } finally {
      if (originalEnv !== undefined) {
        process.env.NEXUS_V2_JOURNAL_SHADOW_ENABLED = originalEnv;
      } else {
        delete process.env.NEXUS_V2_JOURNAL_SHADOW_ENABLED;
      }
    }
  });

  // 2. Synthetic Replay ID é determinístico
  await t.test('2. syntheticReplayId gera IDs determinísticos padronizados', () => {
    assert.strictEqual(syntheticReplayId('intent', 'tesla', '1'), 'synth_intent_tesla_1');
    assert.strictEqual(syntheticReplayId('attempt', 'superpig', 'crash'), 'synth_attempt_superpig_crash');
    assert.strictEqual(syntheticReplayId('fill', 'mrbeast', 2), 'synth_fill_mrbeast_2');
    assert.strictEqual(syntheticReplayId('rec', 'ssi', 'timeout'), 'synth_rec_ssi_timeout');
  });

  // 3. Replay Histórico: Tesla (2 fills: partial + final)
  await t.test('3. reconstructIncidentJournal para Tesla reconstrói Intent, Attempts, 2 Fills e APPLIED com sucesso', async () => {
    const repo = new InMemoryExitJournalRepository();
    const summary = await reconstructIncidentJournal('tesla', repo);

    assert.strictEqual(summary.incidentId, 'TESLA');
    assert.strictEqual(summary.intent.status, 'APPLIED');
    assert.strictEqual(summary.intent.reconciliationDebt, false);
    assert.strictEqual(summary.attempts.length, 2);
    assert.strictEqual(summary.fills.length, 2, 'Tesla possui 2 fills auditados: partial e final');
    assert.strictEqual(summary.fills[0].grossProceedsLamports, '13533348', 'Partial sell: 0.013533348 SOL');
    assert.strictEqual(summary.fills[1].grossProceedsLamports, '41149', 'Final sell: 0.000041149 SOL');
    assert.strictEqual(summary.totalConfirmedProceedsLamports, 13574497n, 'Total confirmado = 13,533,348 + 41,149 = 13,574,497 lamports');
    assert.strictEqual(summary.rentRecoveredLamports, 1508840n, 'Aluguel ATA recuperado segregado');
    assert.strictEqual(summary.accounting.fillsCount, 2);
    assert.strictEqual(summary.accounting.isFullyClosed, true);
  });

  // 4. Replay Histórico: SSI (2 fills: partial + final)
  await t.test('4. reconstructIncidentJournal para SSI reconstrói Intent e 2 Fills com sucesso', async () => {
    const repo = new InMemoryExitJournalRepository();
    const summary = await reconstructIncidentJournal('ssi', repo);

    assert.strictEqual(summary.incidentId, 'SSI');
    assert.strictEqual(summary.intent.status, 'APPLIED');
    assert.strictEqual(summary.attempts.length, 2);
    assert.strictEqual(summary.fills.length, 2, 'SSI possui 2 fills auditados: partial e final');
    assert.strictEqual(summary.fills[0].grossProceedsLamports, '14854168', 'Partial sell: 0.014854168 SOL');
    assert.strictEqual(summary.fills[1].grossProceedsLamports, '2137281', 'Final sell: 0.002137281 SOL');
    assert.strictEqual(summary.totalConfirmedProceedsLamports, 16991449n, 'Total confirmado = 14,854,168 + 2,137,281 = 16,991,449 lamports');
    assert.strictEqual(summary.accounting.fillsCount, 2);
    assert.strictEqual(summary.accounting.isFullyClosed, true);
  });

  // 5. Replay Histórico: Mr Beast (2 fills: partial + final)
  await t.test('5. reconstructIncidentJournal para Mr Beast reconstrói Intent e 2 Fills com sucesso', async () => {
    const repo = new InMemoryExitJournalRepository();
    const summary = await reconstructIncidentJournal('mr-beast', repo);

    assert.strictEqual(summary.incidentId, 'MR_BEAST');
    assert.strictEqual(summary.intent.status, 'APPLIED');
    assert.strictEqual(summary.attempts.length, 2);
    assert.strictEqual(summary.fills.length, 2, 'Mr Beast possui 2 fills auditados: partial e final');
    assert.strictEqual(summary.fills[0].grossProceedsLamports, '15402873', 'Partial sell: 0.015402873 SOL');
    assert.strictEqual(summary.fills[1].grossProceedsLamports, '1655182', 'Final sell: 0.001655182 SOL');
    assert.strictEqual(summary.totalConfirmedProceedsLamports, 17058055n, 'Total confirmado = 15,402,873 + 1,655,182 = 17,058,055 lamports');
    assert.strictEqual(summary.accounting.fillsCount, 2);
    assert.strictEqual(summary.accounting.isFullyClosed, true);
  });

  // 6. Replay Histórico: SUPERPIG (3 simulações falhas com 0 fills + timeout UNKNOWN + fill final confirmado)
  await t.test('6. reconstructIncidentJournal para SUPERPIG preserva divergência: 3 simulações falhas com 0 fills e fill final on-chain', async () => {
    const repo = new InMemoryExitJournalRepository();
    const summary = await reconstructIncidentJournal('superpig', repo);

    assert.strictEqual(summary.incidentId, 'SUPERPIG');
    assert.strictEqual(summary.attempts.length, 5, '3 simulações falhas + 1 timeout UNKNOWN + 1 attempt final confirmada');
    assert.strictEqual(summary.fills.length, 1, 'Tentativas de simulação geram ZERO fills; fill final real é preservado');
    assert.strictEqual(summary.fills[0].grossProceedsLamports, '3183856', 'On-chain proceeds reais: 0.003183856 SOL');
    assert.strictEqual(summary.totalConfirmedProceedsLamports, 3183856n);
    assert.strictEqual(summary.accountingDivergenceLamports, 7117144n, 'Divergência histórica de 0.007117144 SOL preservada');
    assert.strictEqual(summary.reconciliations.length, 1);
    assert.strictEqual(summary.accounting.fillsCount, 1);
    assert.strictEqual(summary.accounting.isFullyClosed, true);
  });
});
