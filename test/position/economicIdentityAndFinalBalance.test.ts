/**
 * Nexus Quant Solana — Missão V2.3-R2
 * Adversarial Regression Suite: Economic Identity, Final Balance Residual & Administrative Mutation
 *
 * Covers:
 * - R-P1-03: isFinal=true with residual token balance > 0n is strictly rejected (InvalidFinalFillResidualError)
 * - R-P1-01: Intent <-> Attempt <-> Fill <-> Position economic identity verification and atomic rollback
 * - P1-07: Explicit administrative correction API requiring actor & reason, rejecting arbitrary caller mutations
 */

import test from 'node:test';
import assert from 'node:assert';
import { Pool } from 'pg';
import { createRequiredTestPool } from '../helpers/testDatabase.js';
import { InMemoryPositionRepository } from '../../src/position/repository.js';
import { PostgresPositionRepository } from '../../src/position/postgresPositionRepository.js';
import { PostgresJournalRepository } from '../../src/journal/postgresRepository.js';
import { applyConfirmedFillAtomically } from '../../src/position/atomicFinancialApplication.js';
import {
  InvalidFinalFillResidualError,
  EconomicIdentityMismatchError,
  ArbitraryBalanceMutationRejectedError,
  DEFAULT_TOKEN_PROGRAM_ID
} from '../../src/position/types.js';
import { Keypair } from '@solana/web3.js';
import { FillRecord } from '../../src/journal/types.js';

test('Nexus V2.3-R2 — Economic Identity & Final Balance Invariants', async (t) => {
  const wallet = Keypair.generate();
  const walletId = wallet.publicKey.toBase58();
  const mint = Keypair.generate().publicKey.toBase58();

  // 1. R-P1-03: Residual balance on isFinal = true in Memory and Postgres
  await t.test('R-P1-03: isFinal=true with positive residual balance (1000 debit 400) is strictly rejected', async () => {
    const memRepo = new InMemoryPositionRepository();
    const pos = await memRepo.createPosition({
      positionId: 'pos_residual_mem',
      tradeId: 'trade_res_mem',
      walletId,
      mint,
      initialAmountAtomic: 1000n,
      initialPrincipalLamports: 1_000_000n
    });

    // 1000 debit 400 with isFinal = true -> must REJECT
    await assert.rejects(
      () => memRepo.applyConfirmedFill({
        positionId: pos.positionId,
        expectedVersion: 1n,
        fillId: 'fill_premature_final',
        signature: 'sig_premature_final',
        confirmedActualDebitAtomic: 400n,
        grossProceedsLamports: 400_000n,
        isFinal: true
      }),
      (err: any) => {
        assert.ok(err instanceof InvalidFinalFillResidualError, `Expected InvalidFinalFillResidualError, got: ${err?.message}`);
        assert.strictEqual(err.positionId, pos.positionId);
        assert.strictEqual(err.residualBalance, 600n);
        return true;
      }
    );

    // Also updatePositionCAS with FINAL_FILL and positive residual must reject
    await assert.rejects(
      () => memRepo.updatePositionCAS({
        positionId: pos.positionId,
        expectedVersion: 1n,
        newAmountAtomic: 600n,
        mutationType: 'FINAL_FILL'
      }),
      (err: any) => {
        assert.ok(err instanceof InvalidFinalFillResidualError);
        return true;
      }
    );

    // Partial fill (without isFinal) is allowed
    const partialRes = await memRepo.applyConfirmedFill({
      positionId: pos.positionId,
      expectedVersion: 1n,
      fillId: 'fill_valid_partial',
      signature: 'sig_valid_partial',
      confirmedActualDebitAtomic: 400n,
      grossProceedsLamports: 400_000n,
      isFinal: false
    });
    assert.strictEqual(partialRes.position.tokenAmountAtomic, 600n);
    assert.strictEqual(partialRes.position.status, 'PARTIAL_CLOSED');

    // Final fill that exhausts remaining balance is allowed
    const finalRes = await memRepo.applyConfirmedFill({
      positionId: pos.positionId,
      expectedVersion: 2n,
      fillId: 'fill_valid_final',
      signature: 'sig_valid_final',
      confirmedActualDebitAtomic: 600n,
      grossProceedsLamports: 600_000n,
      isFinal: true
    });
    assert.strictEqual(finalRes.position.tokenAmountAtomic, 0n);
    assert.strictEqual(finalRes.position.status, 'CLOSED');
  });

  // 2. P1-07: Administrative correction requires actor and reason
  await t.test('P1-07: applyExplicitAdministrativeCorrection requires actor and reason', async () => {
    const memRepo = new InMemoryPositionRepository();
    const pos = await memRepo.createPosition({
      positionId: 'pos_admin_test',
      tradeId: 'trade_admin_test',
      walletId,
      mint,
      initialAmountAtomic: 1000n,
      initialPrincipalLamports: 1_000_000n
    });

    // Empty actor rejected
    await assert.rejects(
      () => memRepo.applyExplicitAdministrativeCorrection({
        positionId: pos.positionId,
        expectedVersion: 1n,
        newAmountAtomic: 800n,
        actor: '',
        reason: 'Manual custody adjustment'
      }),
      ArbitraryBalanceMutationRejectedError
    );

    // Empty reason rejected
    await assert.rejects(
      () => memRepo.applyExplicitAdministrativeCorrection({
        positionId: pos.positionId,
        expectedVersion: 1n,
        newAmountAtomic: 800n,
        actor: 'operator_1',
        reason: '   '
      }),
      ArbitraryBalanceMutationRejectedError
    );

    // Valid administrative correction succeeds
    const correctionRes = await memRepo.applyExplicitAdministrativeCorrection({
      positionId: pos.positionId,
      expectedVersion: 1n,
      newAmountAtomic: 800n,
      actor: 'lead_operator',
      reason: 'On-chain manual settlement synchronization'
    });
    assert.strictEqual(correctionRes.position.tokenAmountAtomic, 800n);
    assert.strictEqual(correctionRes.mutation.mutationType, 'MANUAL_CORRECTION');
  });

  // 3. PostgreSQL tests (R-P1-01 and R-P1-03 on real DB)
  await t.test('Postgres: Economic identity verification and atomic application rollback', async () => {
    const pool: Pool = await createRequiredTestPool();
    const journalRepo = new PostgresJournalRepository({ pool });
    const positionRepo = new PostgresPositionRepository({ pool });

    const posId = `pos_ident_${Date.now()}`;
    const intentId = `intent_ident_${Date.now()}`;
    const attemptId = `att_ident_${Date.now()}`;
    const fillId = `fill_ident_${Date.now()}`;
    const sig = `sig_ident_${Date.now()}`;

    try {
      // Setup position
      const pos = await positionRepo.createPosition({
        positionId: posId,
        tradeId: 'trade_ident_1',
        walletId,
        mint,
        tokenProgram: DEFAULT_TOKEN_PROGRAM_ID,
        initialAmountAtomic: 1000n,
        initialPrincipalLamports: 1_000_000n
      });

      // R-P1-03 on Postgres: 1000 debit 400 isFinal=true must reject
      await assert.rejects(
        () => positionRepo.applyConfirmedFill({
          positionId: pos.positionId,
          expectedVersion: 1n,
          fillId: 'fill_pg_premature_final',
          signature: 'sig_pg_premature_final',
          confirmedActualDebitAtomic: 400n,
          grossProceedsLamports: 400_000n,
          isFinal: true
        }),
        (err: any) => {
          assert.ok(err instanceof InvalidFinalFillResidualError);
          assert.strictEqual(err.positionId, pos.positionId);
          assert.strictEqual(err.residualBalance, 600n);
          return true;
        }
      );

      // Setup Intent in DB
      await pool.query(
        `INSERT INTO exit_intents (
          id, trade_id, position_id, wallet_id, mint, token_program,
          requested_amount_atomic, amount_policy, initial_severity, current_severity,
          reason, policy_version, economic_dedupe_key, expires_at, status, claim_epoch
        ) VALUES (
          $1, $2, $3, $4, $5, $6,
          $7, 'FULL', 'HIGH', 'HIGH',
          'STOP_LOSS', 'v2', $8, NOW() + INTERVAL '1 hour', 'CLAIMED', 1
        )`,
        [
          intentId,
          'trade_ident_1',
          posId,
          walletId,
          mint,
          DEFAULT_TOKEN_PROGRAM_ID,
          '1000',
          `dedupe_${Date.now()}`
        ]
      );

      // Setup Execution Attempt in DB
      await pool.query(
        `INSERT INTO execution_attempts (
          attempt_id, intent_id, provider, requested_amount_atomic, state, signature
        ) VALUES ($1, $2, 'JUPITER', '1000', 'SUBMITTED', $3)`,
        [attemptId, intentId, sig]
      );

      // Test R-P1-01 A: Fill with mismatched assetMint
      const mismatchedFillA: FillRecord = {
        id: fillId,
        tradeId: 'trade_ident_1',
        positionId: posId,
        intentId,
        attemptId,
        signature: sig,
        realizationSequence: 1,
        chainLegIndex: 0,
        instructionIndex: -1,
        innerInstructionIndex: -1,
        assetMint: 'foreign_mint_mismatch_123',
        requestedAmountAtomic: 1000n,
        actualAmountAtomic: 1000n,
        grossProceedsLamports: 1_000_000n,
        networkFeeLamports: 5000n,
        priorityFeeLamports: 0n,
        tipLamports: 0n,
        rentMovementLamports: 0n,
        slot: 123456n,
        commitment: 'confirmed',
        evidenceType: 'CHAIN_OBSERVED',
        createdAt: new Date()
      };

      await assert.rejects(
        () => applyConfirmedFillAtomically({
          pool,
          journalRepo,
          positionRepo,
          fill: mismatchedFillA,
          expectedEpoch: 1n,
          expectedPositionVersion: 1n,
          isFinal: true
        }),
        (err: any) => {
          assert.ok(err instanceof EconomicIdentityMismatchError);
          return true;
        }
      );

      // Test R-P1-01 B: Fill with mismatched attempt FK (attempt belongs to different intent)
      const foreignIntentId = `foreign_intent_${Date.now()}`;
      const foreignAttemptId = `foreign_att_${Date.now()}`;
      const foreignWalletId = Keypair.generate().publicKey.toBase58();
      const foreignMint = Keypair.generate().publicKey.toBase58();
      await pool.query(
        `INSERT INTO exit_intents (
          id, trade_id, position_id, wallet_id, mint, token_program,
          requested_amount_atomic, amount_policy, initial_severity, current_severity,
          reason, policy_version, economic_dedupe_key, expires_at, status, claim_epoch
        ) VALUES (
          $1, 'trade_foreign', 'pos_foreign', $2, $3, 'prog_foreign',
          '1000', 'FULL', 'HIGH', 'HIGH',
          'STOP_LOSS', 'v2', $4, NOW() + INTERVAL '1 hour', 'CLAIMED', 1
        )`,
        [foreignIntentId, foreignWalletId, foreignMint, `dedupe_foreign_${Date.now()}`]
      );
      await pool.query(
        `INSERT INTO execution_attempts (
          attempt_id, intent_id, provider, requested_amount_atomic, state, signature
        ) VALUES ($1, $2, 'JUPITER', '1000', 'SUBMITTED', 'sig_foreign')`,
        [foreignAttemptId, foreignIntentId]
      );

      const mismatchedFillB: FillRecord = {
        ...mismatchedFillA,
        positionId: posId,
        attemptId: foreignAttemptId // points to foreign intent
      };

      await assert.rejects(
        () => applyConfirmedFillAtomically({
          pool,
          journalRepo,
          positionRepo,
          fill: mismatchedFillB,
          expectedEpoch: 1n,
          expectedPositionVersion: 1n,
          isFinal: true
        }),
        (err: any) => {
          assert.ok(err instanceof EconomicIdentityMismatchError);
          return true;
        }
      );

      // Verify position was NOT mutated (rolled back)
      const freshPos = await positionRepo.getPosition(posId);
      assert.strictEqual(freshPos?.positionVersion, 1n);
      assert.strictEqual(freshPos?.tokenAmountAtomic, 1000n);

      // Test Valid Atomic Application: matching identity
      const validFill: FillRecord = {
        ...mismatchedFillA,
        positionId: posId,
        attemptId,
        assetMint: mint
      };

      const result = await applyConfirmedFillAtomically({
        pool,
        journalRepo,
        positionRepo,
        fill: validFill,
        expectedEpoch: 1n,
        expectedPositionVersion: 1n,
        isFinal: true
      });

      assert.strictEqual(result.fillCreated, true);
      assert.strictEqual(result.position.positionVersion, 2n);
      assert.strictEqual(result.position.tokenAmountAtomic, 0n);
      assert.strictEqual(result.position.status, 'CLOSED');

      // Verify Intent was marked APPLIED and debt cleared in Postgres
      const intentCheck = await pool.query('SELECT status, reconciliation_debt FROM exit_intents WHERE id = $1', [intentId]);
      assert.strictEqual(intentCheck.rows[0].status, 'APPLIED');
      assert.strictEqual(intentCheck.rows[0].reconciliation_debt, false);

      // Verify Attempt was marked CONFIRMED
      const attemptCheck = await pool.query('SELECT state FROM execution_attempts WHERE attempt_id = $1', [attemptId]);
      assert.strictEqual(attemptCheck.rows[0].state, 'CONFIRMED');

    } finally {
      await pool.end();
    }
  });
});
