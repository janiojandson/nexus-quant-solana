/**
 * Nexus Quant Solana — V2.3A PostgresPositionRepository
 *
 * PostgreSQL implementation of IPositionRepository:
 * - Real transaction semantics with Pool / PoolClient.
 * - CAS update on position_version (WHERE position_id = $id AND position_version = $expectedVersion).
 * - StalePositionVersionError mapping on rowCount = 0.
 * - Idempotent fill application via nexus_position_mutations_v2.
 * - Partial unique index enforcement on (wallet_id, mint, token_program) for active positions.
 */

import { Pool, PoolClient } from 'pg';
import {
  IPositionRepository
} from './repository.js';
import {
  PositionVersion,
  PositionStatus,
  PositionMutationType,
  DurablePosition,
  PositionMutationRecord,
  CreatePositionInput,
  UpdatePositionCASParams,
  ApplyFillParams,
  ApplyConfirmedFillInput,
  ApplyReconciliationAdjustmentInput,
  ArbitraryBalanceMutationRejectedError,
  ExternalBalanceDivergenceAdjustment,
  StalePositionVersionError,
  ActivePositionConflictError,
  PositionNotFoundError,
  DEFAULT_TOKEN_PROGRAM_ID
} from './types.js';

export interface PostgresPositionRepositoryConfig {
  pool: Pool;
}

export class PostgresPositionRepository implements IPositionRepository {
  private pool: Pool;

  constructor(config: PostgresPositionRepositoryConfig | Pool | any) {
    if (config && typeof config === 'object' && 'pool' in config && config.pool) {
      this.pool = config.pool;
    } else {
      this.pool = config as Pool;
    }
  }

  public getPool(): Pool {
    return this.pool;
  }

  private mapRowToPosition(row: any): DurablePosition {
    return {
      positionId: String(row.position_id),
      tradeId: String(row.trade_id),
      walletId: String(row.wallet_id),
      mint: String(row.mint),
      tokenProgram: String(row.token_program),
      status: row.status as PositionStatus,
      positionVersion: BigInt(row.position_version),
      tokenAmountAtomic: BigInt(row.token_amount_atomic),
      initialAmountAtomic: BigInt(row.initial_amount_atomic),
      initialPrincipalLamports: BigInt(row.initial_principal_lamports),
      confirmedProceedsLamports: BigInt(row.confirmed_proceeds_lamports || 0),
      openedAt: new Date(row.opened_at),
      updatedAt: new Date(row.updated_at),
      closedAt: row.closed_at ? new Date(row.closed_at) : null,
      lastFillId: row.last_fill_id ? String(row.last_fill_id) : null,
      lastChainSignature: row.last_chain_signature ? String(row.last_chain_signature) : null,
      reconciliationRequired: Boolean(row.reconciliation_required),
      source: String(row.source),
      provenance: row.provenance ? String(row.provenance) : null
    };
  }

  private mapRowToMutation(row: any): PositionMutationRecord {
    return {
      id: Number(row.id),
      positionId: String(row.position_id),
      fromVersion: BigInt(row.from_version),
      toVersion: BigInt(row.to_version),
      mutationType: row.mutation_type as PositionMutationType,
      fillId: row.fill_id ? String(row.fill_id) : null,
      signature: row.signature ? String(row.signature) : null,
      tokenAmountBefore: BigInt(row.token_amount_before),
      tokenAmountAfter: BigInt(row.token_amount_after),
      deltaAtomic: BigInt(row.delta_atomic),
      proceedsLamports: BigInt(row.proceeds_lamports || 0),
      createdAt: new Date(row.created_at)
    };
  }

  public async createPosition(input: CreatePositionInput): Promise<DurablePosition> {
    const tokenProgram = input.tokenProgram || DEFAULT_TOKEN_PROGRAM_ID;
    const initialVersion = input.initialVersion ?? 1n;
    const tokenAmountAtomic = input.tokenAmountAtomic ?? input.initialAmountAtomic;
    const status = input.status || 'OPEN';
    const source = input.source || 'LIVE_EXECUTOR';
    const provenance = input.provenance || null;

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const insertSql = `
        INSERT INTO nexus_positions_v2 (
          position_id, trade_id, wallet_id, mint, token_program,
          status, position_version, token_amount_atomic, initial_amount_atomic,
          initial_principal_lamports, confirmed_proceeds_lamports,
          opened_at, updated_at, source, provenance
        ) VALUES (
          $1, $2, $3, $4, $5,
          $6, $7, $8, $9,
          $10, 0,
          NOW(), NOW(), $11, $12
        )
        RETURNING *;
      `;
      let res;
      try {
        res = await client.query(insertSql, [
          input.positionId,
          input.tradeId,
          input.walletId,
          input.mint,
          tokenProgram,
          status,
          initialVersion.toString(),
          tokenAmountAtomic.toString(),
          input.initialAmountAtomic.toString(),
          input.initialPrincipalLamports.toString(),
          source,
          provenance
        ]);
      } catch (err: any) {
        if (err.code === '23505') {
          // Unique violation
          throw new ActivePositionConflictError(
            `Active position already exists for wallet ${input.walletId} and mint ${input.mint} (index violation)`,
            input.walletId,
            input.mint,
            input.positionId
          );
        }
        throw err;
      }

      const pos = this.mapRowToPosition(res.rows[0]);

      // Insert initial mutation record
      const mutationSql = `
        INSERT INTO nexus_position_mutations_v2 (
          position_id, from_version, to_version, mutation_type,
          fill_id, signature, token_amount_before, token_amount_after,
          delta_atomic, proceeds_lamports, created_at
        ) VALUES (
          $1, 0, $2, 'ENTRY_OPEN',
          NULL, NULL, 0, $3,
          $3, 0, NOW()
        );
      `;
      await client.query(mutationSql, [
        pos.positionId,
        pos.positionVersion.toString(),
        pos.tokenAmountAtomic.toString()
      ]);

      await client.query('COMMIT');
      return pos;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  public async getPosition(positionId: string, client?: PoolClient): Promise<DurablePosition | null> {
    const runner = client ?? this.pool;
    const res = await runner.query(
      'SELECT * FROM nexus_positions_v2 WHERE position_id = $1;',
      [positionId]
    );
    if (res.rows.length === 0) return null;
    return this.mapRowToPosition(res.rows[0]);
  }

  public async getActivePositionByWalletMint(
    walletId: string,
    mint: string,
    tokenProgram: string = DEFAULT_TOKEN_PROGRAM_ID
  ): Promise<DurablePosition | null> {
    const res = await this.pool.query(
      `SELECT * FROM nexus_positions_v2
       WHERE wallet_id = $1 AND mint = $2 AND token_program = $3
         AND status NOT IN ('CLOSED', 'TERMINATED')
       LIMIT 1;`,
      [walletId, mint, tokenProgram]
    );
    if (res.rows.length === 0) return null;
    return this.mapRowToPosition(res.rows[0]);
  }

  public async getAllPositions(filter?: {
    walletId?: string;
    status?: PositionStatus;
  }): Promise<DurablePosition[]> {
    let sql = 'SELECT * FROM nexus_positions_v2 WHERE 1=1';
    const params: any[] = [];
    if (filter?.walletId) {
      params.push(filter.walletId);
      sql += ` AND wallet_id = $${params.length}`;
    }
    if (filter?.status) {
      params.push(filter.status);
      sql += ` AND status = $${params.length}`;
    }
    sql += ' ORDER BY opened_at ASC;';
    const res = await this.pool.query(sql, params);
    return res.rows.map(r => this.mapRowToPosition(r));
  }

  public async updatePositionCAS(
    params: UpdatePositionCASParams,
    externalClient?: PoolClient
  ): Promise<{
    position: DurablePosition;
    mutation: PositionMutationRecord;
  }> {
    if (params.newAmountAtomic < 0n) {
      throw new ArbitraryBalanceMutationRejectedError(
        `Position amount cannot be negative: ${params.newAmountAtomic}`,
        params.positionId
      );
    }

    const client = externalClient ?? await this.pool.connect();
    const shouldManageTx = !externalClient;
    try {
      if (shouldManageTx) await client.query('BEGIN');

      const selectSql = `
        SELECT position_id, position_version, token_amount_atomic, status
        FROM nexus_positions_v2
        WHERE position_id = $1
        FOR UPDATE;
      `;
      const currentRes = await client.query(selectSql, [params.positionId]);
      if (currentRes.rows.length === 0) {
        throw new PositionNotFoundError(`Position ${params.positionId} not found`, params.positionId);
      }

      const currentRow = currentRes.rows[0];
      const actualVersion = BigInt(currentRow.position_version);
      if (actualVersion !== params.expectedVersion) {
        throw new StalePositionVersionError(
          `CAS update failed for position ${params.positionId}: expected version ${params.expectedVersion}, found ${actualVersion}`,
          params.positionId,
          params.expectedVersion,
          actualVersion
        );
      }

      const amountBefore = BigInt(currentRow.token_amount_atomic);
      const amountAfter = params.newAmountAtomic;
      const delta = amountAfter - amountBefore;

      let targetStatus = params.newStatus;
      if (!targetStatus && amountAfter === 0n) {
        targetStatus = 'CLOSED';
      }

      const updateSql = `
        UPDATE nexus_positions_v2
        SET
          position_version = position_version + 1,
          token_amount_atomic = $1::numeric,
          status = COALESCE($2::varchar, status),
          confirmed_proceeds_lamports = confirmed_proceeds_lamports + $3::numeric,
          updated_at = NOW(),
          closed_at = CASE
            WHEN $2::varchar IN ('CLOSED', 'TERMINATED') OR ($1::numeric = 0 AND closed_at IS NULL) THEN NOW()
            ELSE closed_at
          END,
          last_fill_id = COALESCE($4::varchar, last_fill_id),
          last_chain_signature = COALESCE($5::varchar, last_chain_signature),
          reconciliation_required = COALESCE($6::boolean, reconciliation_required)
        WHERE position_id = $7::varchar
          AND position_version = $8::bigint
        RETURNING *;
      `;

      const updateRes = await client.query(updateSql, [
        amountAfter.toString(),
        targetStatus || null,
        (params.proceedsDeltaLamports ?? 0n).toString(),
        params.fillId || null,
        params.signature || null,
        params.reconciliationRequired !== undefined ? params.reconciliationRequired : null,
        params.positionId,
        params.expectedVersion.toString()
      ]);

      if (updateRes.rowCount === 0) {
        throw new StalePositionVersionError(
          `CAS update returned 0 rows for position ${params.positionId}`,
          params.positionId,
          params.expectedVersion
        );
      }

      const updatedPos = this.mapRowToPosition(updateRes.rows[0]);

      // Record mutation
      const mutationSql = `
        INSERT INTO nexus_position_mutations_v2 (
          position_id, from_version, to_version, mutation_type,
          fill_id, signature, token_amount_before, token_amount_after,
          delta_atomic, proceeds_lamports, created_at
        ) VALUES (
          $1, $2, $3, $4,
          $5, $6, $7, $8,
          $9, $10, NOW()
        )
        RETURNING *;
      `;

      const mutationRes = await client.query(mutationSql, [
        params.positionId,
        params.expectedVersion.toString(),
        updatedPos.positionVersion.toString(),
        params.mutationType,
        params.fillId || null,
        params.signature || null,
        amountBefore.toString(),
        amountAfter.toString(),
        delta.toString(),
        (params.proceedsDeltaLamports ?? 0n).toString()
      ]);

      const mutation = this.mapRowToMutation(mutationRes.rows[0]);

      if (shouldManageTx) await client.query('COMMIT');
      return { position: updatedPos, mutation };
    } catch (err) {
      if (shouldManageTx) await client.query('ROLLBACK');
      throw err;
    } finally {
      if (shouldManageTx) client.release();
    }
  }

  public async applyConfirmedFill(
    input: ApplyConfirmedFillInput,
    externalClient?: PoolClient
  ): Promise<{
    position: DurablePosition;
    mutation: PositionMutationRecord;
    alreadyApplied: boolean;
  }> {
    const client = externalClient ?? await this.pool.connect();
    const shouldManageTx = !externalClient;
    try {
      if (shouldManageTx) await client.query('BEGIN');

      // 1. Check if fill was already recorded for this position by fill_id OR signature
      const checkFillSql = `
        SELECT * FROM nexus_position_mutations_v2
        WHERE position_id = $1 AND (fill_id = $2 OR (signature IS NOT NULL AND signature = $3))
        LIMIT 1;
      `;
      const existingRes = await client.query(checkFillSql, [
        input.positionId,
        input.fillId,
        input.signature || ''
      ]);
      if (existingRes.rows.length > 0) {
        // Fill already applied
        const posRes = await client.query(
          'SELECT * FROM nexus_positions_v2 WHERE position_id = $1;',
          [input.positionId]
        );
        if (shouldManageTx) await client.query('COMMIT');
        return {
          position: this.mapRowToPosition(posRes.rows[0]),
          mutation: this.mapRowToMutation(existingRes.rows[0]),
          alreadyApplied: true
        };
      }

      // 2. Lock position and verify expected version
      const posRes = await client.query(
        'SELECT * FROM nexus_positions_v2 WHERE position_id = $1 FOR UPDATE;',
        [input.positionId]
      );
      if (posRes.rows.length === 0) {
        throw new PositionNotFoundError(`Position ${input.positionId} not found`, input.positionId);
      }

      const currentPos = this.mapRowToPosition(posRes.rows[0]);
      if (currentPos.positionVersion !== input.expectedVersion) {
        throw new StalePositionVersionError(
          `Fill application rejected for position ${input.positionId}: expected version ${input.expectedVersion}, found ${currentPos.positionVersion}`,
          input.positionId,
          input.expectedVersion,
          currentPos.positionVersion
        );
      }

      if (input.confirmedActualDebitAtomic < 0n) {
        throw new ArbitraryBalanceMutationRejectedError(
          `Confirmed debit atomic cannot be negative: ${input.confirmedActualDebitAtomic}`,
          input.positionId
        );
      }

      if (input.confirmedActualDebitAtomic > currentPos.tokenAmountAtomic) {
        throw new ArbitraryBalanceMutationRejectedError(
          `Fill debit ${input.confirmedActualDebitAtomic} exceeds current balance ${currentPos.tokenAmountAtomic}`,
          input.positionId
        );
      }

      const newAmount = currentPos.tokenAmountAtomic - input.confirmedActualDebitAtomic;
      if (newAmount < 0n) {
        throw new ArbitraryBalanceMutationRejectedError(
          `Calculated position balance cannot be negative: ${newAmount}`,
          input.positionId
        );
      }

      const isFinal = Boolean(input.isFinal || newAmount === 0n);
      const newStatus: PositionStatus = isFinal ? 'CLOSED' : 'PARTIAL_CLOSED';
      const mutationType: PositionMutationType = isFinal ? 'FINAL_FILL' : 'PARTIAL_FILL';

      const updateSql = `
        UPDATE nexus_positions_v2
        SET
          position_version = position_version + 1,
          token_amount_atomic = $1::numeric,
          status = $2::varchar,
          confirmed_proceeds_lamports = confirmed_proceeds_lamports + $3::numeric,
          updated_at = NOW(),
          closed_at = CASE WHEN $2::varchar = 'CLOSED' AND closed_at IS NULL THEN NOW() ELSE closed_at END,
          last_fill_id = $4::varchar,
          last_chain_signature = $5::varchar
        WHERE position_id = $6::varchar
          AND position_version = $7::bigint
        RETURNING *;
      `;

      const updateRes = await client.query(updateSql, [
        newAmount.toString(),
        newStatus,
        input.grossProceedsLamports.toString(),
        input.fillId,
        input.signature,
        input.positionId,
        input.expectedVersion.toString()
      ]);

      if (updateRes.rowCount === 0) {
        throw new StalePositionVersionError(
          `CAS update failed during fill application for position ${input.positionId}`,
          input.positionId,
          input.expectedVersion
        );
      }

      const updatedPos = this.mapRowToPosition(updateRes.rows[0]);

      // Record mutation
      const mutationSql = `
        INSERT INTO nexus_position_mutations_v2 (
          position_id, from_version, to_version, mutation_type,
          fill_id, signature, token_amount_before, token_amount_after,
          delta_atomic, proceeds_lamports, created_at
        ) VALUES (
          $1, $2, $3, $4,
          $5, $6, $7, $8,
          $9, $10, NOW()
        )
        RETURNING *;
      `;

      const mutationRes = await client.query(mutationSql, [
        input.positionId,
        input.expectedVersion.toString(),
        updatedPos.positionVersion.toString(),
        mutationType,
        input.fillId,
        input.signature,
        currentPos.tokenAmountAtomic.toString(),
        newAmount.toString(),
        (-input.confirmedActualDebitAtomic).toString(),
        input.grossProceedsLamports.toString()
      ]);

      const mutation = this.mapRowToMutation(mutationRes.rows[0]);

      if (shouldManageTx) await client.query('COMMIT');
      return {
        position: updatedPos,
        mutation,
        alreadyApplied: false
      };
    } catch (err) {
      if (shouldManageTx) await client.query('ROLLBACK');
      throw err;
    } finally {
      if (shouldManageTx) client.release();
    }
  }

  public async applyFill(
    params: ApplyFillParams,
    externalClient?: PoolClient
  ): Promise<{
    position: DurablePosition;
    mutation: PositionMutationRecord;
    alreadyApplied: boolean;
  }> {
    return this.applyConfirmedFill({
      positionId: params.positionId,
      expectedVersion: params.expectedVersion,
      fillId: params.fillId,
      signature: params.signature,
      confirmedActualDebitAtomic: params.fillAmountAtomic,
      grossProceedsLamports: params.proceedsLamports,
      isFinal: params.isFinal
    }, externalClient);
  }

  public async applyReconciliationAdjustment(
    input: ApplyReconciliationAdjustmentInput,
    externalClient?: PoolClient
  ): Promise<{
    position: DurablePosition;
    mutation: PositionMutationRecord;
  }> {
    if (!input.evidence || !input.evidence.reason || !input.evidence.source) {
      throw new ArbitraryBalanceMutationRejectedError(
        'Evidence metadata (source and reason) is strictly required for reconciliation adjustment',
        input.positionId
      );
    }
    if (input.observedBalanceAtomic < 0n) {
      throw new ArbitraryBalanceMutationRejectedError(
        `Observed balance cannot be negative: ${input.observedBalanceAtomic}`,
        input.positionId
      );
    }
    const newStatus: PositionStatus = input.observedBalanceAtomic === 0n ? 'CLOSED' : 'OPEN';
    return this.updatePositionCAS({
      positionId: input.positionId,
      expectedVersion: input.expectedVersion,
      newAmountAtomic: input.observedBalanceAtomic,
      newStatus,
      mutationType: 'RECONCILIATION_ADJUSTMENT',
      reconciliationRequired: false
    }, externalClient);
  }

  public async reconcileExternalBalance(
    adjustment: ExternalBalanceDivergenceAdjustment,
    externalClient?: PoolClient
  ): Promise<{
    position: DurablePosition;
    mutation: PositionMutationRecord;
  }> {
    const pos = await this.getPosition(adjustment.positionId, externalClient);
    if (!pos) {
      throw new PositionNotFoundError(`Position ${adjustment.positionId} not found`, adjustment.positionId);
    }
    if (pos.positionVersion !== adjustment.expectedVersion) {
      throw new StalePositionVersionError(
        `External reconciliation failed: expected version ${adjustment.expectedVersion}, found ${pos.positionVersion}`,
        adjustment.positionId,
        adjustment.expectedVersion,
        pos.positionVersion
      );
    }
    const newStatus: PositionStatus = adjustment.observedChainAmountAtomic === 0n ? 'CLOSED' : pos.status;
    return this.updatePositionCAS({
      positionId: adjustment.positionId,
      expectedVersion: adjustment.expectedVersion,
      newAmountAtomic: adjustment.observedChainAmountAtomic,
      newStatus,
      mutationType: 'RECONCILIATION_ADJUSTMENT',
      reconciliationRequired: false
    }, externalClient);
  }

  public async markReconciliationRequired(
    positionId: string,
    expectedVersion: PositionVersion,
    required: boolean
  ): Promise<DurablePosition> {
    const res = await this.pool.query(
      `UPDATE nexus_positions_v2
       SET reconciliation_required = $1, updated_at = NOW()
       WHERE position_id = $2 AND position_version = $3
       RETURNING *;`,
      [required, positionId, expectedVersion.toString()]
    );
    if (res.rowCount === 0) {
      const pos = await this.getPosition(positionId);
      if (!pos) {
        throw new PositionNotFoundError(`Position ${positionId} not found`, positionId);
      }
      throw new StalePositionVersionError(
        `markReconciliationRequired CAS failed: expected version ${expectedVersion}, found ${pos.positionVersion}`,
        positionId,
        expectedVersion,
        pos.positionVersion
      );
    }
    return this.mapRowToPosition(res.rows[0]);
  }
}
