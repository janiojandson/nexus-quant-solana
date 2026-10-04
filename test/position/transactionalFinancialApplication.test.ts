/**
 * Nexus Quant Solana — Missão V2.3-R
 * Adversarial Regression Suite: Transactional Financial Application & Custody Policy (Commit R4)
 *
 * Covers:
 * - P1-06: Shared Transaction Boundary for Journal + Position (atomic commit/rollback)
 * - P1-07: Invariant protection against arbitrary caller-controlled balance mutations
 * - P1-08: CANONICAL_ATA_STRICT custody policy rejecting ambiguous non-ATA accounts
 * - P1-09: reconcilePositionCustody detecting external balance shifts, bumping version, and invalidating stale quotes
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
  ArbitraryBalanceMutationRejectedError,
  AmbiguousTokenAccountCustodyError,
  StalePositionVersionError,
  takePositionSnapshot
} from '../../src/position/types.js';
import {
  deriveCanonicalAta,
  assertCanonicalAtaCustody,
  reconcilePositionCustody
} from '../../src/position/custody.js';
import { evaluatePreSendVersionGate } from '../../src/position/versionGate.js';
import { Keypair } from '@solana/web3.js';
import { FillRecord } from '../../src/journal/types.js';

test('Nexus V2.3-R — Transactional Financial Application & Custody Policy (R4)', async (t) => {
  const baseTime = 1_700_000_000_000;
  const wallet = Keypair.generate();
  const walletId = wallet.publicKey.toBase58();
  const mint = Keypair.generate().publicKey.toBase58();

  // 1. P1-08: Canonical ATA Custody Assertion
  await t.test('P1-08: assertCanonicalAtaCustody accepts canonical ATA and rejects arbitrary/auxiliary accounts', async () => {
    const canonicalAta = deriveCanonicalAta(walletId, mint);
    assert.ok(canonicalAta);

    // Canonical address succeeds
    assert.doesNotThrow(() => {
      assertCanonicalAtaCustody(walletId, mint, canonicalAta);
    });

    // Auxiliary / non-ATA address is rejected with AmbiguousTokenAccountCustodyError
    const randomAuxiliaryAccount = Keypair.generate().publicKey.toBase58();
    assert.throws(
      () => assertCanonicalAtaCustody(walletId, mint, randomAuxiliaryAccount),
      (err: any) => {
        assert.ok(err instanceof AmbiguousTokenAccountCustodyError);
        assert.strictEqual(err.walletId, walletId);
        assert.strictEqual(err.mint, mint);
        assert.strictEqual(err.details?.providedAccount, randomAuxiliaryAccount);
        return true;
      }
    );
  });

  // 2. P1-07: Invariant protection against arbitrary balance mutations
  await t.test('P1-07: Invariants reject negative debit, excessive debit, and missing evidence on reconciliation', async () => {
    const posRepo = new InMemoryPositionRepository();

    const position = await posRepo.createPosition({
      positionId: 'pos_p1_07',
      tradeId: 'trade_p1_07',
      walletId,
      mint,
      initialAmountAtomic: 5000n,
      initialPrincipalLamports: 1000000n
    });

    // Case A: Debit > Balance -> Rejected
    await assert.rejects(
      () => posRepo.applyConfirmedFill({
        positionId: position.positionId,
        expectedVersion: 1n,
        fillId: 'fill_excessive',
        signature: 'sig_excessive',
        confirmedActualDebitAtomic: 6000n, // exceeds 5000n balance
        grossProceedsLamports: 100000n
      }),
      ArbitraryBalanceMutationRejectedError
    );

    // Case B: Negative debit -> Rejected
    await assert.rejects(
      () => posRepo.applyConfirmedFill({
        positionId: position.positionId,
        expectedVersion: 1n,
        fillId: 'fill_negative',
        signature: 'sig_negative',
        confirmedActualDebitAtomic: -100n,
        grossProceedsLamports: 100000n
      }),
      ArbitraryBalanceMutationRejectedError
    );

    // Case C: Arbitrary negative balance in updatePositionCAS -> Rejected
    await assert.rejects(
      () => posRepo.updatePositionCAS({
        positionId: position.positionId,
        expectedVersion: 1n,
        newAmountAtomic: -50n,
        mutationType: 'MANUAL_CORRECTION'
      }),
      ArbitraryBalanceMutationRejectedError
    );

    // Case D: applyReconciliationAdjustment without evidence metadata -> Rejected
    await assert.rejects(
      () => posRepo.applyReconciliationAdjustment({
        positionId: position.positionId,
        expectedVersion: 1n,
        observedBalanceAtomic: 4000n,
        evidence: null as any
      }),
      ArbitraryBalanceMutationRejectedError
    );

    // Case E: Valid applyConfirmedFill succeeds
    const fillResult = await posRepo.applyConfirmedFill({
      positionId: position.positionId,
      expectedVersion: 1n,
      fillId: 'fill_valid',
      signature: 'sig_valid',
      confirmedActualDebitAtomic: 2000n,
      grossProceedsLamports: 500000n
    });
    assert.strictEqual(fillResult.position.tokenAmountAtomic, 3000n);
    assert.strictEqual(fillResult.position.positionVersion, 2n);
  });

  // 3. P1-09: Custody Balance Reconciliation Loop
  await t.test('P1-09: reconcilePositionCustody detects external balance shifts, bumps version, and invalidates bound quotes', async () => {
    const posRepo = new InMemoryPositionRepository();

    const position = await posRepo.createPosition({
      positionId: 'pos_p1_09',
      tradeId: 'trade_p1_09',
      walletId,
      mint,
      initialAmountAtomic: 10000n,
      initialPrincipalLamports: 2000000n
    });

    // Step A: When on-chain observed balance matches, no divergence is recorded
    const matchRes = await reconcilePositionCustody({
      positionRepo: posRepo,
      positionId: position.positionId,
      expectedVersion: 1n,
      observedAtaBalanceAtomic: 10000n,
      evidence: {
        source: 'RPC_GET_TOKEN_ACCOUNT_BALANCE',
        observedAtWallMs: baseTime,
        reason: 'Periodic custody audit'
      }
    });
    assert.strictEqual(matchRes.divergenceDetected, false);
    assert.strictEqual(matchRes.newVersion, 1n);

    // Step B: External balance shift (e.g. 3000 tokens burned or transferred externally) -> Balance is now 7000n
    const divRes = await reconcilePositionCustody({
      positionRepo: posRepo,
      positionId: position.positionId,
      expectedVersion: 1n,
      observedAtaBalanceAtomic: 7000n,
      evidence: {
        source: 'RPC_GET_TOKEN_ACCOUNT_BALANCE',
        observedAtWallMs: baseTime + 1000,
        reason: 'Detected on-chain transfer divergence'
      }
    });

    assert.strictEqual(divRes.divergenceDetected, true);
    assert.strictEqual(divRes.previousBalanceAtomic, 10000n);
    assert.strictEqual(divRes.newBalanceAtomic, 7000n);
    assert.strictEqual(divRes.deltaAtomic, -3000n);
    assert.strictEqual(divRes.newVersion, 2n);
    assert.strictEqual(divRes.mutation?.mutationType, 'RECONCILIATION_ADJUSTMENT');

    // Step C: Verify that an existing quote that was bound to version 1n is now rejected as STALE
    const staleQuoteCheck = evaluatePreSendVersionGate({
      boundQuote: {
        quoteId: 'quote_old' as any,
        provider: 'JUPITER_V2',
        positionId: position.positionId,
        positionVersion: 1n, // Bound to v1
        mint,
        walletId,
        tokenProgram: position.tokenProgram,
        inAmountAtomic: 10000n,
        outAmountAtomic: 1000000n,
        otherAmountThreshold: 950000n,
        priceImpactPct: 0.01,
        routePlanHash: 'hash',
        amountPolicy: 'FULL_REMAINDER',
        requestedAmountAtomic: 10000n,
        boundAtWallMs: baseTime,
        boundAtMonoNs: 1000n,
        quoteExpiresAtWallMs: baseTime + 10000,
        rawQuoteResponse: {}
      },
      currentPosition: takePositionSnapshot(divRes.position), // Now at v2 with 7000 balance
      intentPolicy: 'FULL_REMAINDER'
    });

    assert.strictEqual(staleQuoteCheck.allowed, false);
    assert.strictEqual(staleQuoteCheck.code, 'QUOTE_STALE_FOR_POSITION');
  });

  // 4. P1-06: Shared Transaction Boundary against real PostgreSQL
  await t.test('P1-06: applyConfirmedFillAtomically rolls back journal insert if position mutation fails', async () => {
    const pool = await createRequiredTestPool();

    try {
      const journalRepo = new PostgresJournalRepository({ pool });
      const positionRepo = new PostgresPositionRepository({ pool });

      const testTradeId = `trade_tx_${Date.now()}`;
      const testPosId = `pos_tx_${Date.now()}`;
      const testIntentId = `intent_tx_${Date.now()}`;

      // Open a position in PG
      const pos = await positionRepo.createPosition({
        positionId: testPosId,
        tradeId: testTradeId,
        walletId,
        mint,
        initialAmountAtomic: 5000n,
        initialPrincipalLamports: 1000000n
      });
      assert.strictEqual(pos.positionVersion, 1n);

      // Create an intent in PG
      const { intent } = await journalRepo.createOrGetIntent({
        id: testIntentId as any,
        tradeId: testTradeId as any,
        positionId: testPosId as any,
        walletId,
        mint,
        tokenProgram: pos.tokenProgram,
        positionVersion: 1n,
        requestedAmountAtomic: '5000',
        amountPolicy: 'FULL_REMAINDER',
        initialSeverity: 'NORMAL',
        reason: 'TAKE_PROFIT',
        policyVersion: '2026-10-04'
      });

      const claimed = await journalRepo.claimIntent({
        workerId: 'worker_atomic_test',
        leaseDurationMs: 10000,
        intentId: intent.id
      });
      assert.ok(claimed);

      const attempt = await journalRepo.prepareAttempt({
        attemptId: `att_atomic_${Date.now()}` as any,
        intentId: intent.id,
        provider: 'JUPITER_V2',
        requestedAmountAtomic: '2000',
      }, claimed!.claimEpoch);

      await journalRepo.updateAttemptState(
        attempt.attemptId,
        'SUBMITTED',
        { signature: `sig_atomic_${Date.now()}` as any },
        claimed!.claimEpoch
      );

      const latestAttempt = (await journalRepo.getAttemptById(attempt.attemptId))!;

      const fillPayload: FillRecord = {
        id: `fill_atomic_${Date.now()}` as any,
        tradeId: testTradeId as any,
        positionId: testPosId as any,
        intentId: intent.id,
        attemptId: attempt.attemptId,
        signature: latestAttempt.signature!,
        realizationSequence: 1,
        chainLegIndex: 0,
        instructionIndex: 3,
        innerInstructionIndex: -1,
        requestedAmountAtomic: '2000',
        actualAmountAtomic: '2000',
        grossProceedsLamports: '500000',
        networkFeeLamports: '5000',
        priorityFeeLamports: '0',
        tipLamports: '0',
        rentMovementLamports: '0',
        slot: 100,
        commitment: 'confirmed',
        confirmedAtWallMs: baseTime as any,
        evidenceType: 'CHAIN_CONFIRMED',
        createdAtWallMs: baseTime as any
      };

      // Adversarial test: supply a STALE expectedPositionVersion (e.g. 99n instead of 1n)
      // Step 3 (recordFill) succeeds in tx, but Step 4 (applyConfirmedFill) will throw StalePositionVersionError.
      // The whole transaction MUST rollback!
      await assert.rejects(
        () => applyConfirmedFillAtomically({
          pool,
          journalRepo,
          positionRepo,
          fill: fillPayload,
          expectedEpoch: claimed!.claimEpoch,
          expectedPositionVersion: 99n // STALE VERSION!
        }),
        StalePositionVersionError
      );

      // Verify rollback: fill_ledger MUST NOT contain fillPayload.id!
      const checkFillRes = await pool.query('SELECT * FROM fill_ledger WHERE id = $1', [fillPayload.id]);
      assert.strictEqual(checkFillRes.rows.length, 0, 'fill_ledger row must be rolled back on position mutation failure');

      // Verify position balance and version remain untouched at 5000n and 1n
      const untouchedPos = await positionRepo.getPosition(testPosId);
      assert.strictEqual(untouchedPos?.tokenAmountAtomic, 5000n);
      assert.strictEqual(untouchedPos?.positionVersion, 1n);

      // Now execute with correct expectedPositionVersion: 1n -> MUST COMMIT ATOMICALLY
      const successRes = await applyConfirmedFillAtomically({
        pool,
        journalRepo,
        positionRepo,
        fill: fillPayload,
        expectedEpoch: claimed!.claimEpoch,
        expectedPositionVersion: 1n
      });

      assert.strictEqual(successRes.fillCreated, true);
      assert.strictEqual(successRes.position.tokenAmountAtomic, 3000n);
      assert.strictEqual(successRes.position.positionVersion, 2n);

      // Verify database reflects both fill and position mutation
      const finalFillRes = await pool.query('SELECT * FROM fill_ledger WHERE id = $1', [fillPayload.id]);
      assert.strictEqual(finalFillRes.rows.length, 1);
      const finalPosRes = await pool.query('SELECT * FROM nexus_positions_v2 WHERE position_id = $1', [testPosId]);
      assert.strictEqual(BigInt(finalPosRes.rows[0].position_version), 2n);
      assert.strictEqual(BigInt(finalPosRes.rows[0].token_amount_atomic), 3000n);
    } finally {
      await pool.end();
    }
  });
});
