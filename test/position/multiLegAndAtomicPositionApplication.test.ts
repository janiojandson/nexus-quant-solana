/**
 * Nexus Quant Solana — V2.3-R3 Commit R3-6 Test Suite
 *
 * Validates:
 * 1. Multi-leg Fill Identity (Finding 29):
 *    - Same transaction signature with two distinct legs (e.g. chainLegIndex: 0 and chainLegIndex: 1)
 *      both apply cleanly without being falsely dropped as duplicate fills.
 *    - Replaying the same leg returns alreadyApplied: true without double-debiting.
 * 2. Fill <-> Attempt Signature Binding (Finding 27):
 *    - applyConfirmedFillAtomically throws EconomicIdentityMismatchError if fill.signature != attempt.signature.
 * 3. State Machine transition enforcement (Finding 31):
 *    - applyConfirmedFillAtomically enforces assertValidAttemptTransition on attempt state.
 * 4. Administrative Correction with Evidence & Audit (Finding 32 & 33):
 *    - applyExplicitAdministrativeCorrection requires evidence, actor, reason.
 *    - Records append-only audit event in system_audit_events table / store.
 *    - Exposes typed administrativeCorrectionWithEvidence and reconcilePositionCustody.
 * 5. recordFill API separation (Finding 30):
 *    - recordFill alone appends to fill_ledger but does NOT mark parent intent APPLIED.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import {
  InMemoryPositionRepository,
  IPositionRepository
} from '../../src/position/repository.js';
import { PostgresPositionRepository } from '../../src/position/postgresPositionRepository.js';
import { InMemoryJournalRepository } from '../../src/journal/repository.js';
import { PostgresJournalRepository } from '../../src/journal/postgresRepository.js';
import { applyConfirmedFillAtomically } from '../../src/position/atomicFinancialApplication.js';
import {
  ArbitraryBalanceMutationRejectedError,
  EconomicIdentityMismatchError
} from '../../src/position/types.js';
import {
  FillRecord,
  IllegalStateTransitionError
} from '../../src/journal/types.js';

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ||
  'postgresql://test_nexus_user:descartavel_secret_pass_123@localhost:55432/test_nexus_journal';

describe('Nexus V2.3-R3 — Commit R3-6: Multi-Leg Fill Identity & Atomic Application', () => {
  let pool: Pool;
  let pgPosRepo: PostgresPositionRepository;
  let pgJournalRepo: PostgresJournalRepository;

  before(async () => {
    pool = new Pool({ connectionString: TEST_DB_URL, max: 5 });
    pgPosRepo = new PostgresPositionRepository(pool);
    pgJournalRepo = new PostgresJournalRepository({ pool });

    // Apply migrations 001, 002, 003, 004
    for (const mig of [
      'migrations/001_v2_1_durable_exit_journal.sql',
      'migrations/002_v2_3_position_versioning.sql',
      'migrations/003_v2_3_system_audit_and_constraints.sql',
      'migrations/004_v2_3_position_multi_leg_and_fks.sql'
    ]) {
      const sql = fs.readFileSync(path.resolve(process.cwd(), mig), 'utf8');
      await pool.query(sql);
    }
  });

  after(async () => {
    if (pool) await pool.end();
  });

  it('1. Finding 29 (In-Memory): Multi-leg fills with identical signature apply cleanly without false dedupe', async () => {
    const memRepo = new InMemoryPositionRepository();
    const pos = await memRepo.createPosition({
      positionId: 'pos-multi-mem-1',
      tradeId: 'trade-multi-1',
      walletId: 'wallet-multi-1',
      mint: 'MintMultiLeg11111111111111111111111111111',
      initialAmountAtomic: 10_000n,
      initialPrincipalLamports: 1_000_000n
    });

    const sharedSig = 'sig_shared_tx_multi_leg_123';

    // Leg 0: debits 4,000
    const resLeg0 = await memRepo.applyConfirmedFill({
      positionId: pos.positionId,
      expectedVersion: 1n,
      fillId: 'fill-leg-0',
      signature: sharedSig,
      chainLegIndex: 0,
      instructionIndex: 2,
      innerInstructionIndex: -1,
      confirmedActualDebitAtomic: 4_000n,
      grossProceedsLamports: 400_000n
    });

    assert.strictEqual(resLeg0.alreadyApplied, false);
    assert.strictEqual(resLeg0.position.tokenAmountAtomic, 6_000n);
    assert.strictEqual(resLeg0.position.positionVersion, 2n);

    // Leg 1: same transaction signature, debits 3,000 (chainLegIndex: 1)
    // Finding 29: MUST NOT be blocked as a duplicate fill!
    const resLeg1 = await memRepo.applyConfirmedFill({
      positionId: pos.positionId,
      expectedVersion: 2n,
      fillId: 'fill-leg-1',
      signature: sharedSig,
      chainLegIndex: 1,
      instructionIndex: 4,
      innerInstructionIndex: -1,
      confirmedActualDebitAtomic: 3_000n,
      grossProceedsLamports: 300_000n
    });

    assert.strictEqual(resLeg1.alreadyApplied, false);
    assert.strictEqual(resLeg1.position.tokenAmountAtomic, 3_000n);
    assert.strictEqual(resLeg1.position.positionVersion, 3n);

    // Replay Leg 0: MUST return alreadyApplied = true and NOT debit again
    const replayLeg0 = await memRepo.applyConfirmedFill({
      positionId: pos.positionId,
      expectedVersion: 3n,
      fillId: 'fill-leg-0',
      signature: sharedSig,
      chainLegIndex: 0,
      instructionIndex: 2,
      innerInstructionIndex: -1,
      confirmedActualDebitAtomic: 4_000n,
      grossProceedsLamports: 400_000n
    });

    assert.strictEqual(replayLeg0.alreadyApplied, true);
    assert.strictEqual(replayLeg0.position.tokenAmountAtomic, 3_000n);
    assert.strictEqual(replayLeg0.position.positionVersion, 3n);
  });

  it('2. Finding 29 (PostgreSQL): Multi-leg fills in real Postgres with composite leg identity', async () => {
    const testPosId = `pos-multi-pg-${Date.now()}`;
    const testTradeId = `trade-multi-pg-${Date.now()}`;
    const testMint = `MintPgMulti-${Date.now()}`;

    const pos = await pgPosRepo.createPosition({
      positionId: testPosId,
      tradeId: testTradeId,
      walletId: 'wallet-multi-pg',
      mint: testMint,
      initialAmountAtomic: 20_000n,
      initialPrincipalLamports: 2_000_000n
    });

    const sharedSig = `sig_pg_multi_${Date.now()}`;

    // Leg 0: debits 8,000
    const resLeg0 = await pgPosRepo.applyConfirmedFill({
      positionId: pos.positionId,
      expectedVersion: 1n,
      fillId: `fill-pg-0-${Date.now()}`,
      signature: sharedSig,
      chainLegIndex: 0,
      instructionIndex: 1,
      innerInstructionIndex: -1,
      confirmedActualDebitAtomic: 8_000n,
      grossProceedsLamports: 800_000n
    });

    assert.strictEqual(resLeg0.alreadyApplied, false);
    assert.strictEqual(resLeg0.position.tokenAmountAtomic, 12_000n);
    assert.strictEqual(resLeg0.position.positionVersion, 2n);

    // Leg 1: same transaction signature, debits 5,000 (chainLegIndex: 1)
    const resLeg1 = await pgPosRepo.applyConfirmedFill({
      positionId: pos.positionId,
      expectedVersion: 2n,
      fillId: `fill-pg-1-${Date.now()}`,
      signature: sharedSig,
      chainLegIndex: 1,
      instructionIndex: 3,
      innerInstructionIndex: -1,
      confirmedActualDebitAtomic: 5_000n,
      grossProceedsLamports: 500_000n
    });

    assert.strictEqual(resLeg1.alreadyApplied, false);
    assert.strictEqual(resLeg1.position.tokenAmountAtomic, 7_000n);
    assert.strictEqual(resLeg1.position.positionVersion, 3n);

    // Replay Leg 1: returns alreadyApplied = true and does not change balance
    const replayLeg1 = await pgPosRepo.applyConfirmedFill({
      positionId: pos.positionId,
      expectedVersion: 3n,
      fillId: resLeg1.mutation.fillId!,
      signature: sharedSig,
      chainLegIndex: 1,
      instructionIndex: 3,
      innerInstructionIndex: -1,
      confirmedActualDebitAtomic: 5_000n,
      grossProceedsLamports: 500_000n
    });

    assert.strictEqual(replayLeg1.alreadyApplied, true);
    assert.strictEqual(replayLeg1.position.tokenAmountAtomic, 7_000n);
  });

  it('3. Finding 27: applyConfirmedFillAtomically enforces Fill signature == Attempt signature', async () => {
    const testPosId = `pos-sig-mismatch-${Date.now()}`;
    const testTradeId = `trade-sig-mismatch-${Date.now()}`;
    const testMint = `MintSigMismatch-${Date.now()}`;

    const pos = await pgPosRepo.createPosition({
      positionId: testPosId,
      tradeId: testTradeId,
      walletId: 'wallet-sig-test',
      mint: testMint,
      initialAmountAtomic: 5_000n,
      initialPrincipalLamports: 500_000n
    });

    const { intent } = await pgJournalRepo.createOrGetIntent({
      id: `intent-sig-${Date.now()}` as any,
      tradeId: testTradeId as any,
      positionId: testPosId as any,
      walletId: 'wallet-sig-test',
      mint: testMint,
      tokenProgram: pos.tokenProgram,
      positionVersion: 1n,
      requestedAmountAtomic: '5000',
      amountPolicy: 'FULL_REMAINDER',
      initialSeverity: 'NORMAL',
      reason: 'TAKE_PROFIT',
      policyVersion: 'v2'
    });

    const claimed = await pgJournalRepo.claimIntent({
      intentId: intent.id,
      workerId: 'worker-sig',
      leaseDurationMs: 60_000
    });

    const attempt = await pgJournalRepo.prepareAttempt({
      attemptId: `att-sig-${Date.now()}` as any,
      intentId: intent.id,
      provider: 'JUPITER_V2',
      requestedAmountAtomic: '5000',
      initialState: 'ORDER_READY'
    }, claimed!.claimEpoch);

    const attemptSig = `sig_attempt_${Date.now()}`;
    await pgJournalRepo.updateAttemptState(
      attempt.attemptId,
      'SUBMITTED',
      { signature: attemptSig as any },
      claimed!.claimEpoch
    );

    const differentFillSig = `sig_fill_different_${Date.now()}`;
    const fillPayload: FillRecord = {
      id: `fill-mismatch-${Date.now()}` as any,
      tradeId: testTradeId as any,
      positionId: testPosId as any,
      intentId: intent.id,
      attemptId: attempt.attemptId,
      signature: differentFillSig as any, // MISMATCH!
      realizationSequence: 1,
      chainLegIndex: 0,
      instructionIndex: 2,
      innerInstructionIndex: -1,
      requestedAmountAtomic: '5000',
      actualAmountAtomic: '5000',
      grossProceedsLamports: '600000',
      networkFeeLamports: '5000',
      priorityFeeLamports: '0',
      tipLamports: '0',
      rentMovementLamports: '0',
      evidenceType: 'CHAIN_ECONOMIC_EVIDENCE',
      confirmedAtWallMs: Date.now() as any,
      createdAtWallMs: Date.now() as any
    };

    await assert.rejects(
      () => applyConfirmedFillAtomically({
        pool,
        journalRepo: pgJournalRepo,
        positionRepo: pgPosRepo,
        fill: fillPayload,
        expectedEpoch: claimed!.claimEpoch,
        expectedPositionVersion: 1n
      }),
      (err: any) => err instanceof EconomicIdentityMismatchError && err.message.includes('signature'),
      'Must reject fill when fill.signature does not match attempt.signature'
    );
  });

  it('4. Finding 31: applyConfirmedFillAtomically validates attempt state transitions (rejects ORDER_READY)', async () => {
    const testPosId = `pos-state-test-${Date.now()}`;
    const testTradeId = `trade-state-test-${Date.now()}`;
    const testMint = `MintStateTest-${Date.now()}`;

    const pos = await pgPosRepo.createPosition({
      positionId: testPosId,
      tradeId: testTradeId,
      walletId: 'wallet-state-test',
      mint: testMint,
      initialAmountAtomic: 5_000n,
      initialPrincipalLamports: 500_000n
    });

    const { intent } = await pgJournalRepo.createOrGetIntent({
      id: `intent-state-${Date.now()}` as any,
      tradeId: testTradeId as any,
      positionId: testPosId as any,
      walletId: 'wallet-state-test',
      mint: testMint,
      tokenProgram: pos.tokenProgram,
      positionVersion: 1n,
      requestedAmountAtomic: '5000',
      amountPolicy: 'FULL_REMAINDER',
      initialSeverity: 'NORMAL',
      reason: 'TAKE_PROFIT',
      policyVersion: 'v2'
    });

    const claimed = await pgJournalRepo.claimIntent({
      intentId: intent.id,
      workerId: 'worker-state',
      leaseDurationMs: 60_000
    });

    // Attempt remains in ORDER_READY (not SUBMITTED or SENT or UNKNOWN)
    const attempt = await pgJournalRepo.prepareAttempt({
      attemptId: `att-state-${Date.now()}` as any,
      intentId: intent.id,
      provider: 'JUPITER_V2',
      requestedAmountAtomic: '5000',
      initialState: 'ORDER_READY'
    }, claimed!.claimEpoch);

    const fillPayload: FillRecord = {
      id: `fill-state-${Date.now()}` as any,
      tradeId: testTradeId as any,
      positionId: testPosId as any,
      intentId: intent.id,
      attemptId: attempt.attemptId,
      signature: `sig-state-${Date.now()}` as any,
      realizationSequence: 1,
      chainLegIndex: 0,
      instructionIndex: 2,
      innerInstructionIndex: -1,
      requestedAmountAtomic: '5000',
      actualAmountAtomic: '5000',
      grossProceedsLamports: '600000',
      networkFeeLamports: '5000',
      priorityFeeLamports: '0',
      tipLamports: '0',
      rentMovementLamports: '0',
      evidenceType: 'CHAIN_ECONOMIC_EVIDENCE',
      confirmedAtWallMs: Date.now() as any,
      createdAtWallMs: Date.now() as any
    };

    await assert.rejects(
      () => applyConfirmedFillAtomically({
        pool,
        journalRepo: pgJournalRepo,
        positionRepo: pgPosRepo,
        fill: fillPayload,
        expectedEpoch: claimed!.claimEpoch,
        expectedPositionVersion: 1n
      }),
      (err: any) => err instanceof IllegalStateTransitionError && err.message.includes('ORDER_READY'),
      'Must reject transition from ORDER_READY directly to CONFIRMED'
    );
  });

  it('5. Finding 33: Administrative correction requires evidence and appends to system_audit_events in PostgreSQL', async () => {
    const testPosId = `pos-admin-pg-${Date.now()}`;
    const testTradeId = `trade-admin-pg-${Date.now()}`;
    const testMint = `MintAdminPg-${Date.now()}`;

    const pos = await pgPosRepo.createPosition({
      positionId: testPosId,
      tradeId: testTradeId,
      walletId: 'wallet-admin-pg',
      mint: testMint,
      initialAmountAtomic: 10_000n,
      initialPrincipalLamports: 1_000_000n
    });

    // Rejection without evidence
    await assert.rejects(
      () => pgPosRepo.applyExplicitAdministrativeCorrection({
        positionId: pos.positionId,
        expectedVersion: 1n,
        newAmountAtomic: 8_000n,
        actor: 'senior_ops',
        reason: 'Manual custody adjustment',
        evidence: '' // Empty evidence!
      }),
      ArbitraryBalanceMutationRejectedError
    );

    // Success with evidence
    const correctionRes = await pgPosRepo.administrativeCorrectionWithEvidence({
      positionId: pos.positionId,
      expectedVersion: 1n,
      newAmountAtomic: 8_000n,
      actor: 'senior_ops',
      reason: 'Physical wallet discrepancy adjustment',
      evidence: 'solana-fm-tx-proof-987654'
    });

    assert.strictEqual(correctionRes.position.tokenAmountAtomic, 8_000n);
    assert.strictEqual(correctionRes.position.positionVersion, 2n);

    // Verify append-only record in system_audit_events table
    const auditRes = await pool.query(
      `SELECT * FROM system_audit_events WHERE entity_id = $1 AND entity_type = 'Position'`,
      [pos.positionId]
    );
    assert.strictEqual(auditRes.rows.length, 1);
    assert.strictEqual(auditRes.rows[0].actor, 'senior_ops');
    assert.ok(auditRes.rows[0].reason.includes('solana-fm-tx-proof-987654'));
    assert.strictEqual(auditRes.rows[0].before_state, '10000');
    assert.strictEqual(auditRes.rows[0].after_state, '8000');
  });

  it('6. Finding 30: recordFill alone does NOT mark parent intent APPLIED', async () => {
    const testIntentId = `intent-recfill-${Date.now()}`;
    const testTradeId = `trade-recfill-${Date.now()}`;
    const testPosId = `pos-recfill-${Date.now()}`;
    const testMint = `MintRecFill-${Date.now()}`;

    const { intent } = await pgJournalRepo.createOrGetIntent({
      id: testIntentId as any,
      tradeId: testTradeId as any,
      positionId: testPosId as any,
      walletId: 'wallet-recfill',
      mint: testMint,
      tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      requestedAmountAtomic: '5000',
      amountPolicy: 'FULL_REMAINDER',
      initialSeverity: 'HIGH',
      reason: 'STOP_LOSS',
      policyVersion: 'v2'
    });

    const claimed = await pgJournalRepo.claimIntent({
      intentId: intent.id,
      workerId: 'worker-recfill',
      leaseDurationMs: 60_000
    });

    const attempt = await pgJournalRepo.prepareAttempt({
      attemptId: `att-recfill-${Date.now()}` as any,
      intentId: intent.id,
      provider: 'JUPITER_V2',
      requestedAmountAtomic: '5000',
      initialState: 'ORDER_READY'
    }, claimed!.claimEpoch);

    await pgJournalRepo.updateAttemptState(
      attempt.attemptId,
      'SUBMITTED',
      { signature: `sig-recfill-${Date.now()}` as any },
      claimed!.claimEpoch
    );

    // Call recordFill directly (observational fill ingestion)
    await pgJournalRepo.recordFill({
      id: `fill-recfill-${Date.now()}` as any,
      tradeId: testTradeId as any,
      positionId: testPosId as any,
      intentId: intent.id,
      attemptId: attempt.attemptId,
      signature: `sig-recfill-${Date.now()}` as any,
      realizationSequence: 1,
      chainLegIndex: 0,
      instructionIndex: 2,
      innerInstructionIndex: -1,
      requestedAmountAtomic: '5000',
      actualAmountAtomic: '5000',
      grossProceedsLamports: '500000',
      networkFeeLamports: '5000',
      priorityFeeLamports: '0',
      tipLamports: '0',
      rentMovementLamports: '0',
      evidenceType: 'CHAIN_ECONOMIC_EVIDENCE',
      confirmedAtWallMs: Date.now() as any,
      createdAtWallMs: Date.now() as any
    }, claimed!.claimEpoch);

    // Parent intent MUST NOT be moved to APPLIED by recordFill alone!
    const updatedIntent = await pgJournalRepo.getIntentById(intent.id);
    assert.notStrictEqual(updatedIntent?.status, 'APPLIED', 'recordFill alone must not mark intent as APPLIED');
  });
});
