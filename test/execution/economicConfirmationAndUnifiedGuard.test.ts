import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  FinancialExitSafetyGuard,
  CustodyLockIdentity
} from '../../src/execution/financialExitSafetyGuard.js';
import {
  shadowOnExitDecision,
  shadowOnJupiterOrder,
  shadowOnLocalSign,
  shadowOnSubmit,
  shadowOnProviderReceipt,
  shadowOnFillConfirmed,
  setShadowRepository,
  getActiveShadowContext
} from '../../src/journal/shadowHooks.js';

import { InMemoryJournalRepository } from '../../src/journal/repository.js';

import { ExecutionAttemptState } from '../../src/journal/types.js';

describe('Economic Confirmation and Unified In-Process Exclusion (Fases 4 & 6, P0-05, P0-06, R-P1-02)', () => {
  describe('FASE 6: Unified In-Process Exclusion (P0-05)', () => {
    let guard: FinancialExitSafetyGuard;

    beforeEach(() => {
      guard = new FinancialExitSafetyGuard();
    });

    it('blocks concurrent sells on the same mint across different caller types', () => {
      const mint = 'MintCollision1111111111111111111111111111111';

      // 1. Normal/monitor exit acquires lock
      const normalLock = guard.acquireExitLock(mint, 1000n);
      assert.equal(normalLock.allowed, true);

      // 2. Concurrent panic exit on the same mint MUST be blocked
      const panicLock = guard.acquireExitLock(mint, 1000n);
      assert.equal(panicLock.allowed, false);
      assert.equal(panicLock.code, 'IN_FLIGHT_COLLISION');

      // 3. Concurrent holding liquidation on the same mint MUST be blocked
      const holdingLock = guard.validateExit(mint, 1000n);
      assert.equal(holdingLock.allowed, false);
      assert.equal(holdingLock.code, 'IN_FLIGHT_COLLISION');

      // 4. Release normal lock enables subsequent exit
      guard.releaseExitLock(mint);
      const afterRelease = guard.acquireExitLock(mint, 1000n);
      assert.equal(afterRelease.allowed, true);
      guard.releaseExitLock(mint);
    });

    it('enforces custody-aware exclusion with wallet + mint + tokenAccount', () => {
      const custodyA: CustodyLockIdentity = {
        wallet: 'WalletAlpha11111111111111111111111111111111',
        mint: 'MintCustody11111111111111111111111111111111',
        tokenAccount: 'AtaAlpha111111111111111111111111111111111111'
      };

      const lockA = guard.acquireExitLock(custodyA, 500n);
      assert.equal(lockA.allowed, true);

      // Calling with just the mint must collide
      const lockByMint = guard.acquireExitLock(custodyA.mint, 500n);
      assert.equal(lockByMint.allowed, false);
      assert.equal(lockByMint.code, 'IN_FLIGHT_COLLISION');

      // Calling with same custody identity must collide
      const lockSameCustody = guard.acquireExitLock(custodyA, 500n);
      assert.equal(lockSameCustody.allowed, false);
      assert.equal(lockSameCustody.code, 'IN_FLIGHT_COLLISION');

      guard.releaseExitLock(custodyA);

      // After release, mint is available
      const afterRelease = guard.acquireExitLock(custodyA.mint, 500n);
      assert.equal(afterRelease.allowed, true);
      guard.releaseExitLock(custodyA.mint);
    });

    it('blocks exit when mint has unresolved reconciliation debt', () => {
      const mint = 'MintWithDebt111111111111111111111111111111111';
      guard.registerUnresolvedDebt(mint);

      assert.equal(guard.hasUnresolvedDebt(mint), true);
      const lock = guard.acquireExitLock(mint, 1000n);
      assert.equal(lock.allowed, false);
      assert.equal(lock.code, 'UNRESOLVED_RECONCILIATION_DEBT');

      guard.clearUnresolvedDebt(mint);
      assert.equal(guard.hasUnresolvedDebt(mint), false);
      const lockAfterClear = guard.acquireExitLock(mint, 1000n);
      assert.equal(lockAfterClear.allowed, true);
      guard.releaseExitLock(mint);
    });
  });

  describe('FASE 4: Provider Receipt != Confirmation (P0-03, P0-06, R-P1-02)', () => {
    let repo: InMemoryJournalRepository;

    beforeEach(() => {
      process.env.NEXUS_V2_JOURNAL_SHADOW_ENABLED = 'true';
      repo = new InMemoryJournalRepository();
      setShadowRepository(repo);
    });


    it('shadowOnProviderReceipt with SUCCESS transitions to PROVIDER_SUCCESS, not CONFIRMED', async () => {
      const mint = 'MintShadowProviderReceipt1111111111111111111';
      const intentId = 'intent-sh-001';
      const attemptId = 'att-sh-001';

      // 1. Trigger shadow exit decision
      const ctx = await shadowOnExitDecision({
        mint,
        walletId: 'w-001',
        requestedAmountAtomic: '1000',
        reason: 'STOP_LOSS'
      });
      assert.ok(ctx);

      // 2. Trigger shadow order preparation
      await shadowOnJupiterOrder({
        mint,
        requestId: 'req-001',
        expectedOutAtomic: '100000000',
        minimumOutAtomic: '95000000'
      });

      // 3. Trigger shadow local sign
      const sig = 'SigProviderReceiptTest111111111111111111111111111111111111111111111111111111';
      await shadowOnLocalSign({
        mint,
        signature: sig
      });

      // 4. Trigger shadow submission
      await shadowOnSubmit({
        mint,
        signature: sig
      });

      // 5. Trigger shadow provider receipt with SUCCESS
      await shadowOnProviderReceipt({
        mint,
        status: 'SUCCESS',
        signature: sig
      });

      // Verify the attempt state is PROVIDER_SUCCESS, NOT CONFIRMED!
      const attempts = await repo.getAttemptsForIntent(ctx.intentId);
      const attempt = attempts[0];
      assert.ok(attempt);
      assert.equal(
        attempt.state,
        'PROVIDER_SUCCESS',
        'Provider SUCCESS must transition attempt to PROVIDER_SUCCESS, never directly to CONFIRMED'
      );


      // Now call shadowOnFillConfirmed with on-chain evidence
      await shadowOnFillConfirmed({
        mint,
        signature: 'SigProviderReceiptTest111111111111111111111111111111111111111111111111111111',
        grossProceedsLamports: 100000000,
        actualAmountAtomic: 1000
      });

      // After onFillConfirmed, the attempt MUST be CONFIRMED!
      const attemptsAfter = await repo.getAttemptsForIntent(ctx.intentId);
      const attemptAfter = attemptsAfter[0];
      assert.ok(attemptAfter);
      assert.equal(attemptAfter.state, 'CONFIRMED', 'Attempt becomes CONFIRMED only after onFillConfirmed');
    });
  });
});
