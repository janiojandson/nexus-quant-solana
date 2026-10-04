/**
 * Nexus Quant Solana — Synthetic Journal Scenarios Test Suite
 *
 * Verifies unit/synthetic scenarios for Compare Mode and Journal edge cases
 * with explicit synthetic identifiers (SYNTHETIC_PARTIAL, SYNTHETIC_PANIC, SYNTHETIC_UNKNOWN).
 *
 * Distinct from historical incident replays (Tesla, SSI, Mr Beast, SUPERPIG),
 * which use audited historical on-chain fixtures.
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
import {
  createInitialPositionAccounting,
  applyFillToAccounting
} from '../../src/journal/accounting';
import { FillRecord } from '../../src/journal/types';

describe('Nexus V2.1B — Synthetic Journal Scenarios (Synthetic Contract Tests)', () => {

  describe('1. Synthetic Fact Comparison (Compare Mode)', () => {
    it('compara fatos sintéticos idênticos e retorna matches: true com zero divergências', () => {
      const fact: LegacyExecutionFact = {
        tradeId: 'synth_trade_1',
        positionId: 'synth_pos_1',
        requestedAmountAtomic: '5000000',
        signature: '5wK4ptpZ58...sig_synth_1',
        providerResult: 'SUCCESS',
        proceedsLamports: '250000000',
        isPartial: false,
        terminalState: 'APPLIED'
      };

      const report = compareLegacyVsShadow(fact, { ...fact });
      assert.strictEqual(report.matches, true);
      assert.strictEqual(report.mismatches.length, 0);
    });

    it('identifica divergências críticas de valor, assinatura e accounting em cenários sintéticos', () => {
      const legacy: LegacyExecutionFact = {
        tradeId: 'synth_trade_2',
        positionId: 'synth_pos_2',
        requestedAmountAtomic: '5000000',
        signature: '5wK4ptpZ58...sig_synth_legacy',
        providerResult: 'SUCCESS',
        proceedsLamports: '250000000',
        isPartial: false,
        terminalState: 'APPLIED'
      };

      const shadow: ShadowJournalFact = {
        tradeId: 'synth_trade_2',
        positionId: 'synth_pos_2',
        requestedAmountAtomic: '4500000', // Divergência
        signature: '5wK4ptpZ58...sig_synth_shadow', // Divergência
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

  describe('2. Synthetic Policy Scenarios (SYNTHETIC_PARTIAL, SYNTHETIC_PANIC, SYNTHETIC_UNKNOWN)', () => {
    it('SYNTHETIC_PARTIAL: simula saída parcial de 50% e reconcilia accounting sintético', async () => {
      const repo = new InMemoryJournalRepository();
      const initialAtomic = '2000000000';
      const exitAtomic = '1000000000';

      const initialAcc = createInitialPositionAccounting({
        tradeId: 'SYNTHETIC_PARTIAL' as any,
        positionId: 'pos_synth_partial' as any,
        mint: 'mint_synth_partial',
        initialTokensAtomic: initialAtomic,
        initialPrincipalLamports: '100000000'
      });

      const syntheticFill: FillRecord = {
        id: 'fill_synth_partial' as any,
        tradeId: 'SYNTHETIC_PARTIAL' as any,
        positionId: 'pos_synth_partial' as any,
        intentId: 'intent_synth_partial' as any,
        attemptId: 'att_synth_partial' as any,
        signature: 'sig_synth_partial_111',
        realizationSequence: 1,
        chainLegIndex: 0,
        instructionIndex: 3,
        innerInstructionIndex: 0,
        assetMint: 'mint_synth_partial',
        requestedAmountAtomic: exitAtomic,
        actualAmountAtomic: exitAtomic,
        grossProceedsLamports: '50000000',
        networkFeeLamports: '5000',
        priorityFeeLamports: '50000',
        tipLamports: '0',
        rentMovementLamports: '0',
        confirmedAtWallMs: 1_700_000_000_000 as any,
        evidenceType: 'SYNTHETIC_BENCHMARK',
        createdAtWallMs: 1_700_000_000_000 as any
      };

      const updatedAcc = applyFillToAccounting(initialAcc, syntheticFill);
      assert.strictEqual(updatedAcc.totalGrossProceedsLamports, 50000000n);
      assert.strictEqual(updatedAcc.remainingTokensAtomic, 1000000000n);
    });

    it('SYNTHETIC_PANIC: simula encerramento emergencial sintético de 100%', async () => {
      const initialAtomic = '1000000000';
      const initialAcc = createInitialPositionAccounting({
        tradeId: 'SYNTHETIC_PANIC' as any,
        positionId: 'pos_synth_panic' as any,
        mint: 'mint_synth_panic',
        initialTokensAtomic: initialAtomic,
        initialPrincipalLamports: '50000000'
      });

      const syntheticFill: FillRecord = {
        id: 'fill_synth_panic' as any,
        tradeId: 'SYNTHETIC_PANIC' as any,
        positionId: 'pos_synth_panic' as any,
        intentId: 'intent_synth_panic' as any,
        attemptId: 'att_synth_panic' as any,
        signature: 'sig_synth_panic_222',
        realizationSequence: 1,
        chainLegIndex: 0,
        instructionIndex: 3,
        innerInstructionIndex: 0,
        assetMint: 'mint_synth_panic',
        requestedAmountAtomic: initialAtomic,
        actualAmountAtomic: initialAtomic,
        grossProceedsLamports: '1000000',
        networkFeeLamports: '5000',
        priorityFeeLamports: '50000',
        tipLamports: '0',
        rentMovementLamports: '0',
        confirmedAtWallMs: 1_700_000_000_000 as any,
        evidenceType: 'SYNTHETIC_BENCHMARK',
        createdAtWallMs: 1_700_000_000_000 as any
      };

      const updatedAcc = applyFillToAccounting(initialAcc, syntheticFill);
      assert.strictEqual(updatedAcc.totalGrossProceedsLamports, 1000000n);
      assert.strictEqual(updatedAcc.remainingTokensAtomic, 0n);
    });

    it('SYNTHETIC_UNKNOWN: simula transporte incerto com zero fills e dívida de reconciliação', () => {
      const report = compareLegacyVsShadow(
        {
          requestedAmountAtomic: '1000000000',
          signature: 'synth_assumed_failure',
          providerResult: 'FAILED',
          proceedsLamports: '0',
          isPartial: false,
          terminalState: 'FAILED'
        },
        {
          requestedAmountAtomic: '1000000000',
          signature: '',
          providerResult: 'UNKNOWN',
          proceedsLamports: '0',
          isPartial: false,
          terminalState: 'UNKNOWN'
        }
      );

      assert.strictEqual(report.matches, false);
      const fields = report.mismatches.map(m => m.field);
      assert.ok(fields.includes('signature'));
      assert.ok(fields.includes('providerResult'));
      assert.ok(fields.includes('terminalState'));
    });
  });

  describe('3. Restart Recovery Action Classifications (Synthetic Rules)', () => {
    it('etapas de risco (SIGNED, SUBMITTED, UNKNOWN) exigem reconciliação e não autorizam nova tentativa cega', () => {
      for (const st of ['SIGNED', 'SUBMITTED', 'UNKNOWN'] as LifecycleStage[]) {
        const action = determineRestartAction(st);
        assert.strictEqual(action.safeAction, 'MUST_RECONCILE');
        assert.strictEqual(action.safeToCreateNewAttempt, false);
        assert.strictEqual(action.canBlindlyResend, false);
        assert.strictEqual(action.requiresBlockchainReconciliation, true);
      }
    });

    it('etapas iniciais (CREATED, CLAIMED, PREPARED) autorizam nova tentativa segura quando comprovado não-transmitido', () => {
      const created = determineRestartAction('CREATED');
      assert.strictEqual(created.safeAction, 'CLAIM_ALLOWED');
      assert.strictEqual(created.safeToCreateNewAttempt, true);

      const claimed = determineRestartAction('CLAIMED');
      assert.strictEqual(claimed.safeAction, 'RECLAIM_AFTER_LEASE');
      assert.strictEqual(claimed.safeToCreateNewAttempt, true);

      const prepared = determineRestartAction('PREPARED');
      assert.strictEqual(prepared.safeAction, 'RECONCILE_OR_RETRY_UNSENT');
      assert.strictEqual(prepared.safeToCreateNewAttempt, true);
    });

    it('etapas de confirmação (CONFIRMED, FILL_RECORDED_PRE_APPLY) autorizam aplicação idempotente', () => {
      const conf = determineRestartAction('CONFIRMED');
      assert.strictEqual(conf.safeAction, 'APPLY_IDEMPOTENTLY');
      assert.strictEqual(conf.safeToCreateNewAttempt, false);

      const fillRecorded = determineRestartAction('FILL_RECORDED_PRE_APPLY');
      assert.strictEqual(fillRecorded.safeAction, 'COMPLETE_IDEMPOTENTLY');
      assert.strictEqual(fillRecorded.safeToCreateNewAttempt, false);
    });
  });

});
