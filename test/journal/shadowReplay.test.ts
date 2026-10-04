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

  // 3. Replay Histórico: Tesla
  await t.test('3. reconstructIncidentJournal para Tesla reconstrói Intent, Attempt, Fill e APPLIED com sucesso', async () => {
    const repo = new InMemoryExitJournalRepository();
    const summary = await reconstructIncidentJournal('tesla', repo);

    assert.strictEqual(summary.incidentId, 'TESLA');
    assert.strictEqual(summary.intent.status, 'APPLIED');
    assert.strictEqual(summary.intent.reconciliationDebt, false);
    assert.strictEqual(summary.attempts.length, 1);
    assert.strictEqual(summary.attempts[0].state, 'CONFIRMED');
    assert.strictEqual(summary.fills.length, 1);
    assert.strictEqual(summary.fills[0].grossProceedsLamports, '41149');
    assert.strictEqual(summary.accounting.fillsCount, 1);
    assert.strictEqual(summary.accounting.isFullyClosed, true);
  });

  // 4. Replay Histórico: SSI
  await t.test('4. reconstructIncidentJournal para SSI reconstrói Intent EMERGENCY e Fill com sucesso', async () => {
    const repo = new InMemoryExitJournalRepository();
    const summary = await reconstructIncidentJournal('ssi', repo);

    assert.strictEqual(summary.incidentId, 'SSI');
    assert.strictEqual(summary.intent.initialSeverity, 'EMERGENCY');
    assert.strictEqual(summary.intent.currentSeverity, 'EMERGENCY');
    assert.strictEqual(summary.intent.status, 'APPLIED');
    assert.strictEqual(summary.attempts.length, 1);
    assert.strictEqual(summary.fills.length, 1);
  });

  // 5. Replay Histórico: Mr Beast
  await t.test('5. reconstructIncidentJournal para Mr Beast reconstrói Intent parcial', async () => {
    const repo = new InMemoryExitJournalRepository();
    const summary = await reconstructIncidentJournal('mr-beast', repo);

    assert.strictEqual(summary.incidentId, 'MR_BEAST');
    assert.strictEqual(summary.intent.status, 'APPLIED');
    assert.strictEqual(summary.attempts.length, 1);
    assert.strictEqual(summary.fills.length, 1);
  });

  // 6. Replay Histórico: SUPERPIG (Crash unconfirmed: UNKNOWN, reconciliationDebt = true, 0 fills)
  await t.test('6. reconstructIncidentJournal para SUPERPIG preserva divergência: estado UNKNOWN, zero fills e reconciliationDebt ativa', async () => {
    const repo = new InMemoryExitJournalRepository();
    const summary = await reconstructIncidentJournal('superpig', repo);

    assert.strictEqual(summary.incidentId, 'SUPERPIG');
    // Em crash não resolvido:
    assert.strictEqual(summary.intent.status, 'UNKNOWN');
    assert.strictEqual(summary.intent.reconciliationDebt, true, 'reconciliationDebt must be true for unconfirmed crash');
    assert.strictEqual(summary.attempts.length, 1);
    assert.strictEqual(summary.attempts[0].state, 'UNKNOWN');
    // Zero fills retroativos!
    assert.strictEqual(summary.fills.length, 0, 'No retroactive fill can be fabricated for SUPERPIG');
    assert.strictEqual(summary.reconciliations.length, 1);
    assert.strictEqual(summary.reconciliations[0].verdict, 'UNKNOWN');
    assert.strictEqual(summary.accounting.fillsCount, 0);
    assert.strictEqual(summary.accounting.isFullyClosed, false);
  });
});
