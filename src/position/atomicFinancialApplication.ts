/**
 * Nexus Quant Solana — Missão V2.3-R
 * Shared Transaction Boundary for Journal + Position (Commit R4)
 *
 * Implements P1-06 & R-P1-01:
 * Executes the complete financial application inside a SINGLE database transaction
 * using a single shared PoolClient:
 *
 * BEGIN
 *   Lock position FOR UPDATE
 *   Lock intent FOR UPDATE
 *   Lock attempt FOR UPDATE and validate FK
 *   Validate Economic Identity (intent <-> position <-> fill)
 *   Verify claim epoch
 *   recordFill in journal (append-only fill ledger)
 *   applyConfirmedFill on position (OCC CAS version bump & mutation)
 *   update intent status & clear reconciliation debt atomically
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
  PositionNotFoundError,
  EconomicIdentityMismatchError
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
 *
 * Implements FASE 10 and Finding R-P1-01:
 * - Validates intent-position-fill economic identity
 * - Locks position, intent, and attempt rows FOR UPDATE
 * - Validates attempt FK
 * - Inserts fill in append-only ledger
 * - Mutates position with OCC version check
 * - Marks Intent APPLIED and clears debt atomically
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
    const posRow = posLockRes.rows[0];

    // 2. Lock intent row FOR UPDATE
    const intentLockRes = await client.query(
      'SELECT * FROM exit_intents WHERE id = $1 FOR UPDATE',
      [params.fill.intentId]
    );
    if (intentLockRes.rows.length === 0) {
      throw new Error(`ExitIntent ${params.fill.intentId} not found`);
    }
    const intentRow = intentLockRes.rows[0];

    // 3. Lock attempt row FOR UPDATE and validate attempt FK
    const attemptLockRes = await client.query(
      'SELECT * FROM execution_attempts WHERE attempt_id = $1 FOR UPDATE',
      [params.fill.attemptId]
    );
    if (attemptLockRes.rows.length === 0) {
      throw new EconomicIdentityMismatchError(
        `ExecutionAttempt ${params.fill.attemptId} not found for fill`,
        { attemptId: params.fill.attemptId }
      );
    }
    const attemptRow = attemptLockRes.rows[0];
    if (attemptRow.intent_id !== intentRow.id) {
      throw new EconomicIdentityMismatchError(
        `Attempt intent_id (${attemptRow.intent_id}) does not match Intent id (${intentRow.id})`,
        { attemptIntentId: attemptRow.intent_id, intentId: intentRow.id }
      );
    }

    // 4. Validate Economic Identity (Finding R-P1-01)
    if (intentRow.position_id !== posRow.position_id) {
      throw new EconomicIdentityMismatchError(
        `Intent position_id (${intentRow.position_id}) does not match Position id (${posRow.position_id})`,
        { intentPositionId: intentRow.position_id, positionId: posRow.position_id }
      );
    }
    if (intentRow.wallet_id !== posRow.wallet_id) {
      throw new EconomicIdentityMismatchError(
        `Intent wallet_id (${intentRow.wallet_id}) does not match Position wallet_id (${posRow.wallet_id})`,
        { intentWalletId: intentRow.wallet_id, positionWalletId: posRow.wallet_id }
      );
    }
    if (intentRow.mint !== posRow.mint) {
      throw new EconomicIdentityMismatchError(
        `Intent mint (${intentRow.mint}) does not match Position mint (${posRow.mint})`,
        { intentMint: intentRow.mint, positionMint: posRow.mint }
      );
    }
    if (intentRow.token_program !== posRow.token_program) {
      throw new EconomicIdentityMismatchError(
        `Intent token_program (${intentRow.token_program}) does not match Position token_program (${posRow.token_program})`,
        { intentTokenProgram: intentRow.token_program, positionTokenProgram: posRow.token_program }
      );
    }
    if (params.fill.positionId !== posRow.position_id) {
      throw new EconomicIdentityMismatchError(
        `Fill positionId (${params.fill.positionId}) does not match Position id (${posRow.position_id})`,
        { fillPositionId: params.fill.positionId, positionId: posRow.position_id }
      );
    }
    if (params.fill.intentId !== intentRow.id) {
      throw new EconomicIdentityMismatchError(
        `Fill intentId (${params.fill.intentId}) does not match Intent id (${intentRow.id})`,
        { fillIntentId: params.fill.intentId, intentId: intentRow.id }
      );
    }
    if (params.fill.assetMint && params.fill.assetMint !== posRow.mint) {
      throw new EconomicIdentityMismatchError(
        `Fill assetMint (${params.fill.assetMint}) does not match Position mint (${posRow.mint})`,
        { fillAssetMint: params.fill.assetMint, positionMint: posRow.mint }
      );
    }

    // 5. Verify claim epoch
    if (BigInt(intentRow.claim_epoch) !== BigInt(params.expectedEpoch)) {
      throw new StaleEpochError(
        `Stale claim epoch for fill on intent ${params.fill.intentId}: expected ${params.expectedEpoch}, actual ${intentRow.claim_epoch}`,
        params.fill.intentId,
        BigInt(params.expectedEpoch),
        BigInt(intentRow.claim_epoch)
      );
    }

    // 6. Record fill in journal ledger using shared client
    const fillRes = await params.journalRepo.recordFill(
      params.fill,
      params.expectedEpoch,
      client
    );

    // 7. Apply confirmed fill to position using same shared client
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

    // 8. Atomically update Intent and clear debt
    const isClosed = posRes.position.tokenAmountAtomic === 0n || params.isFinal;
    if (isClosed) {
      await client.query(
        `UPDATE exit_intents
         SET status = 'APPLIED', reconciliation_debt = false
         WHERE id = $1`,
        [intentRow.id]
      );
    } else {
      await client.query(
        `UPDATE exit_intents
         SET reconciliation_debt = false
         WHERE id = $1`,
        [intentRow.id]
      );
    }

    await client.query(
      `UPDATE execution_attempts
       SET state = CASE WHEN state IN ('PREPARED', 'SIGNED', 'SUBMITTED', 'UNKNOWN', 'PROVIDER_RECEIPT') THEN 'CONFIRMED' ELSE state END,
           confirmed_at = COALESCE(confirmed_at, NOW())
       WHERE attempt_id = $1`,
      [params.fill.attemptId]
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
