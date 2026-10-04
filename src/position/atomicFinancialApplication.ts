/**
 * Nexus Quant Solana — Missão V2.3-R
 * Shared Transaction Boundary for Journal + Position (Commit R4)
 *
 * Implements P1-06:
 * Executes the complete financial application inside a SINGLE database transaction
 * using a single shared PoolClient:
 *
 * BEGIN
 *   Lock position FOR UPDATE
 *   Lock intent FOR UPDATE & verify claim epoch
 *   recordFill in journal (append-only fill ledger)
 *   applyConfirmedFill on position (OCC CAS version bump & mutation)
 *   update intent status & clear reconciliation debt
 * COMMIT
 * (ROLLBACK on any failure)
 */

import { Pool, PoolClient } from 'pg';
import { PostgresJournalRepository } from '../journal/postgresRepository.js';
import { PostgresPositionRepository } from './postgresPositionRepository.js';
import { FillRecord, StaleEpochError } from '../journal/types.js';
import {
  DurablePosition,
  PositionMutationRecord,
  PositionVersion,
  PositionNotFoundError
} from './types.js';

export interface AtomicFillApplicationParams {
  pool: Pool;
  journalRepo: PostgresJournalRepository;
  positionRepo: PostgresPositionRepository;
  fill: FillRecord;
  expectedEpoch: bigint | number;
  expectedPositionVersion: PositionVersion;
  isFinal?: boolean;
}

export interface AtomicFillApplicationResult {
  fill: FillRecord;
  fillCreated: boolean;
  position: DurablePosition;
  positionMutation: PositionMutationRecord;
  positionAlreadyApplied: boolean;
}

/**
 * Executes confirmed fill recording and position debit within a single atomic PostgreSQL transaction.
 * If either journal insertion or position mutation fails, both are rolled back.
 */
export async function applyConfirmedFillAtomically(
  params: AtomicFillApplicationParams
): Promise<AtomicFillApplicationResult> {
  const client: PoolClient = await params.pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Lock position row FOR UPDATE
    const posLockRes = await client.query(
      'SELECT * FROM nexus_positions_v2 WHERE position_id = $1 FOR UPDATE',
      [params.fill.positionId]
    );
    if (posLockRes.rows.length === 0) {
      throw new PositionNotFoundError(`Position ${params.fill.positionId} not found`, params.fill.positionId);
    }

    // 2. Lock intent row FOR UPDATE and verify claim epoch
    const intentLockRes = await client.query(
      'SELECT * FROM exit_intents WHERE id = $1 FOR UPDATE',
      [params.fill.intentId]
    );
    if (intentLockRes.rows.length === 0) {
      throw new Error(`ExitIntent ${params.fill.intentId} not found`);
    }
    const intentRow = intentLockRes.rows[0];
    if (BigInt(intentRow.claim_epoch) !== BigInt(params.expectedEpoch)) {
      throw new StaleEpochError(
        `Stale claim epoch for fill on intent ${params.fill.intentId}: expected ${params.expectedEpoch}, actual ${intentRow.claim_epoch}`,
        params.fill.intentId,
        BigInt(params.expectedEpoch),
        BigInt(intentRow.claim_epoch)
      );
    }

    // 3. Record fill in journal ledger using shared client
    const fillRes = await params.journalRepo.recordFill(
      params.fill,
      params.expectedEpoch,
      client
    );

    // 4. Apply confirmed fill to position using same shared client
    const posRes = await params.positionRepo.applyConfirmedFill(
      {
        positionId: params.fill.positionId,
        expectedVersion: params.expectedPositionVersion,
        fillId: params.fill.id,
        signature: params.fill.signature,
        confirmedActualDebitAtomic: BigInt(params.fill.actualAmountAtomic),
        grossProceedsLamports: BigInt(params.fill.grossProceedsLamports),
        evidenceType: params.fill.evidenceType,
        isFinal: params.isFinal
      },
      client
    );

    await client.query('COMMIT');

    return {
      fill: fillRes.fill,
      fillCreated: fillRes.created,
      position: posRes.position,
      positionMutation: posRes.mutation,
      positionAlreadyApplied: posRes.alreadyApplied
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
