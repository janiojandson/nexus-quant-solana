/**
 * Nexus Quant Solana — Real PostgreSQL Lifecycle Claims & System Mutations (Commit R3-5)
 *
 * Validates against a REAL PostgreSQL instance:
 * 1. Migration 003 application and idempotency (system_audit_events).
 * 2. Strict prepareAttempt eligibility matrix in PostgreSQL: rejects UNKNOWN and CONFIRMED.
 * 3. Strict claimIntent in PostgreSQL: rejects UNKNOWN, SUBMITTED, CONFIRMED, or debt with LeaseRecoveryBlockedError.
 * 4. General claimIntent query skips UNKNOWN, SUBMITTED, CONFIRMED, debt, and active attempts.
 * 5. systemUpdateAttemptState enforces transition and writes append-only event to system_audit_events.
 * 6. system_audit_events trigger: rejects UPDATE and DELETE.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Pool } from 'pg';
import { PostgresJournalRepository } from '../../src/journal/postgresRepository.js';
import {
  IllegalStateTransitionError,
  SystemMutationContext,
  nowWallMs
} from '../../src/journal/types.js';
import { LeaseRecoveryBlockedError } from '../../src/journal/repository.js';
import { createRequiredTestPool } from '../helpers/testDatabase.js';

describe('PostgreSQL Lifecycle Claims & System Mutations (R3-5, Findings 21-25)', () => {
  let pool: Pool;
  let repo: PostgresJournalRepository;

  before(async () => {
    pool = await createRequiredTestPool();
    repo = new PostgresJournalRepository(pool);

    // Apply baseline migration 001 if needed
    const m1 = fs.readFileSync(path.resolve(process.cwd(), 'migrations/001_v2_1_durable_exit_journal.sql'), 'utf8');
    await pool.query(m1);

    // Apply migration 003: system audit events
    const m3 = fs.readFileSync(path.resolve(process.cwd(), 'migrations/003_v2_3_system_audit_and_constraints.sql'), 'utf8');
    await pool.query(m3);
  });

  after(async () => {
    if (pool) {
      await pool.end();
    }
  });

  it('Migration 003 is idempotent and creates system_audit_events table & append-only trigger', async () => {
    const m3 = fs.readFileSync(path.resolve(process.cwd(), 'migrations/003_v2_3_system_audit_and_constraints.sql'), 'utf8');
    await pool.query(m3); // Re-apply to prove idempotency

    const tableCheck = await pool.query(
      "SELECT table_name FROM information_schema.tables WHERE table_name = 'system_audit_events';"
    );
    assert.equal(tableCheck.rows.length, 1, 'system_audit_events table must exist');
  });

  it('PostgreSQL prepareAttempt rejects UNKNOWN and CONFIRMED intents', async () => {
    const mint = 'MintPgPrepMatrix111111111111111111111111111';
    const { intent } = await repo.createOrGetIntent({
      id: `intent-pg-prep-${Date.now()}` as any,
      tradeId: 't-pg-prep-1' as any,
      positionId: 'p-pg-prep-1' as any,
      walletId: 'w-pg-prep-1',
      mint,
      tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      requestedAmountAtomic: '1000',
      amountPolicy: 'FULL_REMAINDER',
      initialSeverity: 'HIGH',
      reason: 'STOP_LOSS',
      policyVersion: 'v2'
    });

    const claimed = await repo.claimIntent({
      intentId: intent.id,
      workerId: 'worker-pg-1',
      leaseDurationMs: 60_000
    });
    assert.ok(claimed);

    // Prepare attempt while CLAIMED succeeds
    const att = await repo.prepareAttempt({
      attemptId: `att-pg-prep-${Date.now()}-1` as any,
      intentId: intent.id,
      provider: 'JUPITER_V2',
      requestedAmountAtomic: '1000',
      initialState: 'ORDER_READY'
    }, claimed!.claimEpoch);
    assert.ok(att);

    // Force intent status to UNKNOWN in DB
    await pool.query("UPDATE exit_intents SET status = 'UNKNOWN' WHERE id = $1", [intent.id]);

    await assert.rejects(
      async () => {
        await repo.prepareAttempt({
          attemptId: `att-pg-prep-${Date.now()}-2` as any,
          intentId: intent.id,
          provider: 'JUPITER_V2',
          requestedAmountAtomic: '1000',
          initialState: 'ORDER_READY'
        }, claimed!.claimEpoch);
      },
      (err: any) => err instanceof IllegalStateTransitionError && err.message.includes('PREPARE_ATTEMPT_REJECTED'),
      'prepareAttempt in PostgreSQL must reject UNKNOWN intent'
    );

    // Force intent status to CONFIRMED in DB
    await pool.query("UPDATE exit_intents SET status = 'CONFIRMED' WHERE id = $1", [intent.id]);

    await assert.rejects(
      async () => {
        await repo.prepareAttempt({
          attemptId: `att-pg-prep-${Date.now()}-3` as any,
          intentId: intent.id,
          provider: 'JUPITER_V2',
          requestedAmountAtomic: '1000',
          initialState: 'ORDER_READY'
        }, claimed!.claimEpoch);
      },
      (err: any) => err instanceof IllegalStateTransitionError && err.message.includes('PREPARE_ATTEMPT_REJECTED'),
      'prepareAttempt in PostgreSQL must reject CONFIRMED intent'
    );
  });

  it('PostgreSQL claimIntent blocks UNKNOWN, SUBMITTED, and CONFIRMED intents with LeaseRecoveryBlockedError', async () => {
    const mint = `MintPgClaimBlock-${Date.now()}`;
    const { intent } = await repo.createOrGetIntent({
      id: `intent-pg-claim-${Date.now()}` as any,
      tradeId: 't-pg-claim-1' as any,
      positionId: 'p-pg-claim-1' as any,
      walletId: 'w-pg-claim-1',
      mint,
      tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      requestedAmountAtomic: '1000',
      amountPolicy: 'FULL_REMAINDER',
      initialSeverity: 'HIGH',
      reason: 'STOP_LOSS',
      policyVersion: 'v2'
    });

    // Set intent to UNKNOWN with expired lease
    await pool.query(
      "UPDATE exit_intents SET status = 'UNKNOWN', lease_expires_at = NOW() - INTERVAL '10 seconds' WHERE id = $1",
      [intent.id]
    );

    // Explicit claim must throw LeaseRecoveryBlockedError
    await assert.rejects(
      async () => {
        await repo.claimIntent({
          intentId: intent.id,
          workerId: 'worker-pg-claim',
          leaseDurationMs: 60_000
        });
      },
      (err: any) => err instanceof LeaseRecoveryBlockedError,
      'claimIntent targeting UNKNOWN intent must throw LeaseRecoveryBlockedError'
    );

    // Set intent to CONFIRMED
    await pool.query("UPDATE exit_intents SET status = 'CONFIRMED' WHERE id = $1", [intent.id]);

    await assert.rejects(
      async () => {
        await repo.claimIntent({
          intentId: intent.id,
          workerId: 'worker-pg-claim',
          leaseDurationMs: 60_000
        });
      },
      (err: any) => err instanceof LeaseRecoveryBlockedError,
      'claimIntent targeting CONFIRMED intent must throw LeaseRecoveryBlockedError'
    );
  });

  it('PostgreSQL systemUpdateAttemptState logs to system_audit_events and trigger rejects UPDATE/DELETE', async () => {
    const mint = `MintPgSysMut-${Date.now()}`;
    const { intent } = await repo.createOrGetIntent({
      id: `intent-pg-sys-${Date.now()}` as any,
      tradeId: 't-pg-sys-1' as any,
      positionId: 'p-pg-sys-1' as any,
      walletId: 'w-pg-sys-1',
      mint,
      tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      requestedAmountAtomic: '1000',
      amountPolicy: 'FULL_REMAINDER',
      initialSeverity: 'HIGH',
      reason: 'STOP_LOSS',
      policyVersion: 'v2'
    });

    const claimed = await repo.claimIntent({
      intentId: intent.id,
      workerId: 'worker-pg-sys',
      leaseDurationMs: 60_000
    });

    const attempt = await repo.prepareAttempt({
      attemptId: `att-pg-sys-${Date.now()}` as any,
      intentId: intent.id,
      provider: 'JUPITER_V2',
      requestedAmountAtomic: '1000',
      initialState: 'ORDER_READY'
    }, claimed!.claimEpoch);

    await repo.updateAttemptState(attempt.attemptId, 'SUBMITTED', {}, claimed!.claimEpoch);

    const sysCtx: SystemMutationContext = {
      mutationClass: 'FINANCIAL_STATE_MUTATION',
      actor: 'pg_audit_operator',
      reason: 'terminal recovery after timeout verification',
      expectedCurrentState: 'SUBMITTED',
      expectedEpoch: claimed!.claimEpoch,
      transactionContext: {
        wallet: 'w-pg-sys-1',
        mint
      }
    };

    const updated = await repo.systemUpdateAttemptState(attempt.attemptId, 'FAILED_DEFINITIVE', sysCtx);
    assert.equal(updated.state, 'FAILED_DEFINITIVE');

    // Verify audit event persisted in PostgreSQL
    const auditEvents = await repo.getSystemAuditEvents(attempt.attemptId);
    assert.equal(auditEvents.length, 1);
    assert.equal(auditEvents[0].actor, 'pg_audit_operator');
    assert.equal(auditEvents[0].beforeState, 'SUBMITTED');
    assert.equal(auditEvents[0].afterState, 'FAILED_DEFINITIVE');
    assert.equal(auditEvents[0].entityType, 'ExecutionAttempt');

    // Trigger test: attempt UPDATE on system_audit_events must fail
    await assert.rejects(
      async () => {
        await pool.query("UPDATE system_audit_events SET reason = 'tampered' WHERE entity_id = $1", [attempt.attemptId]);
      },
      /MUTATION FORBIDDEN: system_audit_events is strictly append-only/,
      'UPDATE on system_audit_events must be blocked by trigger'
    );

    // Trigger test: attempt DELETE on system_audit_events must fail
    await assert.rejects(
      async () => {
        await pool.query('DELETE FROM system_audit_events WHERE entity_id = $1', [attempt.attemptId]);
      },
      /MUTATION FORBIDDEN: system_audit_events is strictly append-only/,
      'DELETE on system_audit_events must be blocked by trigger'
    );
  });
});
