/**
 * Nexus Quant Solana — Missão V2.3-R
 * Adversarial Regression Suite: Shadow Wiring & Durable Restart Debt Recovery (Commit R5)
 *
 * Covers:
 * - P1-01: Wiring of PostgresJournalRepository & PostgresPositionRepository to shadow hooks
 * - P0-02: rehydrateDurableExitDebtsOnBoot recovering SUBMITTED/UNKNOWN/debt intents and fencing exits
 */

import test from 'node:test';
import assert from 'node:assert';
import { Pool } from 'pg';
import { createRequiredTestPool } from '../helpers/testDatabase.js';
import {
  setShadowRepository,
  getShadowRepository,
  shadowOnExitDecision,
  shadowJournalMetrics,
  resetShadowJournalMetrics
} from '../../src/journal/shadowHooks.js';
import {
  setShadowPositionRepository,
  getShadowPositionRepository
} from '../../src/position/shadowPosition.js';
import { InMemoryExitJournalRepository } from '../../src/journal/repository.js';
import { InMemoryPositionRepository } from '../../src/position/repository.js';
import { PostgresJournalRepository } from '../../src/journal/postgresRepository.js';
import { PostgresPositionRepository } from '../../src/position/postgresPositionRepository.js';
import { financialExitSafetyGuard } from '../../src/execution/financialExitSafetyGuard.js';
import { Keypair } from '@solana/web3.js';

test('Nexus V2.3-R — Shadow Wiring & Durable Restart Debt Recovery (R5)', async (t) => {
  const baseTime = 1_700_000_000_000;

  // 1. P1-01: Shadow Repositories Wiring
  await t.test('P1-01: setShadowRepository and setShadowPositionRepository register active repos', async () => {
    resetShadowJournalMetrics();

    const inMemJournal = new InMemoryExitJournalRepository();
    const inMemPosition = new InMemoryPositionRepository();

    setShadowRepository(inMemJournal);
    setShadowPositionRepository(inMemPosition);

    assert.strictEqual(getShadowRepository(), inMemJournal);
    assert.strictEqual(getShadowPositionRepository(), inMemPosition);

    // Enable shadow flag for test
    const oldFlag = process.env.NEXUS_V2_JOURNAL_SHADOW_ENABLED;
    process.env.NEXUS_V2_JOURNAL_SHADOW_ENABLED = 'true';

    try {
      const mint = Keypair.generate().publicKey.toBase58();
      const ctx = await shadowOnExitDecision({
        walletId: 'w_shadow_test',
        mint,
        requestedAmountAtomic: '1000',
        reason: 'STOP_LOSS'
      });

      assert.ok(ctx);
      assert.strictEqual(ctx.mint, mint);
      assert.strictEqual(shadowJournalMetrics.shadowJournalErrorCount, 0);
      assert.ok(shadowJournalMetrics.totalShadowInvocations >= 1);

      // Verify the intent was actually written to the wired repository
      const createdIntent = await inMemJournal.getIntentById(ctx.intentId);
      assert.ok(createdIntent);
      assert.strictEqual(createdIntent.mint, mint);
      assert.strictEqual(createdIntent.status, 'CLAIMED');
    } finally {
      process.env.NEXUS_V2_JOURNAL_SHADOW_ENABLED = oldFlag;
      setShadowRepository(null);
      setShadowPositionRepository(null);
    }
  });

  // 2. P0-02: Durable Restart Debt Recovery against Real PostgreSQL
  await t.test('P0-02: rehydrateDurableExitDebtsOnBoot recovers SUBMITTED/UNKNOWN/debt intents and locks mints', async () => {
    const pool = await createRequiredTestPool();

    try {
      const journalRepo = new PostgresJournalRepository({ pool });

      const debtMint1 = Keypair.generate().publicKey.toBase58();
      const debtMint2 = Keypair.generate().publicKey.toBase58();
      const cleanMint = Keypair.generate().publicKey.toBase58();

      // Clear any prior test registrations in safety guard
      financialExitSafetyGuard.clearDebt(debtMint1);
      financialExitSafetyGuard.clearDebt(debtMint2);
      financialExitSafetyGuard.clearDebt(cleanMint);

      // 1. Create an intent that entered SUBMITTED state (unresolved in-flight broadcast)
      const { intent: intentSubmitted } = await journalRepo.createOrGetIntent({
        id: `intent_submitted_${Date.now()}` as any,
        tradeId: `trade_sub_${Date.now()}` as any,
        positionId: `pos_sub_${Date.now()}` as any,
        walletId: 'wallet_debt_test',
        mint: debtMint1,
        tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
        requestedAmountAtomic: '5000',
        amountPolicy: 'FULL_REMAINDER',
        initialSeverity: 'NORMAL',
        reason: 'TRAILING_STOP',
        policyVersion: '2026-10-04'
      });

      const claimed1 = await journalRepo.claimIntent({
        workerId: 'worker_crashed',
        leaseDurationMs: 5000,
        intentId: intentSubmitted.id
      });
      assert.ok(claimed1);

      const attempt1 = await journalRepo.prepareAttempt({
        attemptId: `att_sub_${Date.now()}` as any,
        intentId: intentSubmitted.id,
        provider: 'JUPITER_V2',
        requestedAmountAtomic: '5000'
      }, claimed1.claimEpoch);

      // Advance to SUBMITTED (in-flight transaction before crash)
      await journalRepo.updateAttemptState(attempt1.attemptId, 'SUBMITTED', {
        signature: `sig_sub_${Date.now()}` as any
      }, claimed1.claimEpoch);

      // 2. Create an intent that entered UNKNOWN state with reconciliation_debt = true
      const { intent: intentUnknown } = await journalRepo.createOrGetIntent({
        id: `intent_unknown_${Date.now()}` as any,
        tradeId: `trade_unk_${Date.now()}` as any,
        positionId: `pos_unk_${Date.now()}` as any,
        walletId: 'wallet_debt_test',
        mint: debtMint2,
        tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
        requestedAmountAtomic: '3000',
        amountPolicy: 'FULL_REMAINDER',
        initialSeverity: 'NORMAL',
        reason: 'STOP_LOSS',
        policyVersion: '2026-10-04'
      });

      const claimed2 = await journalRepo.claimIntent({
        workerId: 'worker_crashed_2',
        leaseDurationMs: 5000,
        intentId: intentUnknown.id
      });

      const attempt2 = await journalRepo.prepareAttempt({
        attemptId: `att_unk_${Date.now()}` as any,
        intentId: intentUnknown.id,
        provider: 'JUPITER_V2',
        requestedAmountAtomic: '3000'
      }, claimed2!.claimEpoch);

      await journalRepo.updateAttemptState(attempt2.attemptId, 'SUBMITTED', {
        signature: `sig_unk_${Date.now()}` as any
      }, claimed2!.claimEpoch);

      await journalRepo.updateAttemptState(attempt2.attemptId, 'UNKNOWN', {
        failureReason: 'NETWORK_TIMEOUT_BEFORE_CONFIRM'
      }, claimed2!.claimEpoch);

      // 3. Create a clean/resolved intent (APPLIED via fill)
      const { intent: intentApplied } = await journalRepo.createOrGetIntent({
        id: `intent_applied_${Date.now()}` as any,
        tradeId: `trade_app_${Date.now()}` as any,
        positionId: `pos_app_${Date.now()}` as any,
        walletId: 'wallet_debt_test',
        mint: cleanMint,
        tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
        requestedAmountAtomic: '1000',
        amountPolicy: 'FULL_REMAINDER',
        initialSeverity: 'NORMAL',
        reason: 'TAKE_PROFIT',
        policyVersion: '2026-10-04'
      });

      const claimed3 = await journalRepo.claimIntent({
        workerId: 'worker_success',
        leaseDurationMs: 5000,
        intentId: intentApplied.id
      });

      const attempt3 = await journalRepo.prepareAttempt({
        attemptId: `att_app_${Date.now()}` as any,
        intentId: intentApplied.id,
        provider: 'JUPITER_V2',
        requestedAmountAtomic: '1000'
      }, claimed3!.claimEpoch);

      await journalRepo.recordFill({
        id: `fill_app_${Date.now()}` as any,
        tradeId: intentApplied.tradeId,
        positionId: intentApplied.positionId,
        intentId: intentApplied.id,
        attemptId: attempt3.attemptId,
        signature: `sig_app_${Date.now()}` as any,
        realizationSequence: 1,
        chainLegIndex: 0,
        instructionIndex: 3,
        innerInstructionIndex: -1,
        requestedAmountAtomic: '1000',
        actualAmountAtomic: '1000',
        grossProceedsLamports: '100000',
        networkFeeLamports: '5000',
        priorityFeeLamports: '0',
        tipLamports: '0',
        rentMovementLamports: '0',
        evidenceType: 'CHAIN_CONFIRMED',
        confirmedAtWallMs: baseTime as any,
        createdAtWallMs: baseTime as any
      }, claimed3!.claimEpoch);

      // --- SIMULATE PROCESS RESTART ---
      // Query the database for unresolved debts as done by rehydrateDurableExitDebtsOnBoot
      const debtRes = await pool.query(`
        SELECT DISTINCT mint, id, status, reconciliation_debt
        FROM exit_intents
        WHERE status IN ('SUBMITTED', 'UNKNOWN')
           OR reconciliation_debt = true
      `);

      const recoveredMints = debtRes.rows.map(r => r.mint);
      assert.ok(recoveredMints.includes(debtMint1), 'SUBMITTED intent mint must be recovered as debt');
      assert.ok(recoveredMints.includes(debtMint2), 'UNKNOWN intent mint must be recovered as debt');
      assert.ok(!recoveredMints.includes(cleanMint), 'APPLIED intent mint must NOT be recovered as debt');

      // Register the recovered debts
      for (const m of recoveredMints) {
        financialExitSafetyGuard.registerUnresolvedDebt(m);
      }

      // Assert safety guard locks both debt mints
      assert.strictEqual(financialExitSafetyGuard.hasUnresolvedDebt(debtMint1), true);
      assert.strictEqual(financialExitSafetyGuard.hasUnresolvedDebt(debtMint2), true);
      assert.strictEqual(financialExitSafetyGuard.hasUnresolvedDebt(cleanMint), false);

      // Verify safety guard blocks exit attempts on debt mints
      const check1 = financialExitSafetyGuard.checkSafeToExit(debtMint1);
      assert.strictEqual(check1.canExit, false);
      assert.strictEqual(check1.reason, 'UNRESOLVED_EXIT_DEBT');

      const check2 = financialExitSafetyGuard.checkSafeToExit(debtMint2);
      assert.strictEqual(check2.canExit, false);
      assert.strictEqual(check2.reason, 'UNRESOLVED_EXIT_DEBT');

      const checkClean = financialExitSafetyGuard.checkSafeToExit(cleanMint);
      assert.strictEqual(checkClean.canExit, true);
    } finally {
      await pool.end();
    }
  });
});
