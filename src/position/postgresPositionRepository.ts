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

  public async getPosition(positionId: string): Promise<DurablePosition | null> {
    const res = await this.pool.query(
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

  public async updatePositionCAS(params: UpdatePositionCASParams): Promise<{
    position: DurablePosition;
    mutation: PositionMutationRecord;
  }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

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

      await client.query('COMMIT');
      return { position: updatedPos, mutation };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  public async applyFill(params: ApplyFillParams): Promise<{
    position: DurablePosition;
    mutation: PositionMutationRecord;
    alreadyApplied: boolean;
  }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // 1. Check if fill was already recorded for this position
      const checkFillSql = `
        SELECT * FROM nexus_position_mutations_v2
        WHERE position_id = $1 AND fill_id = $2
        LIMIT 1;
      `;
      const existingRes = await client.query(checkFillSql, [params.positionId, params.fillId]);
      if (existingRes.rows.length > 0) {
        // Fill already applied
        const posRes = await client.query(
          'SELECT * FROM nexus_positions_v2 WHERE position_id = $1;',
          [params.positionId]
        );
        await client.query('COMMIT');
        return {
          position: this.mapRowToPosition(posRes.rows[0]),
          mutation: this.mapRowToMutation(existingRes.rows[0]),
          alreadyApplied: true
        };
      }

      // 2. Lock position and verify expected version
      const posRes = await client.query(
        'SELECT * FROM nexus_positions_v2 WHERE position_id = $1 FOR UPDATE;',
        [params.positionId]
      );
      if (posRes.rows.length === 0) {
        throw new PositionNotFoundError(`Position ${params.positionId} not found`, params.positionId);
      }

      const currentPos = this.mapRowToPosition(posRes.rows[0]);
      if (currentPos.positionVersion !== params.expectedVersion) {
        throw new StalePositionVersionError(
          `Fill application rejected for position ${params.positionId}: expected version ${params.expectedVersion}, found ${currentPos.positionVersion}`,
          params.positionId,
          params.expectedVersion,
          currentPos.positionVersion
        );
      }

      if (params.fillAmountAtomic > currentPos.tokenAmountAtomic) {
        throw new Error(
          `Fill amount ${params.fillAmountAtomic} exceeds current balance ${currentPos.tokenAmountAtomic}`
        );
      }

      const newAmount = currentPos.tokenAmountAtomic - params.fillAmountAtomic;
      const isFinal = Boolean(params.isFinal || newAmount === 0n);
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
        params.proceedsLamports.toString(),
        params.fillId,
        params.signature,
        params.positionId,
        params.expectedVersion.toString()
      ]);

      if (updateRes.rowCount === 0) {
        throw new StalePositionVersionError(
          `CAS update failed during fill application for position ${params.positionId}`,
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
        mutationType,
        params.fillId,
        params.signature,
        currentPos.tokenAmountAtomic.toString(),
        newAmount.toString(),
        (-params.fillAmountAtomic).toString(),
        params.proceedsLamports.toString()
      ]);

      const mutation = this.mapRowToMutation(mutationRes.rows[0]);

      await client.query('COMMIT');
      return {
        position: updatedPos,
        mutation,
        alreadyApplied: false
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  public async reconcileExternalBalance(adjustment: ExternalBalanceDivergenceAdjustment): Promise<{
    position: DurablePosition;
    mutation: PositionMutationRecord;
  }> {
    const pos = await this.getPosition(adjustment.positionId);
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
    });
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
