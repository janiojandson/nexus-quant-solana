/**
 * Nexus Quant Solana — V2.1B PostgresJournalRepository
 *
 * PostgreSQL implementation of IExitJournalRepository:
 * - Real transaction semantics with Pool / PoolClient.
 * - FOR UPDATE SKIP LOCKED claim concurrency.
 * - Fencing Epoch validation (UPDATE ... WHERE claim_epoch = $expectedEpoch).
 * - Partial unique index enforcement and ActiveIntentExclusionError mapping.
 * - Append-only fill ledger insertion with idempotent deduplication.
 * - Reconciliation debt tracking on active on-chain attempts.
 */

import { Pool, PoolClient } from 'pg';
import {
  IExitJournalRepository,
  CreateIntentInput,
  PrepareAttemptInput,
  ClaimIntentInput,
  EconomicConflictError,
  AppendOnlyViolationError,
  LeaseRecoveryBlockedError
} from './repository';
import {
  ExitIntent,
  ExitIntentId,
  ExitIntentStatus,
  ExitIntentSeverity,
  ExitIntentReason,
  ExecutionAttempt,
  ExecutionAttemptId,
  ExecutionAttemptState,
  FillRecord,
  FillId,
  IntentSeverityEvent,
  ExecutionReconciliationEvent,
  TradeId,
  PositionId,
  WallMs,
  nowWallMs,
  nowMonotonicNs,
  computeEconomicDedupeKey,
  isIntentEconomicallyActive,
  isIntentTerminal,
  StaleEpochError,
  ActiveIntentExclusionError,
  EpochRequiredError,
  IllegalStateTransitionError,
  assertValidIntentTransition,
  assertValidAttemptTransition,
  hasPotentiallyLiveChainAttempt,
  assertCanPrepareAttemptForIntent,
  SystemMutationContext,
  assertValidSystemMutationContext,
  SystemAuditEvent
} from './types';


export interface PostgresJournalRepositoryConfig {
  pool: Pool;
}

export class PostgresJournalRepository implements IExitJournalRepository {
  private pool: Pool;

  constructor(config: PostgresJournalRepositoryConfig | Pool | any) {
    if (config && typeof config === 'object' && 'pool' in config && config.pool) {
      this.pool = config.pool;
    } else {
      this.pool = config as Pool;
    }
  }

  public getPool(): Pool {
    return this.pool;
  }

  public async createOrGetIntent(
    input: CreateIntentInput
  ): Promise<{ intent: ExitIntent; created: boolean }> {
    const dedupeKey = computeEconomicDedupeKey({
      walletId: input.walletId,
      mint: input.mint,
      positionVersion: input.positionVersion,
      requestedAmountAtomic: input.requestedAmountAtomic,
      amountPolicy: input.amountPolicy
    });

    // 1. Check existing by dedupeKey
    const existing = await this.getIntentByDedupeKey(dedupeKey);
    if (existing) {
      const sameWallet = existing.walletId === input.walletId;
      const sameMint = existing.mint === input.mint;
      const sameAmount = existing.requestedAmountAtomic === input.requestedAmountAtomic;
      const samePolicy = existing.amountPolicy === input.amountPolicy;

      if (!sameWallet || !sameMint || !sameAmount || !samePolicy) {
        throw new EconomicConflictError(
          `Economic intent dedupe key collision with conflicting parameters for key ${dedupeKey}`,
          dedupeKey,
          { walletId: input.walletId, mint: input.mint, amount: input.requestedAmountAtomic, policy: input.amountPolicy }
        );
      }
      return { intent: existing, created: false };
    }

    // 2. Active Intent Exclusion check on same (wallet_id, mint)
    const activeRes = await this.pool.query(
      `SELECT id, status, reconciliation_debt FROM exit_intents
       WHERE wallet_id = $1 AND mint = $2
         AND (status NOT IN ('APPLIED', 'CANCELLED', 'SUPERSEDED', 'FAILED_DEFINITIVE') OR reconciliation_debt = true)
       LIMIT 1`,
      [input.walletId, input.mint]
    );

    if (activeRes.rows.length > 0) {
      const activeRow = activeRes.rows[0];
      throw new ActiveIntentExclusionError(
        `Active intent ${activeRow.id} already exists for wallet ${input.walletId} and mint ${input.mint} in status '${activeRow.status}' (reconciliationDebt=${activeRow.reconciliation_debt}). Competing intent rejected.`,
        input.walletId,
        input.mint,
        activeRow.id,
        activeRow.status as ExitIntentStatus
      );
    }

    const now = (input.nowMs ?? nowWallMs()) as WallMs;
    const ttlMs = input.expiresInMs ?? 60_000;
    const expiresAt = (Number(now) + ttlMs) as WallMs;
    const id = (input.id || `intent_${now}_${Math.random().toString(36).slice(2, 8)}`) as ExitIntentId;

    try {
      const insertSql = `
        INSERT INTO exit_intents (
          id, trade_id, position_id, wallet_id, mint, token_program, position_version,
          requested_amount_atomic, amount_policy, initial_severity, current_severity,
          reason, policy_version, economic_dedupe_key, claimed_by, claim_epoch,
          claimed_at, lease_expires_at, created_at, expires_at, status, superseded_by, reconciliation_debt
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NULL, 0,
          NULL, NULL, to_timestamp($15 / 1000.0), to_timestamp($16 / 1000.0), 'CREATED', NULL, false
        )
        ON CONFLICT (economic_dedupe_key) DO NOTHING
        RETURNING *;
      `;

      const res = await this.pool.query(insertSql, [
        id,
        input.tradeId,
        input.positionId,
        input.walletId,
        input.mint,
        input.tokenProgram,
        input.positionVersion !== null && input.positionVersion !== undefined ? String(input.positionVersion) : null,
        input.requestedAmountAtomic,
        input.amountPolicy,
        input.initialSeverity,
        input.initialSeverity,
        input.reason,
        input.policyVersion,
        dedupeKey,
        now,
        expiresAt
      ]);

      if (res.rows.length === 0) {
        // Concurrently inserted by another process
        const dup = await this.getIntentByDedupeKey(dedupeKey);
        if (dup) return { intent: dup, created: false };
      }

      return { intent: this.mapRowToIntent(res.rows[0]), created: true };
    } catch (err: any) {
      if (err?.code === '23505' && (err.constraint === 'uq_active_intent_wallet_mint' || err.message?.includes('uq_active_intent_wallet_mint'))) {
        throw new ActiveIntentExclusionError(
          `Active intent already exists on (wallet, mint) constraint: ${err.message}`,
          input.walletId,
          input.mint,
          'concurrent_active',
          'CREATED'
        );
      }
      throw err;
    }
  }

  public async getIntentById(id: string): Promise<ExitIntent | null> {
    const res = await this.pool.query('SELECT * FROM exit_intents WHERE id = $1', [id]);
    if (res.rows.length === 0) return null;
    return this.mapRowToIntent(res.rows[0]);
  }

  public async getIntentByDedupeKey(dedupeKey: string): Promise<ExitIntent | null> {
    const res = await this.pool.query('SELECT * FROM exit_intents WHERE economic_dedupe_key = $1', [dedupeKey]);
    if (res.rows.length === 0) return null;
    return this.mapRowToIntent(res.rows[0]);
  }

  public async updateIntentSeverity(
    intentId: string,
    newSeverity: ExitIntentSeverity,
    reason: ExitIntentReason,
    observationId?: string,
    expectedEpoch?: bigint | number
  ): Promise<IntentSeverityEvent> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const intentRes = await client.query('SELECT * FROM exit_intents WHERE id = $1 FOR UPDATE', [intentId]);
      if (intentRes.rows.length === 0) {
        throw new Error(`ExitIntent not found: ${intentId}`);
      }
      const intentRow = intentRes.rows[0];

      if (expectedEpoch === undefined || expectedEpoch === null) {
        throw new EpochRequiredError('expectedEpoch is mandatory for worker-owned mutations to enforce fencing');
      }

      if (BigInt(intentRow.claim_epoch) !== BigInt(expectedEpoch)) {
        throw new StaleEpochError(
          `Stale claim epoch for intent ${intentId}: expected ${expectedEpoch}, actual ${intentRow.claim_epoch}`,
          intentId,
          BigInt(expectedEpoch),
          BigInt(intentRow.claim_epoch)
        );
      }

      const now = nowWallMs();
      const monoNs = nowMonotonicNs();

      const insertEvent = `
        INSERT INTO intent_severity_events (
          intent_id, from_severity, to_severity, reason, observation_id, changed_at, changed_at_mono_ns
        ) VALUES (
          $1, $2, $3, $4, $5, to_timestamp($6 / 1000.0), $7
        ) RETURNING id;
      `;
      const evRes = await client.query(insertEvent, [
        intentId,
        intentRow.current_severity,
        newSeverity,
        reason,
        observationId || null,
        now,
        String(monoNs)
      ]);

      await client.query(
        'UPDATE exit_intents SET current_severity = $1, reason = $2 WHERE id = $3',
        [newSeverity, reason, intentId]
      );

      await client.query('COMMIT');

      return {
        id: evRes.rows[0]?.id,
        intentId: intentId as ExitIntentId,
        fromSeverity: intentRow.current_severity as ExitIntentSeverity,
        toSeverity: newSeverity,
        reason,
        observationId,
        changedAtWallMs: now,
        changedAtMonoNs: monoNs
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  public async claimIntent(input: ClaimIntentInput): Promise<ExitIntent | null> {
    const now = input.nowMs ?? nowWallMs();
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      if (input.intentId) {
        // Explicit intent claim
        const candRes = await client.query(
          `SELECT * FROM exit_intents WHERE id = $1 FOR UPDATE SKIP LOCKED;`,
          [input.intentId]
        );
        if (candRes.rows.length === 0) {
          await client.query('COMMIT');
          return null;
        }
        const cand = candRes.rows[0];

        // Terminal states cannot be claimed
        if (['APPLIED', 'CANCELLED', 'SUPERSEDED', 'FAILED_DEFINITIVE'].includes(cand.status)) {
          await client.query('COMMIT');
          return null;
        }

        // UNKNOWN, SUBMITTED, SIGNED, CONFIRMED, or reconciliation_debt CANNOT be reclaimed for resend!
        if (['UNKNOWN', 'SUBMITTED', 'SIGNED', 'CONFIRMED'].includes(cand.status) || cand.reconciliation_debt) {
          await client.query('ROLLBACK');
          const blockingState = ['UNKNOWN', 'SUBMITTED', 'SIGNED', 'CONFIRMED'].includes(cand.status)
            ? cand.status
            : 'RECONCILIATION_DEBT';
          throw new LeaseRecoveryBlockedError(
            `Lease recovery blocked for intent ${cand.id}: intent is in non-reclaimable state '${cand.status}' or has active reconciliation debt. Must reconcile before re-claim.`,
            cand.id,
            blockingState
          );
        }

        // Check if any existing attempt reached on-chain / active state
        const attRes = await client.query(
          `SELECT attempt_id, state FROM execution_attempts
           WHERE intent_id = $1 AND state IN ('SIGNED', 'SUBMITTED', 'UNKNOWN', 'SENT')
           LIMIT 1;`,
          [cand.id]
        );
        if (attRes.rows.length > 0) {
          const blockingState = attRes.rows[0].state;
          await client.query('ROLLBACK');
          throw new LeaseRecoveryBlockedError(
            `Lease recovery blocked for intent ${cand.id}: attempt ${attRes.rows[0].attempt_id} is in active on-chain state '${blockingState}'. Must reconcile before re-claim.`,
            cand.id,
            blockingState
          );
        }

        // If not CREATED, must have expired lease to be reclaimable
        if (cand.status !== 'CREATED') {
          const expTime = cand.lease_expires_at ? new Date(cand.lease_expires_at).getTime() : 0;
          if (expTime >= now) {
            await client.query('COMMIT');
            return null; // Lease not yet expired
          }
        }

        const leaseExpiresAt = now + input.leaseDurationMs;
        const updateSql = `
          UPDATE exit_intents
          SET claimed_by = $1,
              claim_epoch = claim_epoch + 1,
              claimed_at = to_timestamp($2 / 1000.0),
              lease_expires_at = to_timestamp($3 / 1000.0),
              status = 'CLAIMED'
          WHERE id = $4 AND claim_epoch = $5
          RETURNING *;
        `;
        const upRes = await client.query(updateSql, [
          input.workerId,
          now,
          leaseExpiresAt,
          cand.id,
          cand.claim_epoch
        ]);

        if (upRes.rows.length === 0) {
          await client.query('ROLLBACK');
          return null;
        }

        await client.query('COMMIT');
        return this.mapRowToIntent(upRes.rows[0]);
      }

      // General worker pool claim: skip anything with debt, non-reclaimable status, or active attempts
      const selectSql = `
        SELECT * FROM exit_intents
        WHERE (status = 'CREATED' OR (lease_expires_at < to_timestamp($1 / 1000.0) AND status IN ('CLAIMED', 'PREPARED')))
          AND reconciliation_debt = false
          AND NOT EXISTS (
            SELECT 1 FROM execution_attempts ea
            WHERE ea.intent_id = exit_intents.id AND ea.state IN ('SIGNED', 'SUBMITTED', 'UNKNOWN', 'SENT')
          )
        ORDER BY created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1;
      `;
      const candRes = await client.query(selectSql, [now]);
      if (candRes.rows.length === 0) {
        await client.query('COMMIT');
        return null;
      }

      const cand = candRes.rows[0];
      const leaseExpiresAt = now + input.leaseDurationMs;
      const updateSql = `
        UPDATE exit_intents
        SET claimed_by = $1,
            claim_epoch = claim_epoch + 1,
            claimed_at = to_timestamp($2 / 1000.0),
            lease_expires_at = to_timestamp($3 / 1000.0),
            status = 'CLAIMED'
        WHERE id = $4 AND claim_epoch = $5
        RETURNING *;
      `;
      const upRes = await client.query(updateSql, [
        input.workerId,
        now,
        leaseExpiresAt,
        cand.id,
        cand.claim_epoch
      ]);

      if (upRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return null;
      }

      await client.query('COMMIT');
      return this.mapRowToIntent(upRes.rows[0]);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  public async prepareAttempt(input: PrepareAttemptInput, expectedEpoch?: bigint | number): Promise<ExecutionAttempt> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const intentRes = await client.query('SELECT * FROM exit_intents WHERE id = $1 FOR UPDATE', [input.intentId]);
      if (intentRes.rows.length === 0) {
        throw new Error(`ExitIntent not found for attempt: ${input.intentId}`);
      }
      const intentRow = intentRes.rows[0];

      // Finding P1-03 & 9.1 & 23: Enforce prepareAttempt eligibility matrix
      assertCanPrepareAttemptForIntent(intentRow.status);

      if (intentRow.reconciliation_debt) {
        await client.query('ROLLBACK');
        throw new IllegalStateTransitionError(
          'ExitIntent',
          intentRow.status,
          `PREPARE_ATTEMPT_REJECTED: Intent ${intentRow.id} has active reconciliation debt. Prior execution must be reconciled first.`
        );
      }

      const attCheck = await client.query(
        `SELECT attempt_id, state FROM execution_attempts
         WHERE intent_id = $1 AND state IN ('SIGNED', 'SUBMITTED', 'UNKNOWN', 'SENT')
         LIMIT 1;`,
        [intentRow.id]
      );
      if (attCheck.rows.length > 0) {
        const blockingState = attCheck.rows[0].state;
        await client.query('ROLLBACK');
        throw new IllegalStateTransitionError(
          'ExitIntent',
          intentRow.status,
          `PREPARE_ATTEMPT_REJECTED: Intent ${intentRow.id} already has a potentially live on-chain attempt ${attCheck.rows[0].attempt_id} in state '${blockingState}'. Must reconcile before preparing a new attempt.`
        );
      }

      if (expectedEpoch === undefined || expectedEpoch === null) {
        throw new EpochRequiredError('expectedEpoch is mandatory for worker-owned mutations to enforce fencing');
      }

      if (BigInt(intentRow.claim_epoch) !== BigInt(expectedEpoch)) {
        throw new StaleEpochError(
          `Stale claim epoch for intent ${input.intentId}: expected ${expectedEpoch}, actual ${intentRow.claim_epoch}`,
          input.intentId,
          BigInt(expectedEpoch),
          BigInt(intentRow.claim_epoch)
        );
      }

      const now = input.nowMs ?? nowWallMs();
      const insertSql = `
        INSERT INTO execution_attempts (
          attempt_id, intent_id, provider, route, request_id, message_hash,
          signature, requested_amount_atomic, expected_out_atomic, minimum_out_atomic,
          state, failure_reason, error_classification, last_valid_block_height, started_at, prepared_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::varchar, NULL, NULL, $12,
          to_timestamp($13::bigint / 1000.0),
          CASE WHEN $11::varchar IN ('ORDER_READY', 'SIGNED') THEN to_timestamp($13::bigint / 1000.0) ELSE NULL END
        ) RETURNING *;
      `;

      const attRes = await client.query(insertSql, [
        input.attemptId,
        input.intentId,
        input.provider,
        input.route || null,
        input.requestId || null,
        input.messageHash || null,
        input.signature || null,
        input.requestedAmountAtomic,
        input.expectedOutAtomic || null,
        input.minimumOutAtomic || null,
        input.initialState || 'INITIALIZED',
        input.lastValidBlockHeight !== undefined && input.lastValidBlockHeight !== null ? String(input.lastValidBlockHeight) : null,
        now
      ]);

      if (intentRow.status === 'CLAIMED' || intentRow.status === 'CREATED') {
        assertValidIntentTransition(intentRow.status, 'PREPARED');
        await client.query("UPDATE exit_intents SET status = 'PREPARED' WHERE id = $1", [input.intentId]);
      }

      await client.query('COMMIT');
      return this.mapRowToAttempt(attRes.rows[0]);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  public async getAttemptById(attemptId: string): Promise<ExecutionAttempt | null> {
    const res = await this.pool.query('SELECT * FROM execution_attempts WHERE attempt_id = $1', [attemptId]);
    if (res.rows.length === 0) return null;
    return this.mapRowToAttempt(res.rows[0]);
  }

  public async getAttemptsForIntent(intentId: string): Promise<ExecutionAttempt[]> {
    const res = await this.pool.query('SELECT * FROM execution_attempts WHERE intent_id = $1 ORDER BY started_at ASC', [intentId]);
    return res.rows.map(r => this.mapRowToAttempt(r));
  }

  public async updateAttemptState(
    attemptId: string,
    state: ExecutionAttemptState,
    updates?: Partial<ExecutionAttempt>,
    expectedEpoch?: bigint | number
  ): Promise<ExecutionAttempt> {
    if (expectedEpoch === undefined || expectedEpoch === null) {
      throw new EpochRequiredError('expectedEpoch is mandatory for worker-owned mutations to enforce fencing');
    }
    return this.internalUpdateAttemptState(attemptId, state, updates, expectedEpoch);
  }

  public async systemUpdateAttemptState(
    attemptId: string,
    state: ExecutionAttemptState,
    context: SystemMutationContext,
    updates?: Partial<ExecutionAttempt>
  ): Promise<ExecutionAttempt> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const attRes = await client.query('SELECT * FROM execution_attempts WHERE attempt_id = $1 FOR UPDATE', [attemptId]);
      if (attRes.rows.length === 0) {
        throw new Error(`ExecutionAttempt not found: ${attemptId}`);
      }
      const attRow = attRes.rows[0];

      // Finding 9.2 & 24: Validate system mutation context
      assertValidSystemMutationContext(context, attRow.state, { isFinancial: true });

      // Enforce valid attempt transition
      assertValidAttemptTransition(attRow.state, state);

      const intentRes = await client.query('SELECT * FROM exit_intents WHERE id = $1 FOR UPDATE', [attRow.intent_id]);
      if (intentRes.rows.length > 0) {
        const intentRow = intentRes.rows[0];
        const expEpoch = (context as any).expectedEpoch;
        if (expEpoch !== undefined && expEpoch !== null && BigInt(intentRow.claim_epoch) !== BigInt(expEpoch)) {
          throw new StaleEpochError(
            `Stale claim epoch for intent ${intentRow.id}: expected ${expEpoch}, actual ${intentRow.claim_epoch}`,
            intentRow.id,
            BigInt(expEpoch),
            BigInt(intentRow.claim_epoch)
          );
        }
      }

      // Record system audit event append-only
      const eventId = `sys-audit-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
      await client.query(
        `INSERT INTO system_audit_events (event_id, actor, reason, mutation_class, entity_type, entity_id, before_state, after_state, correlation_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9);`,
        [
          eventId,
          context.actor,
          context.reason,
          (context as any).mutationClass || 'FINANCIAL_STATE_MUTATION',
          'ExecutionAttempt',
          attemptId,
          attRow.state,
          state,
          (context as any).correlationId || null
        ]
      );

      const updateAttSql = `
        UPDATE execution_attempts
        SET state = $1,
            signature = COALESCE($2, signature),
            message_hash = COALESCE($3, message_hash),
            failure_reason = COALESCE($4, failure_reason),
            error_classification = COALESCE($5, error_classification),
            last_valid_block_height = COALESCE($6, last_valid_block_height),
            prepared_at = CASE WHEN $7::bigint IS NOT NULL THEN to_timestamp($7::bigint / 1000.0) ELSE prepared_at END,
            submitted_at = CASE WHEN $8::bigint IS NOT NULL THEN to_timestamp($8::bigint / 1000.0) ELSE submitted_at END,
            provider_receipt_at = CASE WHEN $9::bigint IS NOT NULL THEN to_timestamp($9::bigint / 1000.0) ELSE provider_receipt_at END,
            confirmed_at = CASE WHEN $10::bigint IS NOT NULL THEN to_timestamp($10::bigint / 1000.0) ELSE confirmed_at END
        WHERE attempt_id = $11
        RETURNING *;
      `;

      const upAttRes = await client.query(updateAttSql, [
        state,
        updates?.signature || null,
        updates?.messageHash || null,
        updates?.failureReason || null,
        updates?.errorClassification || null,
        updates?.lastValidBlockHeight != null ? BigInt(updates.lastValidBlockHeight) : null,
        updates?.preparedAtWallMs || null,
        updates?.submittedAtWallMs || null,
        updates?.providerReceiptAtWallMs || null,
        updates?.confirmedAtWallMs || null,
        attemptId
      ]);

      await client.query('COMMIT');
      return this.mapRowToAttempt(upAttRes.rows[0]);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }


  private async internalUpdateAttemptState(
    attemptId: string,
    state: ExecutionAttemptState,
    updates?: Partial<ExecutionAttempt>,
    expectedEpoch?: bigint | number
  ): Promise<ExecutionAttempt> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const attRes = await client.query('SELECT * FROM execution_attempts WHERE attempt_id = $1 FOR UPDATE', [attemptId]);
      if (attRes.rows.length === 0) {
        throw new Error(`ExecutionAttempt not found: ${attemptId}`);
      }
      const attRow = attRes.rows[0];

      assertValidAttemptTransition(attRow.state, state);

      const intentRes = await client.query('SELECT * FROM exit_intents WHERE id = $1 FOR UPDATE', [attRow.intent_id]);
      if (intentRes.rows.length > 0) {
        const intentRow = intentRes.rows[0];
        if (expectedEpoch !== undefined && expectedEpoch !== null && BigInt(intentRow.claim_epoch) !== BigInt(expectedEpoch)) {
          throw new StaleEpochError(
            `Stale claim epoch for intent ${intentRow.id}: expected ${expectedEpoch}, actual ${intentRow.claim_epoch}`,
            intentRow.id,
            BigInt(expectedEpoch),
            BigInt(intentRow.claim_epoch)
          );
        }
      }

      const updateAttSql = `
        UPDATE execution_attempts
        SET state = $1,
            signature = COALESCE($2, signature),
            request_id = COALESCE($3, request_id),
            message_hash = COALESCE($4, message_hash),
            failure_reason = COALESCE($5, failure_reason),
            error_classification = COALESCE($6, error_classification),
            last_valid_block_height = COALESCE($7, last_valid_block_height),
            prepared_at = CASE WHEN $8::bigint IS NOT NULL THEN to_timestamp($8::bigint / 1000.0) ELSE prepared_at END,
            submitted_at = CASE WHEN $9::bigint IS NOT NULL THEN to_timestamp($9::bigint / 1000.0) ELSE submitted_at END,
            provider_receipt_at = CASE WHEN $10::bigint IS NOT NULL THEN to_timestamp($10::bigint / 1000.0) ELSE provider_receipt_at END,
            confirmed_at = CASE WHEN $11::bigint IS NOT NULL THEN to_timestamp($11::bigint / 1000.0) ELSE confirmed_at END
        WHERE attempt_id = $12
        RETURNING *;
      `;

      const res = await client.query(updateAttSql, [
        state,
        updates?.signature || null,
        updates?.requestId || null,
        updates?.messageHash || null,
        updates?.failureReason || null,
        updates?.errorClassification || null,
        updates?.lastValidBlockHeight !== undefined && updates.lastValidBlockHeight !== null ? String(updates.lastValidBlockHeight) : null,
        updates?.preparedAtWallMs ? Number(updates.preparedAtWallMs) : null,
        updates?.submittedAtWallMs ? Number(updates.submittedAtWallMs) : null,
        updates?.providerReceiptAtWallMs ? Number(updates.providerReceiptAtWallMs) : null,
        updates?.confirmedAtWallMs ? Number(updates.confirmedAtWallMs) : null,
        attemptId
      ]);

      // Update parent intent status and reconciliation debt
      if (intentRes.rows.length > 0) {
        const intentRow = intentRes.rows[0];
        let newIntentStatus: string | null = null;
        let setReconcilDebt: boolean | null = null;

        if (state === 'SUBMITTED' || state === 'SENT') {
          if (intentRow.status !== 'CONFIRMED' && intentRow.status !== 'APPLIED' && intentRow.status !== 'UNKNOWN') {
            newIntentStatus = 'SUBMITTED';
          }
          setReconcilDebt = true;
        } else if (state === 'SIGNED') {
          setReconcilDebt = true;
        } else if (state === 'UNKNOWN') {
          newIntentStatus = 'UNKNOWN';
          setReconcilDebt = true;
        } else if (state === 'CONFIRMED') {
          newIntentStatus = 'CONFIRMED';
        } else if (state === 'FAILED_DEFINITIVE') {
          newIntentStatus = 'FAILED_DEFINITIVE';
          // Clear reconciliation debt if no other attempt is active
          const otherActRes = await client.query(
            `SELECT attempt_id FROM execution_attempts
             WHERE intent_id = $1 AND attempt_id != $2 AND state IN ('SIGNED', 'SUBMITTED', 'UNKNOWN')
             LIMIT 1`,
            [attRow.intent_id, attemptId]
          );
          if (otherActRes.rows.length === 0) {
            setReconcilDebt = false;
          }
        }

        if (newIntentStatus && newIntentStatus !== intentRow.status) {
          assertValidIntentTransition(intentRow.status, newIntentStatus as ExitIntentStatus);
        }

        if (newIntentStatus || setReconcilDebt !== null) {
          await client.query(
            `UPDATE exit_intents
             SET status = COALESCE($1, status),
                 reconciliation_debt = COALESCE($2, reconciliation_debt)
             WHERE id = $3`,
            [newIntentStatus, setReconcilDebt, attRow.intent_id]
          );
        }
      }

      await client.query('COMMIT');
      return this.mapRowToAttempt(res.rows[0]);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  public async recordFill(
    fill: FillRecord,
    expectedEpoch?: bigint | number,
    externalClient?: PoolClient
  ): Promise<{ fill: FillRecord; created: boolean }> {
    if (expectedEpoch === undefined || expectedEpoch === null) {
      throw new EpochRequiredError('expectedEpoch is mandatory for worker-owned mutations to enforce fencing');
    }

    const client = externalClient ?? await this.pool.connect();
    const shouldManageTx = !externalClient;
    try {
      if (shouldManageTx) await client.query('BEGIN');

      const intentRes = await client.query('SELECT * FROM exit_intents WHERE id = $1 FOR UPDATE', [fill.intentId]);
      if (intentRes.rows.length > 0) {
        const intentRow = intentRes.rows[0];
        if (BigInt(intentRow.claim_epoch) !== BigInt(expectedEpoch)) {
          throw new StaleEpochError(
            `Stale claim epoch for fill on intent ${fill.intentId}: expected ${expectedEpoch}, actual ${intentRow.claim_epoch}`,
            fill.intentId,
            BigInt(expectedEpoch),
            BigInt(intentRow.claim_epoch)
          );
        }
      }

      const insertFillSql = `
        INSERT INTO fill_ledger (
          id, trade_id, position_id, intent_id, attempt_id, signature,
          realization_sequence, chain_leg_index, instruction_index, inner_instruction_index,
          asset_mint, requested_amount_atomic, actual_amount_atomic, gross_proceeds_lamports,
          network_fee_lamports, priority_fee_lamports, tip_lamports, rent_movement_lamports,
          slot, commitment, confirmed_at, evidence_type, created_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
          to_timestamp($21 / 1000.0), $22, to_timestamp($23 / 1000.0)
        )
        ON CONFLICT (signature, chain_leg_index, instruction_index, inner_instruction_index) DO NOTHING
        RETURNING *;
      `;

      const fillRes = await client.query(insertFillSql, [
        fill.id,
        fill.tradeId,
        fill.positionId,
        fill.intentId,
        fill.attemptId,
        fill.signature,
        fill.realizationSequence,
        fill.chainLegIndex,
        fill.instructionIndex,
        fill.innerInstructionIndex,
        fill.assetMint || null,
        fill.requestedAmountAtomic,
        fill.actualAmountAtomic,
        fill.grossProceedsLamports,
        fill.networkFeeLamports,
        fill.priorityFeeLamports,
        fill.tipLamports,
        fill.rentMovementLamports,
        fill.slot || null,
        fill.commitment || 'confirmed',
        fill.confirmedAtWallMs ? Number(fill.confirmedAtWallMs) : ((fill as any).confirmedAt ? new Date((fill as any).confirmedAt).getTime() : Date.now()),
        fill.evidenceType,
        fill.createdAtWallMs ? Number(fill.createdAtWallMs) : ((fill as any).createdAt ? new Date((fill as any).createdAt).getTime() : Date.now())
      ]);

      if (fillRes.rows.length === 0) {
        // Idempotent: return existing fill
        const dupRes = await client.query(
          `SELECT * FROM fill_ledger
           WHERE signature = $1 AND chain_leg_index = $2 AND instruction_index = $3 AND inner_instruction_index = $4`,
          [fill.signature, fill.chainLegIndex, fill.instructionIndex, fill.innerInstructionIndex]
        );
        if (shouldManageTx) await client.query('COMMIT');
        return { fill: this.mapRowToFill(dupRes.rows[0]), created: false };
      }

      // Update parent intent status: fully filled -> APPLIED, partially filled -> CONFIRMED
      if (intentRes.rows.length > 0) {
        const intentRow = intentRes.rows[0];
        const sumRes = await client.query(
          `SELECT COALESCE(SUM(actual_amount_atomic), 0) as total_filled FROM fill_ledger WHERE intent_id = $1`,
          [fill.intentId]
        );
        const totalFilled = BigInt(sumRes.rows[0]?.total_filled || 0);
        const isFullyFilled = totalFilled >= BigInt(intentRow.requested_amount_atomic);
        if (isFullyFilled) {
          assertValidIntentTransition(intentRow.status, 'APPLIED');
          await client.query(
            "UPDATE exit_intents SET status = 'APPLIED', reconciliation_debt = false WHERE id = $1",
            [fill.intentId]
          );
        } else {
          assertValidIntentTransition(intentRow.status, 'CONFIRMED');
          await client.query(
            "UPDATE exit_intents SET status = 'CONFIRMED' WHERE id = $1",
            [fill.intentId]
          );
        }
      }

      if (shouldManageTx) await client.query('COMMIT');
      return { fill: this.mapRowToFill(fillRes.rows[0]), created: true };
    } catch (err: any) {
      if (shouldManageTx) await client.query('ROLLBACK');
      if (err?.code === '23505' && err.constraint === 'fill_ledger_pkey') {
        throw new AppendOnlyViolationError(`Fill ID already exists: ${fill.id}. Cannot overwrite existing fill.`);
      }
      throw err;
    } finally {
      if (shouldManageTx) client.release();
    }
  }

  public async getFillsForTrade(tradeId: string): Promise<FillRecord[]> {
    const res = await this.pool.query('SELECT * FROM fill_ledger WHERE trade_id = $1 ORDER BY created_at ASC', [tradeId]);
    return res.rows.map(r => this.mapRowToFill(r));
  }

  public async getFillsForPosition(positionId: string): Promise<FillRecord[]> {
    const res = await this.pool.query('SELECT * FROM fill_ledger WHERE position_id = $1 ORDER BY created_at ASC', [positionId]);
    return res.rows.map(r => this.mapRowToFill(r));
  }

  public async recordReconciliationEvent(
    event: Omit<ExecutionReconciliationEvent, 'id' | 'createdAtWallMs'>
  ): Promise<ExecutionReconciliationEvent> {
    const now = nowWallMs();
    const insertSql = `
      INSERT INTO execution_reconciliation_events (
        attempt_id, signature, verdict, reason, on_chain_status, blockhash_valid, created_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, to_timestamp($7 / 1000.0)
      ) RETURNING id;
    `;
    const res = await this.pool.query(insertSql, [
      event.attemptId,
      event.signature || null,
      event.verdict,
      event.reason,
      event.onChainStatus || null,
      event.blockhashValid !== undefined ? event.blockhashValid : null,
      now
    ]);

    return {
      id: String(res.rows[0].id),
      attemptId: event.attemptId,
      signature: event.signature,
      verdict: event.verdict,
      reason: event.reason,
      onChainStatus: event.onChainStatus,
      blockhashValid: event.blockhashValid,
      createdAtWallMs: now
    };
  }

  public async getIntent(id: string): Promise<ExitIntent | null> {
    return this.getIntentById(id);
  }

  public async claimNextIntent(input: ClaimIntentInput): Promise<ExitIntent | null> {
    return this.claimIntent(input);
  }

  public async renewLease(
    intentId: string,
    workerId: string,
    durationMs: number,
    expectedEpoch?: bigint | number
  ): Promise<ExitIntent> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const intentRes = await client.query('SELECT * FROM exit_intents WHERE id = $1 FOR UPDATE', [intentId]);
      if (intentRes.rows.length === 0) {
        throw new Error(`ExitIntent not found: ${intentId}`);
      }
      const row = intentRes.rows[0];
      if (row.claimed_by !== workerId) {
        throw new Error(`Cannot renew lease for intent ${intentId}: claimed by ${row.claimed_by}, caller is ${workerId}`);
      }
      if (expectedEpoch !== undefined && BigInt(row.claim_epoch) !== BigInt(expectedEpoch)) {
        throw new StaleEpochError(
          `Stale claim epoch for intent ${intentId}: expected ${expectedEpoch}, actual ${row.claim_epoch}`,
          intentId,
          BigInt(expectedEpoch),
          BigInt(row.claim_epoch)
        );
      }
      const now = nowWallMs();
      const newExpiresAt = Number(now) + durationMs;
      const up = await client.query(
        'UPDATE exit_intents SET lease_expires_at = to_timestamp($1 / 1000.0) WHERE id = $2 RETURNING *',
        [newExpiresAt, intentId]
      );
      await client.query('COMMIT');
      return this.mapRowToIntent(up.rows[0]);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  public async recordSeverityEvent(
    intentId: string,
    newSeverity: ExitIntentSeverity,
    reason: ExitIntentReason,
    observationId?: string,
    expectedEpoch?: bigint | number
  ): Promise<IntentSeverityEvent> {
    return this.updateIntentSeverity(intentId, newSeverity, reason, observationId, expectedEpoch);
  }

  public async createAttempt(input: PrepareAttemptInput, expectedEpoch?: bigint | number): Promise<ExecutionAttempt> {
    return this.prepareAttempt(input, expectedEpoch);
  }

  public async markReconciliationDebt(
    intentId: string,
    debt: boolean,
    expectedEpoch?: bigint | number
  ): Promise<ExitIntent> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const intentRes = await client.query('SELECT * FROM exit_intents WHERE id = $1 FOR UPDATE', [intentId]);
      if (intentRes.rows.length === 0) {
        throw new Error(`ExitIntent not found: ${intentId}`);
      }
      const row = intentRes.rows[0];
      if (expectedEpoch !== undefined && BigInt(row.claim_epoch) !== BigInt(expectedEpoch)) {
        throw new StaleEpochError(
          `Stale claim epoch for intent ${intentId}: expected ${expectedEpoch}, actual ${row.claim_epoch}`,
          intentId,
          BigInt(expectedEpoch),
          BigInt(row.claim_epoch)
        );
      }
      const up = await client.query(
        'UPDATE exit_intents SET reconciliation_debt = $1 WHERE id = $2 RETURNING *',
        [debt, intentId]
      );
      await client.query('COMMIT');
      return this.mapRowToIntent(up.rows[0]);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  public async applyFillIdempotently(fill: FillRecord, expectedEpoch?: bigint | number): Promise<{ fill: FillRecord; created: boolean }> {
    return this.recordFill(fill, expectedEpoch);
  }

  public async releaseTerminalIntent(
    intentId: string,
    terminalStatus: ExitIntentStatus,
    contextOrEpoch?: bigint | number | SystemMutationContext
  ): Promise<ExitIntent> {
    if (!isIntentTerminal(terminalStatus)) {
      throw new Error(`Cannot release intent ${intentId} with non-terminal status: ${terminalStatus}`);
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const intentRes = await client.query('SELECT * FROM exit_intents WHERE id = $1 FOR UPDATE', [intentId]);
      if (intentRes.rows.length === 0) {
        throw new Error(`ExitIntent not found: ${intentId}`);
      }
      const row = intentRes.rows[0];

      let expectedEpoch: bigint | number | undefined;
      if (typeof contextOrEpoch === 'object' && contextOrEpoch !== null) {
        assertValidSystemMutationContext(contextOrEpoch, row.status, { isFinancial: true });
        expectedEpoch = (contextOrEpoch as any).expectedEpoch;
      } else {
        expectedEpoch = contextOrEpoch;
      }

      if (expectedEpoch !== undefined && BigInt(row.claim_epoch) !== BigInt(expectedEpoch)) {
        throw new StaleEpochError(
          `Stale claim epoch for intent ${intentId}: expected ${expectedEpoch}, actual ${row.claim_epoch}`,
          intentId,
          BigInt(expectedEpoch),
          BigInt(row.claim_epoch)
        );
      }

      if (terminalStatus === 'SUPERSEDED' || terminalStatus === 'CANCELLED') {
        const live = await this.hasPotentiallyLiveChainAttempt(intentId);
        if (live) {
          throw new IllegalStateTransitionError(
            'ExitIntent',
            'ACTIVE_CHAIN_ATTEMPT',
            terminalStatus
          );
        }
      }
      assertValidIntentTransition(row.status, terminalStatus);
      const up = await client.query(
        `UPDATE exit_intents
         SET status = $1, reconciliation_debt = false, claimed_by = NULL, lease_expires_at = NULL
         WHERE id = $2 RETURNING *`,
        [terminalStatus, intentId]
      );

      if (typeof contextOrEpoch === 'object' && contextOrEpoch !== null) {
        const eventId = `sys-audit-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
        await client.query(
          `INSERT INTO system_audit_events (event_id, actor, reason, mutation_class, entity_type, entity_id, before_state, after_state, correlation_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9);`,
          [
            eventId,
            contextOrEpoch.actor,
            contextOrEpoch.reason,
            (contextOrEpoch as any).mutationClass || 'FINANCIAL_STATE_MUTATION',
            'ExitIntent',
            intentId,
            row.status,
            terminalStatus,
            (contextOrEpoch as any).correlationId || null
          ]
        );
      }

      await client.query('COMMIT');
      return this.mapRowToIntent(up.rows[0]);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  public async getSystemAuditEvents(entityId?: string): Promise<SystemAuditEvent[]> {
    const client = await this.pool.connect();
    try {
      const sql = entityId
        ? `SELECT * FROM system_audit_events WHERE entity_id = $1 ORDER BY created_at ASC;`
        : `SELECT * FROM system_audit_events ORDER BY created_at ASC;`;
      const params = entityId ? [entityId] : [];
      const res = await client.query(sql, params);
      return res.rows.map(r => ({
        id: r.id,
        eventId: r.event_id,
        actor: r.actor,
        reason: r.reason,
        mutationClass: r.mutation_class,
        entityType: r.entity_type,
        entityId: r.entity_id,
        beforeState: r.before_state,
        afterState: r.after_state,
        correlationId: r.correlation_id || undefined,
        createdAtWallMs: new Date(r.created_at).getTime() as WallMs
      }));
    } finally {
      client.release();
    }
  }

  public async hasPotentiallyLiveChainAttempt(intentId: string): Promise<boolean> {
    const res = await this.pool.query(
      `SELECT 1 FROM execution_attempts
       WHERE intent_id = $1
         AND (
           (signature IS NOT NULL AND trim(signature) != '')
           OR state IN ('SIGNED', 'SUBMITTED', 'UNKNOWN', 'SENT')
         )
       LIMIT 1;`,
      [intentId]
    );
    return res.rows.length > 0;
  }

  public async getUnreconciledIntents(): Promise<ExitIntent[]> {
    const res = await this.pool.query(
      `SELECT * FROM exit_intents
       WHERE reconciliation_debt = true OR status = 'UNKNOWN'
       ORDER BY created_at ASC`
    );
    return res.rows.map(r => this.mapRowToIntent(r));
  }

  // Row mapping helpers
  private mapRowToIntent(row: any): ExitIntent {
    return {
      id: row.id,
      tradeId: row.trade_id,
      positionId: row.position_id,
      walletId: row.wallet_id,
      mint: row.mint,
      tokenProgram: row.token_program,
      positionVersion: row.position_version !== null && row.position_version !== undefined ? BigInt(row.position_version) : null,
      requestedAmountAtomic: String(row.requested_amount_atomic),
      amountPolicy: row.amount_policy,
      economicDedupeKey: row.economic_dedupe_key,
      initialSeverity: row.initial_severity,
      currentSeverity: row.current_severity,
      severityAuditTrail: [],
      reason: row.reason,
      policyVersion: row.policy_version,
      claimedBy: row.claimed_by,
      claimEpoch: BigInt(row.claim_epoch),
      claimedAtWallMs: row.claimed_at ? Math.round(new Date(row.claimed_at).getTime()) as any : null,
      leaseExpiresAtWallMs: row.lease_expires_at ? Math.round(new Date(row.lease_expires_at).getTime()) as any : null,
      status: row.status,
      supersededBy: row.superseded_by,
      reconciliationDebt: Boolean(row.reconciliation_debt),
      createdAtWallMs: Math.round(new Date(row.created_at).getTime()) as any,
      expiresAtWallMs: Math.round(new Date(row.expires_at).getTime()) as any
    };
  }

  private mapRowToAttempt(row: any): ExecutionAttempt {
    return {
      attemptId: row.attempt_id,
      intentId: row.intent_id,
      provider: row.provider,
      route: row.route,
      requestId: row.request_id,
      messageHash: row.message_hash,
      signature: row.signature,
      requestedAmountAtomic: String(row.requested_amount_atomic),
      expectedOutAtomic: row.expected_out_atomic ? String(row.expected_out_atomic) : undefined,
      minimumOutAtomic: row.minimum_out_atomic ? String(row.minimum_out_atomic) : undefined,
      state: row.state,
      failureReason: row.failure_reason,
      errorClassification: row.error_classification,
      lastValidBlockHeight: row.last_valid_block_height !== null && row.last_valid_block_height !== undefined ? BigInt(row.last_valid_block_height) : undefined,
      startedAtWallMs: Math.round(new Date(row.started_at).getTime()) as any,
      preparedAtWallMs: row.prepared_at ? Math.round(new Date(row.prepared_at).getTime()) as any : undefined,
      submittedAtWallMs: row.submitted_at ? Math.round(new Date(row.submitted_at).getTime()) as any : undefined,
      providerReceiptAtWallMs: row.provider_receipt_at ? Math.round(new Date(row.provider_receipt_at).getTime()) as any : undefined,
      confirmedAtWallMs: row.confirmed_at ? Math.round(new Date(row.confirmed_at).getTime()) as any : undefined
    };
  }

  private mapRowToFill(row: any): FillRecord {
    return {
      id: row.id,
      tradeId: row.trade_id,
      positionId: row.position_id,
      intentId: row.intent_id,
      attemptId: row.attempt_id,
      signature: row.signature,
      realizationSequence: Number(row.realization_sequence),
      chainLegIndex: Number(row.chain_leg_index),
      instructionIndex: Number(row.instruction_index),
      innerInstructionIndex: Number(row.inner_instruction_index),
      assetMint: row.asset_mint,
      requestedAmountAtomic: String(row.requested_amount_atomic),
      actualAmountAtomic: String(row.actual_amount_atomic),
      grossProceedsLamports: String(row.gross_proceeds_lamports),
      networkFeeLamports: String(row.network_fee_lamports),
      priorityFeeLamports: String(row.priority_fee_lamports),
      tipLamports: String(row.tip_lamports),
      rentMovementLamports: String(row.rent_movement_lamports),
      slot: row.slot ? Number(row.slot) : undefined,
      commitment: row.commitment,
      confirmedAtWallMs: Math.round(new Date(row.confirmed_at).getTime()) as any,
      evidenceType: row.evidence_type,
      createdAtWallMs: Math.round(new Date(row.created_at).getTime()) as any
    };
  }
}
