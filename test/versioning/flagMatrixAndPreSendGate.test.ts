import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateFeatureFlagMatrix,
  InvalidFeatureFlagCombinationError,
  getFeatureFlagMatrix
} from '../../src/position/shadowPosition.js';
import {
  isPositionVersionGateEnabled,
  evaluatePreSendVersionGate,
  evaluateAndReservePreSendGate,
  DispatchReservationManager,
  DispatchReservationConflictError,
  revalidateCustodyAndEvaluateGate
} from '../../src/position/versionGate.js';
import { bindExecutionQuote } from '../../src/position/quoteBinding.js';
import { PositionSnapshot, takePositionSnapshot } from '../../src/position/types.js';
import { InMemoryPositionRepository } from '../../src/position/repository.js';

describe('Feature Flag Matrix Validation (P2-01)', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.NEXUS_V2_JOURNAL_SHADOW_ENABLED;
    delete process.env.NEXUS_V2_POSITION_SHADOW_ENABLED;
    delete process.env.NEXUS_V2_POSITION_VERSION_GATE_ENABLED;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test('combination 000: legacy puro is valid', () => {
    process.env.NEXUS_V2_JOURNAL_SHADOW_ENABLED = 'false';
    process.env.NEXUS_V2_POSITION_SHADOW_ENABLED = 'false';
    process.env.NEXUS_V2_POSITION_VERSION_GATE_ENABLED = 'false';

    const matrix = validateFeatureFlagMatrix();
    assert.strictEqual(matrix.code, '000');
    assert.strictEqual(matrix.journalShadow, false);
    assert.strictEqual(matrix.positionShadow, false);
    assert.strictEqual(matrix.positionVersionGate, false);
    assert.strictEqual(isPositionVersionGateEnabled(), false);
  });

  test('combination 001: gate without journal & position fails closed', () => {
    process.env.NEXUS_V2_JOURNAL_SHADOW_ENABLED = 'false';
    process.env.NEXUS_V2_POSITION_SHADOW_ENABLED = 'false';
    process.env.NEXUS_V2_POSITION_VERSION_GATE_ENABLED = 'true';

    assert.throws(() => validateFeatureFlagMatrix(), (err: any) => {
      assert.strictEqual(err.name, 'InvalidFeatureFlagCombinationError');
      assert.strictEqual(err.code, '001');
      return true;
    });
    assert.throws(() => isPositionVersionGateEnabled(), InvalidFeatureFlagCombinationError);
  });

  test('combination 010: position shadow without journal fails closed', () => {
    process.env.NEXUS_V2_JOURNAL_SHADOW_ENABLED = 'false';
    process.env.NEXUS_V2_POSITION_SHADOW_ENABLED = 'true';
    process.env.NEXUS_V2_POSITION_VERSION_GATE_ENABLED = 'false';

    assert.throws(() => validateFeatureFlagMatrix(), (err: any) => {
      assert.strictEqual(err.name, 'InvalidFeatureFlagCombinationError');
      assert.strictEqual(err.code, '010');
      return true;
    });
  });

  test('combination 011: position shadow + gate without journal fails closed', () => {
    process.env.NEXUS_V2_JOURNAL_SHADOW_ENABLED = 'false';
    process.env.NEXUS_V2_POSITION_SHADOW_ENABLED = 'true';
    process.env.NEXUS_V2_POSITION_VERSION_GATE_ENABLED = 'true';

    assert.throws(() => validateFeatureFlagMatrix(), (err: any) => {
      assert.strictEqual(err.name, 'InvalidFeatureFlagCombinationError');
      assert.strictEqual(err.code, '011');
      return true;
    });
    assert.throws(() => isPositionVersionGateEnabled(), InvalidFeatureFlagCombinationError);
  });

  test('combination 100: journal shadow only is valid', () => {
    process.env.NEXUS_V2_JOURNAL_SHADOW_ENABLED = 'true';
    process.env.NEXUS_V2_POSITION_SHADOW_ENABLED = 'false';
    process.env.NEXUS_V2_POSITION_VERSION_GATE_ENABLED = 'false';

    const matrix = validateFeatureFlagMatrix();
    assert.strictEqual(matrix.code, '100');
    assert.strictEqual(matrix.journalShadow, true);
    assert.strictEqual(matrix.positionShadow, false);
    assert.strictEqual(matrix.positionVersionGate, false);
    assert.strictEqual(isPositionVersionGateEnabled(), false);
  });

  test('combination 101: gate without position shadow fails closed', () => {
    process.env.NEXUS_V2_JOURNAL_SHADOW_ENABLED = 'true';
    process.env.NEXUS_V2_POSITION_SHADOW_ENABLED = 'false';
    process.env.NEXUS_V2_POSITION_VERSION_GATE_ENABLED = 'true';

    assert.throws(() => validateFeatureFlagMatrix(), (err: any) => {
      assert.strictEqual(err.name, 'InvalidFeatureFlagCombinationError');
      assert.strictEqual(err.code, '101');
      return true;
    });
    assert.throws(() => isPositionVersionGateEnabled(), InvalidFeatureFlagCombinationError);
  });

  test('combination 110: journal + position shadow is valid', () => {
    process.env.NEXUS_V2_JOURNAL_SHADOW_ENABLED = 'true';
    process.env.NEXUS_V2_POSITION_SHADOW_ENABLED = 'true';
    process.env.NEXUS_V2_POSITION_VERSION_GATE_ENABLED = 'false';

    const matrix = validateFeatureFlagMatrix();
    assert.strictEqual(matrix.code, '110');
    assert.strictEqual(matrix.journalShadow, true);
    assert.strictEqual(matrix.positionShadow, true);
    assert.strictEqual(matrix.positionVersionGate, false);
    assert.strictEqual(isPositionVersionGateEnabled(), false);
  });

  test('combination 111: local test with version gate active is valid', () => {
    process.env.NEXUS_V2_JOURNAL_SHADOW_ENABLED = 'true';
    process.env.NEXUS_V2_POSITION_SHADOW_ENABLED = 'true';
    process.env.NEXUS_V2_POSITION_VERSION_GATE_ENABLED = 'true';

    const matrix = validateFeatureFlagMatrix();
    assert.strictEqual(matrix.code, '111');
    assert.strictEqual(matrix.journalShadow, true);
    assert.strictEqual(matrix.positionShadow, true);
    assert.strictEqual(matrix.positionVersionGate, true);
    assert.strictEqual(isPositionVersionGateEnabled(), true);
  });
});

describe('Pre-Send Version Gate & TOCTOU Dispatch Reservation (P0-01)', () => {
  const baseSnapshot: PositionSnapshot = {
    positionId: 'pos-test-versioning',
    tradeId: 'trade-test-versioning',
    walletId: 'Wallet1111111111111111111111111111111111',
    mint: 'Mint11111111111111111111111111111111111111',
    tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    status: 'OPEN',
    positionVersion: 1n,
    tokenAmountAtomic: 1_000_000n,
    initialAmountAtomic: 1_000_000n,
    initialPrincipalLamports: 100_000_000n,
    confirmedProceedsLamports: 0n,
    reconciliationRequired: false,
    capturedAtWallMs: Date.now(),
    capturedAtMonoNs: process.hrtime.bigint()
  };

  test('acquires exclusive dispatch reservation and blocks concurrent dispatches (TOCTOU prevention)', () => {
    const mgr = new DispatchReservationManager(5_000);
    const quote = bindExecutionQuote({
      snapshot: baseSnapshot,
      requestedAmountAtomic: 1_000_000n,
      quoteSource: 'JUPITER',
      outAmountLamports: 10_000_000n,
      slippageBps: 50
    });

    // 1. First evaluation and reservation succeeds
    const res1 = evaluateAndReservePreSendGate({
      currentPosition: baseSnapshot,
      boundQuote: quote,
      intentPolicy: 'FULL_REMAINDER',
      reservationManager: mgr,
      intentId: 'intent-alpha'
    });

    assert.strictEqual(res1.allowed, true);
    if (!res1.allowed) return;
    assert.strictEqual(res1.receipt.positionId, 'pos-test-versioning');
    assert.strictEqual(res1.receipt.expectedVersion, 1n);

    // 2. Second concurrent evaluation for the same position fails with DISPATCH_RESERVATION_CONFLICT
    const res2 = evaluateAndReservePreSendGate({
      currentPosition: baseSnapshot,
      boundQuote: quote,
      intentPolicy: 'FULL_REMAINDER',
      reservationManager: mgr,
      intentId: 'intent-beta'
    });

    assert.strictEqual(res2.allowed, false);
    if (res2.allowed) return;
    assert.strictEqual(res2.code, 'DISPATCH_RESERVATION_CONFLICT');

    // 3. Releasing first reservation allows subsequent reservation
    res1.receipt.release();

    const res3 = evaluateAndReservePreSendGate({
      currentPosition: baseSnapshot,
      boundQuote: quote,
      intentPolicy: 'FULL_REMAINDER',
      reservationManager: mgr,
      intentId: 'intent-gamma'
    });

    assert.strictEqual(res3.allowed, true);
  });

  test('rejects stale quote when position version has advanced', () => {
    const mgr = new DispatchReservationManager();
    const oldQuote = bindExecutionQuote({
      snapshot: baseSnapshot,
      requestedAmountAtomic: 1_000_000n,
      quoteSource: 'JUPITER',
      outAmountLamports: 10_000_000n,
      slippageBps: 50
    });

    const advancedSnapshot: PositionSnapshot = {
      ...baseSnapshot,
      positionVersion: 2n
    };

    const res = evaluateAndReservePreSendGate({
      currentPosition: advancedSnapshot,
      boundQuote: oldQuote,
      intentPolicy: 'FULL_REMAINDER',
      reservationManager: mgr
    });

    assert.strictEqual(res.allowed, false);
    if (res.allowed) return;
    assert.strictEqual(res.code, 'QUOTE_STALE_FOR_POSITION');
    // Ensure no reservation was acquired
    assert.strictEqual(mgr.getActiveReservation(baseSnapshot.positionId), null);
  });

  test('rejects when position has pending reconciliation debt', () => {
    const mgr = new DispatchReservationManager();
    const quote = bindExecutionQuote({
      snapshot: baseSnapshot,
      requestedAmountAtomic: 1_000_000n,
      quoteSource: 'JUPITER',
      outAmountLamports: 10_000_000n,
      slippageBps: 50
    });

    const debtSnapshot: PositionSnapshot = {
      ...baseSnapshot,
      reconciliationRequired: true
    };

    const res = evaluateAndReservePreSendGate({
      currentPosition: debtSnapshot,
      boundQuote: quote,
      intentPolicy: 'FULL_REMAINDER',
      reservationManager: mgr
    });

    assert.strictEqual(res.allowed, false);
    if (res.allowed) return;
    assert.strictEqual(res.code, 'POSITION_RECONCILIATION_REQUIRED');
  });

  test('reconciles custody divergence before pre-send gate and invalidates old quote (P1-09 & P0-01)', async () => {
    const repo = new InMemoryPositionRepository();
    const pos = await repo.createPosition({
      positionId: 'pos-custody-shift',
      tradeId: 'trade-custody-shift',
      walletId: 'Wallet1111111111111111111111111111111111',
      mint: 'MintCustodyShift11111111111111111111111111',
      initialAmountAtomic: 1_000_000n,
      initialPrincipalLamports: 100_000_000n,
      source: 'TEST'
    });

    assert.strictEqual(pos.positionVersion, 1n);

    // Quote bound to version 1
    const boundQuote = bindExecutionQuote({
      snapshot: takePositionSnapshot(pos),
      requestedAmountAtomic: 1_000_000n,
      quoteSource: 'JUPITER',
      outAmountLamports: 50_000_000n,
      slippageBps: 50
    });

    // 1. External transfer/burn occurred: observed on-chain balance is only 800,000 (divergence)
    const gateDecision = await revalidateCustodyAndEvaluateGate({
      positionRepo: repo,
      positionId: pos.positionId,
      boundQuote,
      intentPolicy: 'FULL_REMAINDER',
      observedAtaBalanceAtomic: 800_000n,
      evidence: {
        source: 'ON_CHAIN_RPC_OBSERVATION',
        observationRef: 'sig_external_burn_detected',
        observedDeltaAtomic: -200_000n,
        reconciledAtWallMs: Date.now(),
        actor: 'RECONCILIATION_WORKER',
        reason: 'Detected 200,000 tokens transferred or burned externally'
      }
    });

    // 2. The gate must block the execution because version was bumped from 1 to 2
    assert.strictEqual(gateDecision.allowed, false);
    if (gateDecision.allowed) return;
    assert.strictEqual(gateDecision.code, 'QUOTE_STALE_FOR_POSITION');

    // 3. Confirm durable position is now version 2 with updated balance
    const updatedPos = await repo.getPosition(pos.positionId);
    assert.strictEqual(updatedPos?.positionVersion, 2n);
    assert.strictEqual(updatedPos?.tokenAmountAtomic, 800_000n);
  });
});
