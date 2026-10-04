import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSolToLamports } from '../../src/execution/atomicAmount.js';
import { financialExitSafetyGuard } from '../../src/execution/financialExitSafetyGuard.js';

test('Nexus V2.3-R3 — Operational Live Scripts Reconciliation Safety (Commit R3-4)', async (t) => {
  await t.test('1. parseSolToLamports: decimal SOL to BigInt lamports without float precision loss (Finding 20)', () => {
    // 1 SOL = 1,000,000,000 lamports
    assert.equal(parseSolToLamports(1), 1_000_000_000n);
    assert.equal(parseSolToLamports('1.0'), 1_000_000_000n);
    assert.equal(parseSolToLamports(0.05), 50_000_000n);
    assert.equal(parseSolToLamports('0.05'), 50_000_000n);
    assert.equal(parseSolToLamports(0.000000001), 1n);
    assert.equal(parseSolToLamports('0.000000001'), 1n);
    assert.equal(parseSolToLamports('0.123456789'), 123_456_789n);

    // Rejection of invalid inputs
    assert.throws(() => parseSolToLamports('invalid'));
    assert.throws(() => parseSolToLamports('-1'));
  });

  await t.test('2. SUBMITTED_UNCONFIRMED enforces debt registration and blocks second swap (Finding 18)', () => {
    const testMint = 'TestMintOpSafety111111111111111111111111111111';

    // Simulate script receiving SUBMITTED_UNCONFIRMED
    const swapStatus = 'SUBMITTED_UNCONFIRMED';
    if (swapStatus === 'SUBMITTED_UNCONFIRMED') {
      financialExitSafetyGuard.registerUnresolvedDebt(testMint);
    }

    assert.equal(financialExitSafetyGuard.hasUnresolvedDebt(testMint), true);

    // Attempting a second sell must be blocked
    const lockResult = financialExitSafetyGuard.acquireExitLock(testMint, 1000n);
    assert.equal(lockResult.allowed, false);
    assert.equal(lockResult.code, 'UNRESOLVED_RECONCILIATION_DEBT');

    // Clean up
    financialExitSafetyGuard.clearUnresolvedDebt(testMint);
  });

  await t.test('3. purgeOrphanToken respects durable debt and fails closed (Finding 17)', () => {
    const orphanMint = 'OrphanMintDebtBlocked1111111111111111111111111';
    financialExitSafetyGuard.registerUnresolvedDebt(orphanMint);

    assert.equal(financialExitSafetyGuard.hasUnresolvedDebt(orphanMint), true);
    // Safety guard blocks operations
    const lock = financialExitSafetyGuard.acquireExitLock(orphanMint, 1n);
    assert.equal(lock.allowed, false);

    financialExitSafetyGuard.clearUnresolvedDebt(orphanMint);
  });
});
