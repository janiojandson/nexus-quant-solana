/**
 * Nexus Quant Solana — V2.3A Durable Position Versioning & OCC Types
 *
 * Core contracts guaranteeing that financial actions are constructed for:
 * - THE RIGHT POSITION
 * - AT THE RIGHT VERSION
 * - WITH THE RIGHT AMOUNT
 */

import {
  PositionVersion,
  PositionId,
  TradeId,
  SolanaSignature,
  WallMs,
  MonotonicNs,
  nowWallMs,
  nowMonotonicNs
} from '../types/telemetry.js';

export {
  PositionVersion,
  PositionId,
  TradeId,
  SolanaSignature,
  WallMs,
  MonotonicNs,
  nowWallMs,
  nowMonotonicNs
};

export type PositionStatus = 'OPEN' | 'PARTIAL_CLOSED' | 'CLOSED' | 'TERMINATED';

export type PositionMutationType =
  | 'ENTRY_OPEN'
  | 'PARTIAL_FILL'
  | 'FINAL_FILL'
  | 'RECONCILIATION_ADJUSTMENT'
  | 'MANUAL_CORRECTION';

export const DEFAULT_TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

/**
 * Immutable economic snapshot of a position captured at a specific point in time.
 * Financial decisions receive this snapshot and must NOT assume the position
 * remains at this version during downstream steps without re-verification.
 */
export interface PositionSnapshot {
  readonly positionId: string;
  readonly tradeId: string;
  readonly walletId: string;
  readonly mint: string;
  readonly tokenProgram: string;
  readonly status: PositionStatus;
  readonly positionVersion: PositionVersion;
  readonly tokenAmountAtomic: bigint;
  readonly initialAmountAtomic: bigint;
  readonly initialPrincipalLamports: bigint;
  readonly confirmedProceedsLamports: bigint;
  readonly reconciliationRequired: boolean;
  readonly capturedAtWallMs: number;
  readonly capturedAtMonoNs: bigint;
}

/**
 * Mutable domain representation of a durable versioned position.
 */
export interface DurablePosition {
  readonly positionId: string;
  readonly tradeId: string;
  readonly walletId: string;
  readonly mint: string;
  readonly tokenProgram: string;
  status: PositionStatus;
  positionVersion: PositionVersion;
  tokenAmountAtomic: bigint;
  readonly initialAmountAtomic: bigint;
  readonly initialPrincipalLamports: bigint;
  confirmedProceedsLamports: bigint;
  readonly openedAt: Date;
  updatedAt: Date;
  closedAt?: Date | null;
  lastFillId?: string | null;
  lastChainSignature?: string | null;
  reconciliationRequired: boolean;
  source: string;
  provenance?: string | null;
}

export interface PositionMutationRecord {
  readonly id?: number;
  readonly positionId: string;
  readonly fromVersion: PositionVersion;
  readonly toVersion: PositionVersion;
  readonly mutationType: PositionMutationType;
  readonly fillId?: string | null;
  readonly signature?: string | null;
  readonly tokenAmountBefore: bigint;
  readonly tokenAmountAfter: bigint;
  readonly deltaAtomic: bigint;
  readonly proceedsLamports: bigint;
  readonly createdAt: Date;
}

export interface CreatePositionInput {
  positionId: string;
  tradeId: string;
  walletId: string;
  mint: string;
  tokenProgram?: string;
  status?: PositionStatus;
  initialAmountAtomic: bigint;
  tokenAmountAtomic?: bigint;
  initialPrincipalLamports: bigint;
  source?: string;
  provenance?: string | null;
  initialVersion?: PositionVersion;
}

export interface UpdatePositionCASParams {
  positionId: string;
  expectedVersion: PositionVersion;
  newAmountAtomic: bigint;
  newStatus?: PositionStatus;
  proceedsDeltaLamports?: bigint;
  fillId?: string | null;
  signature?: string | null;
  mutationType: PositionMutationType;
  reconciliationRequired?: boolean;
}

export interface ApplyFillParams {
  positionId: string;
  expectedVersion: PositionVersion;
  fillId: string;
  signature: string;
  fillAmountAtomic: bigint;
  proceedsLamports: bigint;
  isFinal?: boolean;
}

export interface ExternalBalanceDivergenceAdjustment {
  positionId: string;
  expectedVersion: PositionVersion;
  observedChainAmountAtomic: bigint;
  evidence: string;
}

export class StalePositionVersionError extends Error {
  constructor(
    message: string,
    public readonly positionId: string,
    public readonly expectedVersion: PositionVersion,
    public readonly actualVersion?: PositionVersion
  ) {
    super(message);
    this.name = 'StalePositionVersionError';
  }
}

export class DuplicateFillApplicationError extends Error {
  constructor(
    message: string,
    public readonly positionId: string,
    public readonly fillId: string
  ) {
    super(message);
    this.name = 'DuplicateFillApplicationError';
  }
}

export class ActivePositionConflictError extends Error {
  constructor(
    message: string,
    public readonly walletId: string,
    public readonly mint: string,
    public readonly activePositionId: string
  ) {
    super(message);
    this.name = 'ActivePositionConflictError';
  }
}

export class PositionNotFoundError extends Error {
  constructor(message: string, public readonly positionId: string) {
    super(message);
    this.name = 'PositionNotFoundError';
  }
}

export class ArbitraryBalanceMutationRejectedError extends Error {
  constructor(message: string, public readonly positionId: string, public readonly details?: Record<string, unknown>) {
    super(message);
    this.name = 'ArbitraryBalanceMutationRejectedError';
  }
}

export class AmbiguousTokenAccountCustodyError extends Error {
  constructor(message: string, public readonly walletId: string, public readonly mint: string, public readonly details?: Record<string, unknown>) {
    super(message);
    this.name = 'AmbiguousTokenAccountCustodyError';
  }
}

export interface ApplyConfirmedFillInput {
  positionId: string;
  expectedVersion: PositionVersion;
  fillId: string;
  signature: string;
  confirmedActualDebitAtomic: bigint;
  grossProceedsLamports: bigint;
  evidenceType?: string;
  isFinal?: boolean;
}

export interface ReconciliationEvidenceMetadata {
  source: string;
  slot?: number | bigint;
  observedAtWallMs: number;
  reason: string;
  operatorSignature?: string;
}

export interface ApplyReconciliationAdjustmentInput {
  positionId: string;
  expectedVersion: PositionVersion;
  observedBalanceAtomic: bigint;
  evidence: ReconciliationEvidenceMetadata;
}

/**
 * Creates an immutable PositionSnapshot from a DurablePosition.
 */
export function takePositionSnapshot(pos: DurablePosition): Readonly<PositionSnapshot> {
  return Object.freeze({
    positionId: pos.positionId,
    tradeId: pos.tradeId,
    walletId: pos.walletId,
    mint: pos.mint,
    tokenProgram: pos.tokenProgram,
    status: pos.status,
    positionVersion: pos.positionVersion,
    tokenAmountAtomic: pos.tokenAmountAtomic,
    initialAmountAtomic: pos.initialAmountAtomic,
    initialPrincipalLamports: pos.initialPrincipalLamports,
    confirmedProceedsLamports: pos.confirmedProceedsLamports,
    reconciliationRequired: pos.reconciliationRequired,
    capturedAtWallMs: Date.now(),
    capturedAtMonoNs: process.hrtime.bigint()
  });
}
