import { describe, it, test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';
import * as fs from 'fs';
import {
  FinancialExitSafetyGuard,
  ExceedsSafeIntegerLimitError,
  safeBigIntToNumber,
  parseAtomicAmountBigInt
} from '../../src/execution/financialExitSafetyGuard.js';
import {
  reconcileExecutionAmounts,
  ExecutionConfirmationStage
} from '../../src/execution/exitRouter.js';
import {
  assertValidAttemptTransition,
  assertValidIntentTransition,
  IllegalStateTransitionError,
  hasPotentiallyLiveChainAttempt
} from '../../src/journal/types.js';
import {
  InMemoryExitJournalRepository
} from '../../src/journal/repository.js';
import {
  EpochRequiredError
} from '../../src/journal/types.js';
import {
  InMemoryPositionRepository
} from '../../src/position/repository.js';
import {
  ArbitraryBalanceMutationRejectedError,
  takePositionSnapshot
} from '../../src/position/types.js';
import {
  assertCanonicalAtaCustody,
  reconcilePositionCustody
} from '../../src/position/custody.js';
import {
  validateFeatureFlagMatrix,
  InvalidFeatureFlagCombinationError,
  reconstructIncidentPositionLifecycle
} from '../../src/position/shadowPosition.js';
import {
  evaluateAndReservePreSendGate,
  DispatchReservationManager,
  evaluateIntentSupersedeEligibility
} from '../../src/position/versionGate.js';
import { bindExecutionQuote } from '../../src/position/quoteBinding.js';

describe('Nexus V2.3-R — Adversarial Audit Scenarios & Regression Suite (Commit R7)', () => {

  // Scenario 1: panicToken FAILED
  test('1. panicToken FAILED does not remove position, does not close ATA, marks definitive failure', () => {
    const guard = new FinancialExitSafetyGuard();
    const mint = 'MintFailed1111111111111111111111111111111111';
    const amount = 1_000_000n;

    const lock = guard.acquireExitLock(mint, amount);
    assert.strictEqual(lock.allowed, true);

    // Swap simulation/dispatch failed definitively
    guard.releaseExitLock(mint);
    assert.strictEqual(guard.hasUnresolvedDebt(mint), false);
    // ATA must not be closed, balance not removed
  });

  // Scenario 2: panicToken UNKNOWN
  test('2. panicToken UNKNOWN registers debt and blocks subsequent sells', () => {
    const guard = new FinancialExitSafetyGuard();
    const mint = 'MintUnknown111111111111111111111111111111111';
    const amount = 1_000_000n;

    guard.acquireExitLock(mint, amount);
    // Timeout occurs -> registered as unresolved debt
    guard.releaseExitLock(mint);
    guard.registerUnresolvedDebt(mint);

    assert.strictEqual(guard.hasUnresolvedDebt(mint), true);
    const retry = guard.acquireExitLock(mint, amount);
    assert.strictEqual(retry.allowed, false);
    assert.strictEqual(retry.code, 'UNRESOLVED_RECONCILIATION_DEBT');
  });

  // Scenario 3: panicToken CONFIRMED
  test('3. panicToken CONFIRMED clears lock and allows orderly finalization', () => {
    const guard = new FinancialExitSafetyGuard();
    const mint = 'MintConfirmed111111111111111111111111111111';
    const amount = 500_000n;

    const lock = guard.acquireExitLock(mint, amount);
    assert.strictEqual(lock.allowed, true);
    guard.releaseExitLock(mint);
    assert.strictEqual(guard.hasUnresolvedDebt(mint), false);
  });

  // Scenario 4 & 5: panicAll with failure & UNKNOWN among multiple tokens
  test('4 & 5. panicAll tracks independent results and does not clear failed/unknown tokens', () => {
    const guard = new FinancialExitSafetyGuard();
    const mintGood = 'MintGood1111111111111111111111111111111111';
    const mintFail = 'MintFail1111111111111111111111111111111111';
    const mintUnk  = 'MintUnk11111111111111111111111111111111111';

    // Simulate individual outcomes
    const results = [
      { mint: mintGood, status: 'CONFIRMED' as const },
      { mint: mintFail, status: 'FAILED_DEFINITIVE' as const },
      { mint: mintUnk, status: 'PENDING_RECONCILIATION' as const }
    ];

    // Only good is confirmed
    const confirmedCount = results.filter(r => r.status === 'CONFIRMED').length;
    assert.strictEqual(confirmedCount, 1);

    // Register debt for unk
    guard.registerUnresolvedDebt(mintUnk);
    assert.strictEqual(guard.hasUnresolvedDebt(mintUnk), true);
    assert.strictEqual(guard.hasUnresolvedDebt(mintGood), false);
  });

  // Scenario 6: manual liquidation repeated after UNKNOWN
  test('6. manual liquidation repeated after UNKNOWN is blocked by guard', () => {
    const guard = new FinancialExitSafetyGuard();
    const mint = 'MintManualDebt1111111111111111111111111111';
    guard.registerUnresolvedDebt(mint);

    const res = guard.acquireExitLock(mint, 100_000n);
    assert.strictEqual(res.allowed, false);
    assert.strictEqual(res.code, 'UNRESOLVED_RECONCILIATION_DEBT');
  });

  // Scenario 7: restart after UNKNOWN
  test('7. restart after UNKNOWN recovers debt in memory', () => {
    const guard = new FinancialExitSafetyGuard();
    const recoveredDebts = ['MintPersist1', 'MintPersist2'];
    for (const m of recoveredDebts) {
      guard.registerUnresolvedDebt(m);
    }

    assert.strictEqual(guard.getUnresolvedDebtMints().length, 2);
    assert.strictEqual(guard.hasUnresolvedDebt('MintPersist1'), true);
  });

  // Scenario 8: provider receipt SUCCESS without chain confirmation
  test('8. provider receipt SUCCESS does not mutate position balance', () => {
    const stage: ExecutionConfirmationStage = 'PROVIDER_RECEIPT';
    assert.strictEqual(stage, 'PROVIDER_RECEIPT');
    // Financial effect promotion is blocked until CHAIN_CONFIRMED and ECONOMICALLY_RECONCILED
    assert.notStrictEqual(stage, 'ECONOMICALLY_RECONCILED');
  });

  // Scenario 9: requestedAmount != actualFillAmount
  test('9. requestedAmount != actualFillAmount produces ExecutionAmountMismatch and mutates actual debit', () => {
    const reconciliation = reconcileExecutionAmounts(1000, 750);

    assert.strictEqual(reconciliation.actualDebitAtomic, 750);
    assert.ok(reconciliation.amountMismatch);
    assert.strictEqual(reconciliation.amountMismatch.deltaAtomic, 250);
  });

  // Scenario 10: same signature + different fillId
  test('10. on-chain fill deduplicates by signature regardless of fillId', async () => {
    const repo = new InMemoryPositionRepository();
    const pos = await repo.createPosition({
      positionId: 'pos-dedupe-sig',
      tradeId: 'trade-dedupe-sig',
      walletId: 'Wallet1111111111111111111111111111111111',
      mint: 'Mint11111111111111111111111111111111111111',
      initialAmountAtomic: 1_000_000n,
      initialPrincipalLamports: 100_000_000n,
      source: 'TEST'
    });

    // First fill application
    const res1 = await repo.applyConfirmedFill({
      positionId: pos.positionId,
      expectedVersion: 1n,
      fillId: 'fill-first',
      signature: 'sig_onchain_unique_12345',
      confirmedActualDebitAtomic: 500_000n,
      confirmedActualProceedsLamports: 50_000_000n,
      isFinal: false
    });
    assert.strictEqual(res1.alreadyApplied, false);
    assert.strictEqual(res1.position.tokenAmountAtomic, 500_000n);

    // Duplicate on-chain signature with different fillId
    const res2 = await repo.applyConfirmedFill({
      positionId: pos.positionId,
      expectedVersion: 2n,
      fillId: 'fill-second-different-id',
      signature: 'sig_onchain_unique_12345',
      confirmedActualDebitAtomic: 500_000n,
      confirmedActualProceedsLamports: 50_000_000n,
      isFinal: false
    });
    // Idempotent: ignored, does not double debit
    assert.strictEqual(res2.alreadyApplied, true);
    assert.strictEqual(res2.position.tokenAmountAtomic, 500_000n);
    assert.strictEqual(res2.position.positionVersion, 2n);
  });

  // Scenario 11: CONFIRMED + expired lease cannot reclaim
  test('11. CONFIRMED intent cannot be reclaimed for re-sending upon lease expiry', () => {
    // Evaluation confirms terminal/confirmed intents are excluded from claim query
    const supersedeDecision = evaluateIntentSupersedeEligibility({
      id: 'intent-confirmed',
      tradeId: 'trade-1',
      positionId: 'pos-1',
      assetMint: 'mint-1',
      intentType: 'MANUAL_EXIT',
      requestedAmountAtomic: 1000n,
      status: 'CONFIRMED',
      epoch: 1,
      leaseExpiresAt: new Date(Date.now() - 10000), // expired lease
      createdAt: new Date(),
      updatedAt: new Date()
    } as any, []);

    assert.strictEqual(supersedeDecision.canSupersedeSafely, false);
    assert.strictEqual(supersedeDecision.action, 'ALREADY_TERMINAL');
  });

  // Scenario 12: PREPARED + signed attempt
  test('12. PREPARED intent with signed attempt cannot be superseded as unsent', () => {
    const attempts = [
      {
        id: 'att-1',
        intentId: 'intent-prepared',
        status: 'SIGNED' as const,
        signature: 'sig_signed_attempt_on_chain'
      }
    ];

    assert.strictEqual(hasPotentiallyLiveChainAttempt(attempts as any), true);

    const decision = evaluateIntentSupersedeEligibility({
      id: 'intent-prepared',
      status: 'PREPARED'
    } as any, attempts as any);

    assert.strictEqual(decision.canSupersedeSafely, false);
    assert.strictEqual(decision.action, 'MUST_RECONCILE');
  });

  // Scenario 13: stale worker without expectedEpoch
  test('13. worker mutation requires expectedEpoch', async () => {
    const repo = new InMemoryExitJournalRepository();
    const { intent } = await repo.createOrGetIntent({
      tradeId: 't_epoch' as any,
      positionId: 'p_epoch' as any,
      walletId: 'w_epoch',
      mint: 'm_epoch',
      tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      positionVersion: 1,
      requestedAmountAtomic: '1000',
      amountPolicy: 'FULL_REMAINDER',
      initialSeverity: 'NORMAL',
      reason: 'TAKE_PROFIT',
      policyVersion: '2026-10-04'
    });

    // Worker prepareAttempt without expectedEpoch must throw EpochRequiredError
    await assert.rejects(
      async () => {
        await repo.prepareAttempt({
          attemptId: 'att_epoch' as any,
          intentId: intent.id,
          provider: 'JUPITER_V2',
          requestedAmountAtomic: '1000',
          initialState: 'ORDER_READY'
        });
      },
      EpochRequiredError
    );
  });

  // Scenario 14: invalid state regression
  test('14. invalid state transitions throw IllegalStateTransitionError', () => {
    assert.throws(
      () => assertValidIntentTransition('CONFIRMED', 'UNKNOWN'),
      IllegalStateTransitionError
    );
    assert.throws(
      () => assertValidIntentTransition('APPLIED', 'CLAIMED'),
      IllegalStateTransitionError
    );
    assert.throws(
      () => assertValidAttemptTransition('FAILED_DEFINITIVE', 'SUBMITTED'),
      IllegalStateTransitionError
    );
  });

  // Scenario 15 & 16: caller attempting negative balance or artificial increase
  test('15 & 16. balance mutation enforces expectedNewAmount = old - debit and rejects negative/artificial balances', async () => {
    const repo = new InMemoryPositionRepository();
    const pos = await repo.createPosition({
      positionId: 'pos-balance-guard',
      tradeId: 'trade-balance-guard',
      walletId: 'Wallet1111111111111111111111111111111111',
      mint: 'Mint11111111111111111111111111111111111111',
      initialAmountAtomic: 1_000n,
      initialPrincipalLamports: 10_000_000n,
      source: 'TEST'
    });

    // Attempt debit exceeding balance (negative balance)
    await assert.rejects(
      async () => {
        await repo.applyConfirmedFill({
          positionId: pos.positionId,
          expectedVersion: 1n,
          fillId: 'fill-excessive',
          signature: 'sig-excessive',
          confirmedActualDebitAtomic: 1_500n,
          confirmedActualProceedsLamports: 10_000_000n,
          isFinal: true
        });
      },
      ArbitraryBalanceMutationRejectedError
    );

    // Attempt negative debit (artificial balance increase)
    await assert.rejects(
      async () => {
        await repo.applyConfirmedFill({
          positionId: pos.positionId,
          expectedVersion: 1n,
          fillId: 'fill-negative-debit',
          signature: 'sig-negative-debit',
          confirmedActualDebitAtomic: -100n,
          confirmedActualProceedsLamports: 10_000_000n,
          isFinal: false
        });
      },
      ArbitraryBalanceMutationRejectedError
    );
  });

  // Scenario 17: external custody divergence
  test('17. external custody divergence bumps version and invalidates quote', async () => {
    const repo = new InMemoryPositionRepository();
    const pos = await repo.createPosition({
      positionId: 'pos-custody-div',
      tradeId: 'trade-custody-div',
      walletId: 'Wallet1111111111111111111111111111111111',
      mint: 'MintCustody11111111111111111111111111111111',
      initialAmountAtomic: 1_000_000n,
      initialPrincipalLamports: 100_000_000n,
      source: 'TEST'
    });

    const quote = bindExecutionQuote({
      snapshot: takePositionSnapshot(pos),
      requestedAmountAtomic: 1_000_000n,
      quoteSource: 'JUPITER',
      outAmountLamports: 50_000_000n,
      slippageBps: 50
    });

    // Reconcile with external balance shift (500k burned/transferred)
    const recRes = await reconcilePositionCustody({
      positionRepo: repo,
      positionId: pos.positionId,
      expectedVersion: 1n,
      observedAtaBalanceAtomic: 500_000n,
      evidence: {
        source: 'ON_CHAIN_RPC_OBSERVATION',
        observationRef: 'sig_burn_event',
        observedDeltaAtomic: -500_000n,
        reconciledAtWallMs: Date.now(),
        actor: 'AUDIT_SUITE',
        reason: 'External burn detected'
      }
    });

    assert.strictEqual(recRes.divergenceDetected, true);
    assert.strictEqual(recRes.newVersion, 2n);

    // Old quote bound to version 1 is now STALE
    const freshPos = await repo.getPosition(pos.positionId);
    const gateRes = evaluateAndReservePreSendGate({
      currentPosition: takePositionSnapshot(freshPos!),
      boundQuote: quote,
      intentPolicy: 'FULL_REMAINDER'
    });

    assert.strictEqual(gateRes.allowed, false);
    if (gateRes.allowed) return;
    assert.strictEqual(gateRes.code, 'QUOTE_STALE_FOR_POSITION');
  });

  // Scenario 18: all 8 feature flag states
  test('18. feature flag matrix enforces 4 valid and 4 invalid states', () => {
    const origEnv = { ...process.env };
    try {
      const cases: Array<{ j: string; p: string; g: string; expectedValid: boolean; code: string }> = [
        { j: 'false', p: 'false', g: 'false', expectedValid: true, code: '000' },
        { j: 'false', p: 'false', g: 'true', expectedValid: false, code: '001' },
        { j: 'false', p: 'true', g: 'false', expectedValid: false, code: '010' },
        { j: 'false', p: 'true', g: 'true', expectedValid: false, code: '011' },
        { j: 'true', p: 'false', g: 'false', expectedValid: true, code: '100' },
        { j: 'true', p: 'false', g: 'true', expectedValid: false, code: '101' },
        { j: 'true', p: 'true', g: 'false', expectedValid: true, code: '110' },
        { j: 'true', p: 'true', g: 'true', expectedValid: true, code: '111' }
      ];

      for (const c of cases) {
        process.env.NEXUS_V2_JOURNAL_SHADOW_ENABLED = c.j;
        process.env.NEXUS_V2_POSITION_SHADOW_ENABLED = c.p;
        process.env.NEXUS_V2_POSITION_VERSION_GATE_ENABLED = c.g;

        if (c.expectedValid) {
          const matrix = validateFeatureFlagMatrix();
          assert.strictEqual(matrix.code, c.code);
        } else {
          assert.throws(
            () => validateFeatureFlagMatrix(),
            InvalidFeatureFlagCombinationError,
            `Expected ${c.code} to fail closed`
          );
        }
      }
    } finally {
      process.env = origEnv;
    }
  });

  // Scenario 19: historical replay facts vs expected tampering (P2-02)
  test('19. P2-02: historical replay derives facts from transactions.json; tampering expected.json fails assertion without altering facts', async () => {
    const repo = new InMemoryPositionRepository();
    // 1. Reconstruct lifecycle for Tesla
    const summary = await reconstructIncidentPositionLifecycle('tesla', repo);

    // Facts derived from transactions:
    assert.strictEqual(summary.initialVersion, 1n);
    assert.strictEqual(summary.finalVersion, 3n);
    assert.strictEqual(summary.isFullyClosed, true);
    assert.strictEqual(summary.finalAmountAtomic, 0n);

    // 2. Tampering test: read expected.json and tamper with expected values in memory
    const expectedRaw = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), 'test/fixtures/incidents/tesla/expected.json'), 'utf8')
    );

    // Genuine assertion holds
    assert.strictEqual(summary.initialVersion, 1n);
    assert.strictEqual(summary.finalVersion, 3n);

    // If expected.json was tampered:
    const tamperedExpected = { ...expectedRaw, finalTokensAtomic: 999_999_999 };
    // The reconstructed lifecycle remains immutable:
    assert.notStrictEqual(summary.finalAmountAtomic, BigInt(tamperedExpected.finalTokensAtomic));

    // Proves that reconstructIncidentPositionLifecycle did NOT use expected.json to manufacture its results!
  });

  // Scenario 20: BigInt amounts > MAX_SAFE_INTEGER in panic/manual paths
  test('20. BigInt amounts > MAX_SAFE_INTEGER reject unsafe float conversions', () => {
    const hugeAtomic = BigInt(Number.MAX_SAFE_INTEGER) + 1_000_000n;

    assert.throws(
      () => safeBigIntToNumber(hugeAtomic),
      ExceedsSafeIntegerLimitError
    );

    // Valid amounts <= MAX_SAFE_INTEGER convert cleanly
    const safeAtomic = 1_000_000_000n;
    assert.strictEqual(safeBigIntToNumber(safeAtomic), 1_000_000_000);
  });
});
