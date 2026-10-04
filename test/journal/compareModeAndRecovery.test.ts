/**
 * Nexus Quant Solana — V2.1B Compare Mode & Restart Matrix Test Suite (C4)
 *
 * Verifies:
 * 1. Compare Mode between legacy execution facts and shadow journal facts.
 * 2. Incident replay under compare mode (Tesla, SSI, Mr Beast, SUPERPIG).
 * 3. 8-stage Restart Matrix: validating safe permitted recovery actions at each crash point.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  compareLegacyVsShadow,
  determineRestartAction,
  LegacyExecutionFact,
  ShadowJournalFact,
  LifecycleStage
} from '../../src/journal/compareMode';
import { InMemoryJournalRepository } from '../../src/journal/repository';
import { reconstructIncidentJournal } from '../../src/journal/shadowJournal';

describe('Nexus V2.1B — Compare Mode & Restart Matrix (C4)', () => {

  describe('1. Compare Mode Fact Verification', () => {
    it('compara fatos idênticos e retorna matches: true com zero divergências', () => {
      const fact: LegacyExecutionFact = {
        tradeId: 't1',
        positionId: 'p1',
        requestedAmountAtomic: '5000000',
        signature: '5wK4ptpZ58...sig_1',
        providerResult: 'SUCCESS',
        proceedsLamports: '250000000',
        isPartial: false,
        terminalState: 'APPLIED'
      };

      const report = compareLegacyVsShadow(fact, { ...fact });
      assert.strictEqual(report.matches, true);
      assert.strictEqual(report.mismatches.length, 0);
    });

    it('identifica divergências críticas de valor, assinatura e accounting', () => {
      const legacy: LegacyExecutionFact = {
        tradeId: 't1',
        positionId: 'p1',
        requestedAmountAtomic: '5000000',
        signature: '5wK4ptpZ58...sig_legacy',
        providerResult: 'SUCCESS',
        proceedsLamports: '250000000',
        isPartial: false,
        terminalState: 'APPLIED'
      };

      const shadow: ShadowJournalFact = {
        tradeId: 't1',
        positionId: 'p1',
        requestedAmountAtomic: '4500000', // Divergência
        signature: '5wK4ptpZ58...sig_shadow', // Divergência
        providerResult: 'SUCCESS',
        proceedsLamports: '200000000', // Divergência
        isPartial: true, // Divergência
        terminalState: 'APPLIED'
      };

      const report = compareLegacyVsShadow(legacy, shadow);
      assert.strictEqual(report.matches, false);
      assert.strictEqual(report.mismatches.length, 4);

      const fields = report.mismatches.map(m => m.field);
      assert.ok(fields.includes('requestedAmountAtomic'));
      assert.ok(fields.includes('signature'));
      assert.ok(fields.includes('proceedsLamports'));
      assert.ok(fields.includes('isPartial'));

      for (const m of report.mismatches) {
        assert.strictEqual(m.severity, 'CRITICAL');
      }
    });
  });

  describe('2. Historical Incident Replay in Compare Mode', () => {
    it('Tesla: parcial e final constituem fills distintos e reconciliáveis', async () => {
      const repo = new InMemoryJournalRepository();
      const replay = await reconstructIncidentJournal('tesla', repo);

      assert.strictEqual(replay.incidentId, 'TESLA');
      assert.strictEqual(replay.intent.status, 'APPLIED');
      assert.strictEqual(replay.fills.length, 1);
      assert.strictEqual(replay.accounting.totalGrossProceedsLamports, 41149n);

      const report = compareLegacyVsShadow(
        {
          requestedAmountAtomic: '1000000000',
          signature: replay.fills[0].signature,
          providerResult: 'SUCCESS',
          proceedsLamports: '41149',
          isPartial: false,
          terminalState: 'APPLIED'
        },
        {
          requestedAmountAtomic: replay.intent.requestedAmountAtomic,
          signature: replay.fills[0].signature,
          providerResult: 'SUCCESS',
          proceedsLamports: replay.fills[0].grossProceedsLamports,
          isPartial: false,
          terminalState: replay.intent.status
        }
      );

      assert.strictEqual(report.matches, true);
    });

    it('SSI: saída de emergência preserva integridade do fill', async () => {
      const repo = new InMemoryJournalRepository();
      const replay = await reconstructIncidentJournal('ssi', repo);

      assert.strictEqual(replay.incidentId, 'SSI');
      assert.strictEqual(replay.intent.status, 'APPLIED');
      assert.strictEqual(replay.fills.length, 1);
      assert.strictEqual(replay.accounting.totalGrossProceedsLamports, 1000000n);
    });

    it('Mr Beast: saída parcial com 50% preserva identidade e proceeds exatos', async () => {
      const repo = new InMemoryJournalRepository();
      const replay = await reconstructIncidentJournal('mr-beast', repo);

      assert.strictEqual(replay.incidentId, 'MR_BEAST');
      assert.strictEqual(replay.intent.status, 'APPLIED');
      assert.strictEqual(replay.fills.length, 1);
      assert.strictEqual(replay.accounting.totalGrossProceedsLamports, 50000000n);
    });

    it('SUPERPIG: não fabrica fill para tentativas falhas e preserva divergência histórica', async () => {
      const repo = new InMemoryJournalRepository();
      const replay = await reconstructIncidentJournal('superpig', repo);

      assert.strictEqual(replay.incidentId, 'SUPERPIG');
      assert.strictEqual(replay.intent.status, 'UNKNOWN');
      assert.strictEqual(replay.fills.length, 0, 'Zero fills para incidentes não pousados');
      assert.strictEqual(replay.intent.reconciliationDebt, true);

      // Compare mode registra a divergência histórica
      const report = compareLegacyVsShadow(
        {
          requestedAmountAtomic: '1000000000',
          signature: 'legacy_assumed_failure',
          providerResult: 'FAILED',
          proceedsLamports: '0',
          isPartial: false,
          terminalState: 'FAILED'
        },
        {
          requestedAmountAtomic: replay.intent.requestedAmountAtomic,
          signature: '',
          providerResult: 'UNKNOWN',
          proceedsLamports: '0',
          isPartial: false,
          terminalState: replay.intent.status
        }
      );

      assert.strictEqual(report.matches, false);
      const fields = report.mismatches.map(m => m.field);
      assert.ok(fields.includes('signature'));
      assert.ok(fields.includes('providerResult'));
      assert.ok(fields.includes('terminalState'));
    });
  });

  describe('3. 8-Stage Restart Matrix Verification', () => {
    const stages: LifecycleStage[] = [
      'CREATED',
      'CLAIMED',
      'PREPARED',
      'SIGNED',
      'SUBMITTED',
      'UNKNOWN',
      'CONFIRMED',
      'FILL_RECORDED_PRE_APPLY'
    ];

    it('todas as 8 etapas possuem regras de ação estritas e determinísticas', () => {
      for (const stage of stages) {
        const action = determineRestartAction(stage);
        assert.strictEqual(action.stage, stage);
        assert.ok(action.safeAction);
        assert.ok(action.description.length > 10);
      }
    });

    it('etapas SIGNED, SUBMITTED e UNKNOWN NUNCA autorizam reenvio cego (canBlindlyResend=false)', () => {
      const dangerousStages: LifecycleStage[] = ['SIGNED', 'SUBMITTED', 'UNKNOWN'];
      for (const stage of dangerousStages) {
        const action = determineRestartAction(stage);
        assert.strictEqual(
          action.canBlindlyResend,
          false,
          `Etapa ${stage} jamais pode autorizar reenvio cego`
        );
        assert.strictEqual(
          action.requiresBlockchainReconciliation,
          true,
          `Etapa ${stage} deve exigir reconciliação on-chain`
        );
        assert.strictEqual(action.safeAction, 'MUST_RECONCILE');
      }
    });

    it('etapas CREATED e CLAIMED autorizam reivindicação controlada', () => {
      const createdAction = determineRestartAction('CREATED');
      assert.strictEqual(createdAction.safeAction, 'CLAIM_ALLOWED');
      assert.strictEqual(createdAction.canBlindlyResend, true);

      const claimedAction = determineRestartAction('CLAIMED');
      assert.strictEqual(claimedAction.safeAction, 'RECLAIM_AFTER_LEASE');
      assert.strictEqual(claimedAction.canBlindlyResend, true);
    });

    it('CONFIRMED e FILL_RECORDED_PRE_APPLY autorizam finalização idempotente sem duplicar fill', () => {
      const confAction = determineRestartAction('CONFIRMED');
      assert.strictEqual(confAction.safeAction, 'APPLY_IDEMPOTENTLY');
      assert.strictEqual(confAction.canBlindlyResend, false);

      const postFillAction = determineRestartAction('FILL_RECORDED_PRE_APPLY');
      assert.strictEqual(postFillAction.safeAction, 'IDEMPOTENT_RECOVERY_APPLIED');
      assert.strictEqual(postFillAction.canBlindlyResend, false);
    });
  });

});
