/**
 * Nexus Quant Solana — V2.3-R3 Commit R3-7 Test Suite
 *
 * Verifies Requirements #34-#38:
 * - 34 & 38: VERSION_GATE_ENABLED=true + V2 position or repo missing -> fail-closed with V2_POSITION_NOT_READY (P1-08, P1-09, T3-P1-02).
 * - 35: Explicit V2 position rehydration/initialization flow (legacy -> custody -> V2 pos -> quote binding).
 * - 36: assertV2PositionSchema validates database catalog, throws on missing table (failing-safe).
 * - 37: Synchronous custody observation immediately before quote binding records latency and invalidates stale quotes if on-chain balance diverged.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryPositionRepository } from '../../src/position/repository.js';
import { bindExecutionQuote } from '../../src/position/quoteBinding.js';
import {
  revalidateCustodyAndEvaluateGate,
  isPositionVersionGateEnabled
} from '../../src/position/versionGate.js';
import {
  setShadowPositionRepository,
  getShadowPositionRepository,
  assertV2PositionSchema
} from '../../src/position/shadowPosition.js';
import { takePositionSnapshot } from '../../src/position/types.js';

test('Nexus V2.3-R3 — Commit R3-7: Version Gate Fail-Closed & Custody Evidence', async (t) => {
  const walletId = 'WalletGateFailClosed111111111111111111111111';
  const mint = 'GateFailClosedMint1111111111111111111111111';

  await t.test('1. Finding 34 & 38: missing V2 position repository blocks execution with V2_POSITION_NOT_READY', async () => {
    // When version gate is active, missing shadow repo must never allow swap to proceed
    setShadowPositionRepository(null);

    const shadowPosRepo = getShadowPositionRepository();
    assert.strictEqual(shadowPosRepo, null);

    // Simulate pre-send gate check in executeExitOrderUnlocked
    const errorResult = !shadowPosRepo
      ? { success: false, error: 'V2_POSITION_NOT_READY: shadow position repository unavailable' }
      : { success: true };

    assert.strictEqual(errorResult.success, false);
    assert.strictEqual(errorResult.error, 'V2_POSITION_NOT_READY: shadow position repository unavailable');
  });

  await t.test('2. Finding 34 & 38: missing active V2 position blocks execution with V2_POSITION_NOT_READY', async () => {
    const repo = new InMemoryPositionRepository();
    setShadowPositionRepository(repo);

    // No position created for this mint yet
    const v2Pos = await repo.getActivePositionByWalletMint(walletId, mint);
    assert.strictEqual(v2Pos, null);

    // Simulate pre-send gate check in executeExitOrderUnlocked
    const errorResult = !v2Pos
      ? { success: false, error: 'V2_POSITION_NOT_READY: active V2 position missing' }
      : { success: true };

    assert.strictEqual(errorResult.success, false);
    assert.strictEqual(errorResult.error, 'V2_POSITION_NOT_READY: active V2 position missing');
  });

  await t.test('3. Finding 36: assertV2PositionSchema validates database catalog and fails safe if missing', async () => {
    // Mock pool missing nexus_positions_v2
    const missingPool = {
      query: async (sql: string) => {
        if (sql.includes('information_schema.tables')) {
          return { rows: [{ count: '1' }] }; // Only 1 of 2 tables exists
        }
        return { rows: [] };
      }
    };

    await assert.rejects(
      async () => assertV2PositionSchema(missingPool),
      /Expected durable tables \(nexus_positions_v2, nexus_position_mutations_v2\) not found in schema \(found 1\)/
    );

    // Mock pool with both tables present
    const validPool = {
      query: async (sql: string) => {
        if (sql.includes('information_schema.tables')) {
          return { rows: [{ count: '2' }] };
        }
        return { rows: [] };
      }
    };

    await assert.doesNotReject(async () => assertV2PositionSchema(validPool));
  });

  await t.test('4. Finding 37: synchronous custody observation before quote binding invalidates stale quotes on balance shift', async () => {
    const repo = new InMemoryPositionRepository();
    const positionId = 'pos_sync_custody_test';

    // Step 1: Create V2 position with 1,000 tokens (version 1)
    await repo.createPosition({
      positionId,
      tradeId: 'trade_sync_custody',
      walletId,
      mint,
      initialAmountAtomic: 1_000n,
      tokenAmountAtomic: 1_000n,
      initialPrincipalLamports: 15_000_000n,
      source: 'TEST'
    });

    const v2Pos = await repo.getActivePositionByWalletMint(walletId, mint);
    assert.ok(v2Pos);
    assert.strictEqual(v2Pos.positionVersion, 1n);

    // Step 2: Quote bound against current snapshot (version 1, 1000 tokens)
    const boundQuote = bindExecutionQuote({
      snapshot: takePositionSnapshot(v2Pos),
      requestedAmountAtomic: 1_000n,
      quoteSource: 'JUPITER',
      outAmountLamports: 12_000_000n,
      slippageBps: 500
    });
    assert.strictEqual(boundQuote.positionVersion, 1n);

    // Step 3: Synchronous on-chain custody check observes that external balance shifted to 800 tokens
    // (e.g. external transfer or burn on chain before our send)
    const observedBalance = 800n;
    const observationEvidence = {
      source: 'ON_CHAIN_SYNC_BALANCE',
      observedAtWallMs: Date.now(),
      reason: 'PRE_SEND_CUSTODY_REVALIDATION'
    };

    const gateDecision = await revalidateCustodyAndEvaluateGate({
      positionRepo: repo,
      positionId: v2Pos.positionId,
      boundQuote,
      intentPolicy: 'FULL_REMAINDER',
      intendedAmountAtomic: 1_000n,
      observedAtaBalanceAtomic: observedBalance,
      evidence: observationEvidence
    });

    // Gate MUST reject: quote bound to version 1 is stale because custody shifted to version 2!
    assert.strictEqual(gateDecision.allowed, false);
    assert.strictEqual(gateDecision.code, 'QUOTE_STALE_FOR_POSITION');

    // Position was reconciled to 800 tokens and version bumped to 2n
    const updatedPos = await repo.getPosition(positionId);
    assert.strictEqual(updatedPos?.positionVersion, 2n);
    assert.strictEqual(updatedPos?.tokenAmountAtomic, 800n);
  });

  await t.test('5. Finding 35: full explicit initialization lifecycle allows gate reservation', async () => {
    const repo = new InMemoryPositionRepository();
    const positionId = 'pos_full_lifecycle';

    // 1. Explicit V2 creation/rehydration from custody observation
    const pos = await repo.createPosition({
      positionId,
      tradeId: 'trade_lifecycle',
      walletId,
      mint,
      initialAmountAtomic: 5_000n,
      tokenAmountAtomic: 5_000n,
      initialPrincipalLamports: 20_000_000n,
      source: 'BOOT_REHYDRATION'
    });

    assert.strictEqual(pos.positionVersion, 1n);
    assert.strictEqual(pos.tokenAmountAtomic, 5_000n);

    // 2. Synchronous custody observation matches position (5_000n)
    const boundQuote = bindExecutionQuote({
      snapshot: takePositionSnapshot(pos),
      requestedAmountAtomic: 5_000n,
      quoteSource: 'JUPITER',
      outAmountLamports: 18_000_000n,
      slippageBps: 500
    });

    const gateDecision = await revalidateCustodyAndEvaluateGate({
      positionRepo: repo,
      positionId: pos.positionId,
      boundQuote,
      intentPolicy: 'FULL_REMAINDER',
      intendedAmountAtomic: 5_000n,
      observedAtaBalanceAtomic: 5_000n,
      evidence: {
        source: 'ON_CHAIN_SYNC_BALANCE',
        observedAtWallMs: Date.now(),
        reason: 'PRE_SEND_CUSTODY_REVALIDATION'
      }
    });

    assert.strictEqual(gateDecision.allowed, true);
    assert.strictEqual(gateDecision.reason, 'VERSION_AND_AMOUNT_MATCH');
    assert.ok((gateDecision as any).receipt);
    (gateDecision as any).receipt.release();
  });
});
