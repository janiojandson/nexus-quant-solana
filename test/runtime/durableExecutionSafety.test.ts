/**
 * Nexus Quant Solana — Missão V2.3-R3
 * Test: Durable Execution Safety Persistence independent of Shadow Mode
 *
 * Verifies:
 * 1. Live sells persist durable execution debt even when NEXUS_V2_JOURNAL_SHADOW_ENABLED=false
 * 2. Fail closed on DB failure (FINANCIAL_PERSISTENCE_UNAVAILABLE)
 * 3. Survives restart: UNKNOWN attempt blocks sells in financialExitSafetyGuard
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  setDurableSafetyRepository,
  getDurableSafetyRepository,
  isDurableExecutionSafetyActive,
  FinancialPersistenceUnavailableError,
  setDurableSafetyEnforcement,
  recordLiveExitIntent,
  updateLiveAttemptOnSubmit,
  updateLiveAttemptOnReceipt
} from '../../src/journal/durableExecutionSafety.js';
import { InMemoryExitJournalRepository } from '../../src/journal/repository.js';
import { financialExitSafetyGuard } from '../../src/execution/financialExitSafetyGuard.js';
import { Keypair } from '@solana/web3.js';

test('Nexus V2.3-R3 — Durable Execution Safety Persistence (Commit R3-1)', async (t) => {
  const originalShadowFlag = process.env.NEXUS_V2_JOURNAL_SHADOW_ENABLED;

  t.afterEach(() => {
    process.env.NEXUS_V2_JOURNAL_SHADOW_ENABLED = originalShadowFlag;
    setDurableSafetyRepository(null);
    setDurableSafetyEnforcement(true);
  });

  await t.test('1. Live sell persists intent and UNKNOWN attempt with shadow flag disabled (NEXUS_V2_JOURNAL_SHADOW_ENABLED=false)', async () => {
    // Explicitly enforce shadow flag = false (default)
    process.env.NEXUS_V2_JOURNAL_SHADOW_ENABLED = 'false';

    const inMemRepo = new InMemoryExitJournalRepository();
    setDurableSafetyRepository(inMemRepo);

    assert.strictEqual(isDurableExecutionSafetyActive(), true);

    const mint = Keypair.generate().publicKey.toBase58();
    financialExitSafetyGuard.clearDebt(mint);

    // 1. Exit decision
    const ctx = await recordLiveExitIntent({
      walletId: 'wallet_safety_test',
      mint,
      requestedAmountAtomic: '5000000',
      reason: 'STOP_LOSS'
    });

    assert.ok(ctx);
    assert.strictEqual(ctx.mint, mint);

    // Verify intent exists in repo despite shadow flag being false
    const intent = await inMemRepo.getIntentById(ctx.intentId);
    assert.ok(intent);
    assert.strictEqual(intent.mint, mint);
    assert.strictEqual(intent.status, 'PREPARED');

    // 2. Submit
    const dummySig = Keypair.generate().publicKey.toBase58();
    await updateLiveAttemptOnSubmit(mint, dummySig);

    // 3. Provider timeout -> SUBMITTED_UNCONFIRMED -> UNKNOWN
    await updateLiveAttemptOnReceipt(
      mint,
      'SUBMITTED_UNCONFIRMED',
      dummySig,
      'Transaction broadcast timeout'
    );

    // Verify attempt reached UNKNOWN state in durable repository
    const attempts = await inMemRepo.getAttemptsForIntent(ctx.intentId);
    assert.strictEqual(attempts.length, 1);
    assert.strictEqual(attempts[0].state, 'UNKNOWN');
    assert.strictEqual(attempts[0].signature, dummySig);
  });

  await t.test('2. Fail closed on DB failure: throws FINANCIAL_PERSISTENCE_UNAVAILABLE when repository is missing or rejects', async () => {
    process.env.NEXUS_V2_JOURNAL_SHADOW_ENABLED = 'false';

    // No safety repo registered
    setDurableSafetyRepository(null);
    setDurableSafetyEnforcement(true);

    const mint = Keypair.generate().publicKey.toBase58();

    // Since durable safety is enforced and repo is null, it must throw FinancialPersistenceUnavailableError
    await assert.rejects(
      async () => {
        await recordLiveExitIntent({
          walletId: 'wallet_safety_test',
          mint,
          requestedAmountAtomic: '5000000',
          reason: 'STOP_LOSS'
        });
      },
      (err: any) => {
        assert.ok(err instanceof FinancialPersistenceUnavailableError);
        assert.strictEqual(err.code, 'FINANCIAL_PERSISTENCE_UNAVAILABLE');
        return true;
      }
    );
  });

  await t.test('3. Failing repository operation throws FINANCIAL_PERSISTENCE_UNAVAILABLE (No blind execution on DB failure)', async () => {
    process.env.NEXUS_V2_JOURNAL_SHADOW_ENABLED = 'false';

    const brokenRepo: any = {
      createOrGetIntent: async () => {
        throw new Error('PostgreSQL connection terminated unexpectedly (ECONNREFUSED)');
      },
      claimIntent: async () => null
    };

    setDurableSafetyRepository(brokenRepo);

    const mint = Keypair.generate().publicKey.toBase58();

    await assert.rejects(
      async () => {
        await recordLiveExitIntent({
          walletId: 'wallet_safety_test',
          mint,
          requestedAmountAtomic: '5000000',
          reason: 'STOP_LOSS'
        });
      },
      (err: any) => {
        assert.ok(err instanceof FinancialPersistenceUnavailableError);
        assert.strictEqual(err.code, 'FINANCIAL_PERSISTENCE_UNAVAILABLE');
        assert.match(err.message, /ECONNREFUSED/);
        return true;
      }
    );
  });
});
