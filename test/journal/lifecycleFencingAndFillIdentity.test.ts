/**
 * Nexus Quant Solana — Missão V2.3-R
 * Adversarial Regression Suite: Lifecycle Fencing & Fill Identity (Commit R3)
 *
 * Covers:
 * - P1-02: Intent with SIGNED/SUBMITTED/UNKNOWN/SENT attempt cannot be superseded
 * - P1-03: CONFIRMED intent cannot be reclaimed even if lease expires
 * - P1-04: Worker mutations without expectedEpoch throw EpochRequiredError
 * - P1-05: Deduplication by on-chain transaction signature in applyFill
 * - Illegal state transitions throw IllegalStateTransitionError
 * - Stale epoch mutations throw StaleEpochError
 */

import test from 'node:test';
import assert from 'node:assert';
import { InMemoryExitJournalRepository } from '../../src/journal/repository';
import { InMemoryPositionRepository } from '../../src/position/repository';
import {
  EpochRequiredError,
  StaleEpochError,
  IllegalStateTransitionError,
  ExitIntent,
  ExecutionAttempt
} from '../../src/journal/types';
import { evaluateIntentSupersedeEligibility } from '../../src/position/versionGate';

test('Nexus V2.3-R — Lifecycle Fencing & On-chain Fill Identity (R3)', async (t) => {
  const baseTime = 1_700_000_000_000;

  // 1. P1-04: Mandatory expectedEpoch for worker mutations
  await t.test('P1-04: Worker calling mutations without expectedEpoch throws EpochRequiredError', async () => {
    const journalRepo = new InMemoryExitJournalRepository();
    const { intent } = await journalRepo.createOrGetIntent({
      tradeId: 't_fence_1' as any,
      positionId: 'p_fence_1' as any,
      walletId: 'w_fence_1',
      mint: 'm_fence_1',
      tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      positionVersion: 1,
      requestedAmountAtomic: '1000',
      amountPolicy: 'FULL_REMAINDER',
      initialSeverity: 'NORMAL',
      reason: 'TAKE_PROFIT',
      policyVersion: '2026-10-04',
      nowMs: baseTime
    });

    const claimed = await journalRepo.claimIntent({
      workerId: 'worker_1',
      leaseDurationMs: 5000,
      nowMs: baseTime
    });
    assert.ok(claimed);

    // prepareAttempt without expectedEpoch must throw EpochRequiredError
    await assert.rejects(
      () => journalRepo.prepareAttempt({
        attemptId: 'att_fence_1' as any,
        intentId: intent.id,
        provider: 'JUPITER_V2',
        requestedAmountAtomic: '1000',
        initialState: 'ORDER_READY',
        nowMs: baseTime
      }),
      EpochRequiredError
    );

    // Now call with valid epoch
    const attempt = await journalRepo.prepareAttempt({
      attemptId: 'att_fence_1' as any,
      intentId: intent.id,
      provider: 'JUPITER_V2',
      requestedAmountAtomic: '1000',
      initialState: 'ORDER_READY',
      nowMs: baseTime
    }, claimed.claimEpoch);
    assert.strictEqual(attempt.attemptId, 'att_fence_1');

    // updateAttemptState without expectedEpoch must throw EpochRequiredError
    await assert.rejects(
      () => journalRepo.updateAttemptState(attempt.attemptId, 'SIGNED', { signature: 'sig_test_123' as any }),
      EpochRequiredError
    );

    // recordFill without expectedEpoch must throw EpochRequiredError
    await assert.rejects(
      () => journalRepo.recordFill({
        id: 'fill_no_epoch' as any,
        tradeId: intent.tradeId,
        positionId: intent.positionId,
        intentId: intent.id,
        attemptId: attempt.attemptId,
        signature: 'sig_fill_test' as any,
        realizationSequence: 1,
        chainLegIndex: 0,
        instructionIndex: 3,
        innerInstructionIndex: -1,
        requestedAmountAtomic: '1000',
        actualAmountAtomic: '1000',
        grossProceedsLamports: '1000',
        networkFeeLamports: '5000',
        priorityFeeLamports: '0',
        tipLamports: '0',
        rentMovementLamports: '0',
        evidenceType: 'CHAIN_PARSED_TRANSACTION',
        confirmedAtWallMs: baseTime as any,
        createdAtWallMs: baseTime as any
      }),
      EpochRequiredError
    );
  });

  // 2. Fencing: Stale epoch throws StaleEpochError
  await t.test('Fencing: Stale epoch throws StaleEpochError and protects against zombie workers', async () => {
    const journalRepo = new InMemoryExitJournalRepository();
    const { intent } = await journalRepo.createOrGetIntent({
      tradeId: 't_fence_2' as any,
      positionId: 'p_fence_2' as any,
      walletId: 'w_fence_2',
      mint: 'm_fence_2',
      tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      positionVersion: 1,
      requestedAmountAtomic: '1000',
      amountPolicy: 'FULL_REMAINDER',
      initialSeverity: 'NORMAL',
      reason: 'TAKE_PROFIT',
      policyVersion: '2026-10-04',
      nowMs: baseTime
    });

    const claimed1 = await journalRepo.claimIntent({
      workerId: 'worker_1',
      leaseDurationMs: 1000,
      nowMs: baseTime
    });
    assert.strictEqual(claimed1?.claimEpoch, 1n);

    const attempt = await journalRepo.prepareAttempt({
      attemptId: 'att_fence_2' as any,
      intentId: intent.id,
      provider: 'JUPITER_V2',
      requestedAmountAtomic: '1000',
      initialState: 'ORDER_READY',
      nowMs: baseTime
    }, claimed1!.claimEpoch);

    // Lease expires, worker 2 claims -> epoch becomes 2
    const claimed2 = await journalRepo.claimIntent({
      workerId: 'worker_2',
      leaseDurationMs: 5000,
      nowMs: baseTime + 2000
    });
    assert.strictEqual(claimed2?.claimEpoch, 2n);

    // Worker 1 wakes up and tries to update with stale epoch 1n
    await assert.rejects(
      () => journalRepo.updateAttemptState(attempt.attemptId, 'ORDER_READY', {}, 1n),
      StaleEpochError
    );

    // Worker 1 tries to record fill with stale epoch 1n
    await assert.rejects(
      () => journalRepo.recordFill({
        id: 'fill_stale' as any,
        tradeId: intent.tradeId,
        positionId: intent.positionId,
        intentId: intent.id,
        attemptId: attempt.attemptId,
        signature: 'sig_stale_123' as any,
        realizationSequence: 1,
        chainLegIndex: 0,
        instructionIndex: 3,
        innerInstructionIndex: -1,
        requestedAmountAtomic: '1000',
        actualAmountAtomic: '1000',
        grossProceedsLamports: '1000',
        networkFeeLamports: '5000',
        priorityFeeLamports: '0',
        tipLamports: '0',
        rentMovementLamports: '0',
        evidenceType: 'CHAIN_PARSED_TRANSACTION',
        confirmedAtWallMs: baseTime as any,
        createdAtWallMs: baseTime as any
      }, 1n),
      StaleEpochError
    );
  });

  // 3. P1-03: CONFIRMED intent lease expiry never re-claims
  await t.test('P1-03: CONFIRMED intent is excluded from claimIntent even after lease expiration', async () => {
    const journalRepo = new InMemoryExitJournalRepository();
    const { intent } = await journalRepo.createOrGetIntent({
      tradeId: 't_fence_3' as any,
      positionId: 'p_fence_3' as any,
      walletId: 'w_fence_3',
      mint: 'm_fence_3',
      tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      positionVersion: 1,
      requestedAmountAtomic: '1000',
      amountPolicy: 'FULL_REMAINDER',
      initialSeverity: 'NORMAL',
      reason: 'TAKE_PROFIT',
      policyVersion: '2026-10-04',
      nowMs: baseTime
    });

    const claimed = await journalRepo.claimIntent({
      workerId: 'worker_1',
      leaseDurationMs: 1000,
      nowMs: baseTime
    });

    const attempt = await journalRepo.prepareAttempt({
      attemptId: 'att_fence_3' as any,
      intentId: intent.id,
      provider: 'JUPITER_V2',
      requestedAmountAtomic: '1000',
      initialState: 'ORDER_READY',
      nowMs: baseTime
    }, claimed!.claimEpoch);

    await journalRepo.updateAttemptState(attempt.attemptId, 'SUBMITTED', {
      signature: 'sig_conf_test' as any
    }, claimed!.claimEpoch);

    await journalRepo.updateAttemptState(attempt.attemptId, 'CONFIRMED', {
      confirmedAtWallMs: (baseTime + 100) as any
    }, claimed!.claimEpoch);

    const confIntent = await journalRepo.getIntentById(intent.id);
    assert.strictEqual(confIntent?.status, 'CONFIRMED');

    // Lease expires at baseTime + 2000
    const reClaim = await journalRepo.claimIntent({
      workerId: 'worker_2',
      leaseDurationMs: 5000,
      nowMs: baseTime + 2000
    });

    // Must NOT claim the CONFIRMED intent
    assert.strictEqual(reClaim, null);
  });

  // 4. P1-02: Intent with SIGNED/SUBMITTED/UNKNOWN/SENT attempt cannot be superseded
  await t.test('P1-02: evaluateIntentSupersedeEligibility blocks supersede when live chain attempts exist', async () => {
    const baseIntent: ExitIntent = {
      id: 'intent_super_1' as any,
      tradeId: 'trade_1' as any,
      positionId: 'pos_1' as any,
      walletId: 'wallet_1',
      mint: 'mint_1',
      tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      positionVersion: 1n,
      requestedAmountAtomic: '1000',
      amountPolicy: 'FULL_REMAINDER',
      currentSeverity: 'NORMAL',
      reason: 'TAKE_PROFIT',
      status: 'PREPARED', // Intent status says PREPARED, but attempt might be SIGNED!
      economicDedupeKey: 'dedupe_key',
      policyVersion: '2026-10-04',
      claimEpoch: 1n,
      severityAuditTrail: [],
      createdAtWallMs: baseTime as any,
      createdAtMonoNs: 1000n as any
    };

    // Case A: No attempts or only ORDER_READY attempt -> can supersede with higher severity
    const eligible1 = evaluateIntentSupersedeEligibility(
      baseIntent,
      [{ state: 'ORDER_READY', attemptId: 'att_1' } as ExecutionAttempt]
    );
    assert.strictEqual(eligible1.canSupersedeSafely, true);

    // Case B: Attempt is SIGNED -> MUST NOT supersede
    const eligible2 = evaluateIntentSupersedeEligibility(
      baseIntent,
      [{ state: 'SIGNED', attemptId: 'att_signed', signature: 'sig_1' } as ExecutionAttempt]
    );
    assert.strictEqual(eligible2.canSupersedeSafely, false);
    assert.match(eligible2.reason, /potentially live on-chain attempt/);

    // Case C: Attempt is SUBMITTED -> MUST NOT supersede
    const eligible3 = evaluateIntentSupersedeEligibility(
      baseIntent,
      [{ state: 'SUBMITTED', attemptId: 'att_sub', signature: 'sig_2' } as ExecutionAttempt]
    );
    assert.strictEqual(eligible3.canSupersedeSafely, false);

    // Case D: Attempt has a signature even if state is ORDER_READY -> MUST NOT supersede
    const eligible4 = evaluateIntentSupersedeEligibility(
      baseIntent,
      [{ state: 'ORDER_READY', attemptId: 'att_sig', signature: 'sig_present' } as ExecutionAttempt]
    );
    assert.strictEqual(eligible4.canSupersedeSafely, false);
  });

  // 5. P1-05: Deduplication by signature in applyFill
  await t.test('P1-05: applyFill deduplicates by signature across different fillIds without double debit', async () => {
    const posRepo = new InMemoryPositionRepository();

    const position = await posRepo.createPosition({
      positionId: 'pos_dedupe_sig_1',
      tradeId: 'trade_dedupe_sig_1',
      walletId: 'w_dedupe_sig',
      mint: 'm_dedupe_sig',
      tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      initialAmountAtomic: 5000n,
      initialPrincipalLamports: 1000000n
    });

    assert.strictEqual(position.tokenAmountAtomic, 5000n);
    assert.strictEqual(position.positionVersion, 1n);

    // Apply first fill with signature sig_tx_alpha
    const res1 = await posRepo.applyFill({
      positionId: position.positionId,
      fillId: 'fill_first_record',
      expectedVersion: 1n,
      signature: 'sig_tx_alpha',
      fillAmountAtomic: 2000n,
      proceedsLamports: 500000n
    });

    assert.strictEqual(res1.alreadyApplied, false);
    assert.strictEqual(res1.position.tokenAmountAtomic, 3000n);
    assert.strictEqual(res1.position.positionVersion, 2n);

    // Replay with identical fillId -> returns alreadyApplied: true
    const res2 = await posRepo.applyFill({
      positionId: position.positionId,
      fillId: 'fill_first_record',
      expectedVersion: 2n,
      signature: 'sig_tx_alpha',
      fillAmountAtomic: 2000n,
      proceedsLamports: 500000n
    });

    assert.strictEqual(res2.alreadyApplied, true);
    assert.strictEqual(res2.position.tokenAmountAtomic, 3000n);
    assert.strictEqual(res2.position.positionVersion, 2n);

    // Adversarial: Re-send with DIFFERENT fillId but SAME signature -> MUST BE DEDUPLICATED
    const res3 = await posRepo.applyFill({
      positionId: position.positionId,
      fillId: 'fill_adversarial_synthetic_id',
      expectedVersion: 2n,
      signature: 'sig_tx_alpha', // Same signature!
      fillAmountAtomic: 2000n,
      proceedsLamports: 500000n
    });

    assert.strictEqual(res3.alreadyApplied, true, 'Same transaction signature must be deduplicated even with different fillId');
    assert.strictEqual(res3.position.tokenAmountAtomic, 3000n, 'Balance MUST NOT be debited twice');
    assert.strictEqual(res3.position.positionVersion, 2n, 'Position version MUST NOT be incremented on dedupe');
  });

  // 6. Illegal State Transitions throw IllegalStateTransitionError
  await t.test('State transitions: Invalid state progressions throw IllegalStateTransitionError', async () => {
    const journalRepo = new InMemoryExitJournalRepository();
    const { intent } = await journalRepo.createOrGetIntent({
      tradeId: 't_states_1' as any,
      positionId: 'p_states_1' as any,
      walletId: 'w_states_1',
      mint: 'm_states_1',
      tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      positionVersion: 1,
      requestedAmountAtomic: '1000',
      amountPolicy: 'FULL_REMAINDER',
      initialSeverity: 'NORMAL',
      reason: 'TAKE_PROFIT',
      policyVersion: '2026-10-04',
      nowMs: baseTime
    });

    const claimed = await journalRepo.claimIntent({
      workerId: 'worker_1',
      leaseDurationMs: 5000,
      nowMs: baseTime
    });

    const attempt = await journalRepo.prepareAttempt({
      attemptId: 'att_states_1' as any,
      intentId: intent.id,
      provider: 'JUPITER_V2',
      requestedAmountAtomic: '1000',
      initialState: 'ORDER_READY',
      nowMs: baseTime
    }, claimed!.claimEpoch);

    await journalRepo.updateAttemptState(attempt.attemptId, 'SUBMITTED', {
      signature: 'sig_state_123' as any
    }, claimed!.claimEpoch);

    await journalRepo.updateAttemptState(attempt.attemptId, 'CONFIRMED', {
      confirmedAtWallMs: baseTime as any
    }, claimed!.claimEpoch);

    // Attempting to regress CONFIRMED attempt to ORDER_READY or SUBMITTED must throw IllegalStateTransitionError
    await assert.rejects(
      () => journalRepo.updateAttemptState(attempt.attemptId, 'ORDER_READY', {}, claimed!.claimEpoch),
      IllegalStateTransitionError
    );
  });
});
