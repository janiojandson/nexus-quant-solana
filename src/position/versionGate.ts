/**
 * Nexus Quant Solana — V2.3A Pre-Send Version Gate & Supersede Policy
 *
 * Implements strict pre-send gate checking:
 * 1. current.positionVersion === quote.positionVersion
 * 2. current.tokenAmountAtomic === quote.requestedAmountAtomic (FULL_REMAINDER)
 * 3. quote.requestedAmountAtomic <= current.tokenAmountAtomic (PARTIAL)
 * 4. Zero send / broadcast occurs on STALE quote detection
 * 5. Intent superseding for early states (CREATED, CLAIMED, PREPARED) vs MUST_RECONCILE for (SIGNED, SUBMITTED, UNKNOWN)
 */

import { randomUUID } from 'crypto';
import { PositionVersion } from '../types/telemetry.js';
import { PositionSnapshot, ReconciliationEvidenceMetadata, takePositionSnapshot } from './types.js';
import { BoundExecutionQuote } from './quoteBinding.js';
import { ExitIntent, ExitIntentStatus, ExecutionAttempt, hasPotentiallyLiveChainAttempt } from '../journal/types.js';
import { validateFeatureFlagMatrix } from './shadowPosition.js';
import { IPositionRepository } from './repository.js';
import { reconcilePositionCustody } from './custody.js';

export function isPositionVersionGateEnabled(): boolean {
  if (process.env.NEXUS_V2_POSITION_VERSION_GATE_ENABLED !== 'true') {
    return false;
  }
  const matrix = validateFeatureFlagMatrix();
  return matrix.positionVersionGate;
}

export type VersionGateDecision =
  | { allowed: true; reason: 'VERSION_AND_AMOUNT_MATCH' }
  | {
      allowed: false;
      code: 'QUOTE_STALE_FOR_POSITION';
      reason: string;
      expectedVersion: PositionVersion;
      currentVersion: PositionVersion;
    }
  | {
      allowed: false;
      code: 'QUOTE_AMOUNT_MISMATCH';
      reason: string;
      expectedAmount: bigint;
      currentAmount: bigint;
    }
  | {
      allowed: false;
      code: 'POSITION_RECONCILIATION_REQUIRED';
      reason: string;
    };

export function evaluatePreSendVersionGate(params: {
  currentPosition: PositionSnapshot;
  boundQuote: BoundExecutionQuote;
  intentPolicy: 'FULL_REMAINDER' | 'PARTIAL_50' | 'CUSTOM';
  intendedAmountAtomic?: bigint;
}): VersionGateDecision {
  // 1. Reconciliation debt check
  if (params.currentPosition.reconciliationRequired) {
    return {
      allowed: false,
      code: 'POSITION_RECONCILIATION_REQUIRED',
      reason: `Position ${params.currentPosition.positionId} has pending reconciliation debt; irreversible broadcast blocked.`
    };
  }

  // 2. Position Version check
  if (params.currentPosition.positionVersion !== params.boundQuote.positionVersion) {
    return {
      allowed: false,
      code: 'QUOTE_STALE_FOR_POSITION',
      reason: `Quote bound to version ${params.boundQuote.positionVersion}, but current position is version ${params.currentPosition.positionVersion}`,
      expectedVersion: params.boundQuote.positionVersion,
      currentVersion: params.currentPosition.positionVersion
    };
  }

  // 3. Intended amount vs Quote amount check (detects rounding bug, reused quote, or wrong tranche)
  if (
    params.intendedAmountAtomic !== undefined &&
    params.boundQuote.requestedAmountAtomic !== params.intendedAmountAtomic
  ) {
    return {
      allowed: false,
      code: 'QUOTE_AMOUNT_MISMATCH',
      reason: `Quote requested amount ${params.boundQuote.requestedAmountAtomic} does not match intended amount ${params.intendedAmountAtomic}`,
      expectedAmount: params.intendedAmountAtomic,
      currentAmount: params.boundQuote.requestedAmountAtomic
    };
  }

  // 4. Policy-specific checks
  if (params.intentPolicy === 'FULL_REMAINDER') {
    if (params.boundQuote.requestedAmountAtomic !== params.currentPosition.tokenAmountAtomic) {
      return {
        allowed: false,
        code: 'QUOTE_AMOUNT_MISMATCH',
        reason: `FULL_REMAINDER requires quote amount (${params.boundQuote.requestedAmountAtomic}) to equal position balance (${params.currentPosition.tokenAmountAtomic})`,
        expectedAmount: params.currentPosition.tokenAmountAtomic,
        currentAmount: params.boundQuote.requestedAmountAtomic
      };
    }
  } else {
    // Partial / custom: quote amount cannot exceed available position balance
    if (params.boundQuote.requestedAmountAtomic > params.currentPosition.tokenAmountAtomic) {
      return {
        allowed: false,
        code: 'QUOTE_AMOUNT_MISMATCH',
        reason: `Partial quote amount (${params.boundQuote.requestedAmountAtomic}) exceeds available position balance (${params.currentPosition.tokenAmountAtomic})`,
        expectedAmount: params.currentPosition.tokenAmountAtomic,
        currentAmount: params.boundQuote.requestedAmountAtomic
      };
    }
  }

  return { allowed: true, reason: 'VERSION_AND_AMOUNT_MATCH' };
}

export class DispatchReservationConflictError extends Error {
  public readonly positionId: string;
  public readonly activeVersion: PositionVersion;
  public readonly activeIntentId?: string;

  constructor(positionId: string, activeVersion: PositionVersion, activeIntentId: string | undefined, message: string) {
    super(message);
    this.name = 'DispatchReservationConflictError';
    this.positionId = positionId;
    this.activeVersion = activeVersion;
    this.activeIntentId = activeIntentId;
  }
}

export interface DispatchReservationReceipt {
  readonly reservationToken: string;
  readonly positionId: string;
  readonly expectedVersion: PositionVersion;
  readonly reservedAtWallMs: number;
  readonly intentId?: string;
  release: () => void;
}

export interface ActiveDispatchReservation {
  readonly reservationToken: string;
  readonly positionId: string;
  readonly expectedVersion: PositionVersion;
  readonly reservedAtWallMs: number;
  readonly intentId?: string;
  readonly timeoutMs: number;
}

/**
 * Requirement (P0-01 TOCTOU):
 * Manages dispatch reservations between pre-send gate evaluation and irreversible broadcast.
 *
 * TOCTOU Mitigation Notice:
 * In-process TOCTOU between gate evaluation and broadcast is mitigated by DispatchReservationManager.
 * However, true cross-process / multi-worker fencing requires the SingleFinancialWriter architecture (V2.2).
 * Until V2.2 monitor decoupling is complete, this gate remains NOT SAFE FOR UNCOORDINATED MULTI-PROCESS PRODUCTION.
 */
export class DispatchReservationManager {
  private activeReservations = new Map<string, ActiveDispatchReservation>();
  private defaultTimeoutMs: number;

  constructor(defaultTimeoutMs: number = 15_000) {
    this.defaultTimeoutMs = defaultTimeoutMs;
  }

  public reserve(params: {
    positionId: string;
    expectedVersion: PositionVersion;
    intentId?: string;
    timeoutMs?: number;
  }): DispatchReservationReceipt {
    const now = Date.now();
    const timeoutMs = params.timeoutMs ?? this.defaultTimeoutMs;
    const existing = this.activeReservations.get(params.positionId);

    if (existing) {
      if (now - existing.reservedAtWallMs < existing.timeoutMs) {
        throw new DispatchReservationConflictError(
          params.positionId,
          existing.expectedVersion,
          existing.intentId,
          `Concurrent dispatch reservation active for position ${params.positionId} (intent=${existing.intentId || 'none'}, version=${existing.expectedVersion}). Irreversible broadcast blocked to prevent TOCTOU race.`
        );
      }
      // Expired reservation - remove it
      this.activeReservations.delete(params.positionId);
    }

    const token = randomUUID();
    const reservation: ActiveDispatchReservation = {
      reservationToken: token,
      positionId: params.positionId,
      expectedVersion: params.expectedVersion,
      reservedAtWallMs: now,
      intentId: params.intentId,
      timeoutMs
    };

    this.activeReservations.set(params.positionId, reservation);

    return {
      reservationToken: token,
      positionId: params.positionId,
      expectedVersion: params.expectedVersion,
      reservedAtWallMs: now,
      intentId: params.intentId,
      release: () => {
        const cur = this.activeReservations.get(params.positionId);
        if (cur && cur.reservationToken === token) {
          this.activeReservations.delete(params.positionId);
        }
      }
    };
  }

  public getActiveReservation(positionId: string): ActiveDispatchReservation | null {
    const res = this.activeReservations.get(positionId);
    if (!res) return null;
    if (Date.now() - res.reservedAtWallMs >= res.timeoutMs) {
      this.activeReservations.delete(positionId);
      return null;
    }
    return res;
  }

  public release(positionId: string, token: string): void {
    const cur = this.activeReservations.get(positionId);
    if (cur && cur.reservationToken === token) {
      this.activeReservations.delete(positionId);
    }
  }

  public clearAll(): void {
    this.activeReservations.clear();
  }
}

export const defaultDispatchReservationManager = new DispatchReservationManager();

export type ReservedVersionGateDecision =
  | {
      allowed: true;
      reason: 'VERSION_AND_AMOUNT_MATCH';
      receipt: DispatchReservationReceipt;
    }
  | {
      allowed: false;
      code:
        | 'QUOTE_STALE_FOR_POSITION'
        | 'QUOTE_AMOUNT_MISMATCH'
        | 'POSITION_RECONCILIATION_REQUIRED'
        | 'DISPATCH_RESERVATION_CONFLICT';
      reason: string;
      expectedVersion?: PositionVersion;
      currentVersion?: PositionVersion;
      expectedAmount?: bigint;
      currentAmount?: bigint;
    };

export function evaluateAndReservePreSendGate(params: {
  currentPosition: PositionSnapshot;
  boundQuote: BoundExecutionQuote;
  intentPolicy: 'FULL_REMAINDER' | 'PARTIAL_50' | 'CUSTOM';
  intendedAmountAtomic?: bigint;
  intentId?: string;
  timeoutMs?: number;
  reservationManager?: DispatchReservationManager;
}): ReservedVersionGateDecision {
  const decision = evaluatePreSendVersionGate(params);
  if (!decision.allowed) {
    return decision;
  }

  const mgr = params.reservationManager ?? defaultDispatchReservationManager;
  try {
    const receipt = mgr.reserve({
      positionId: params.currentPosition.positionId,
      expectedVersion: params.currentPosition.positionVersion,
      intentId: params.intentId,
      timeoutMs: params.timeoutMs
    });
    return {
      allowed: true,
      reason: 'VERSION_AND_AMOUNT_MATCH',
      receipt
    };
  } catch (err: any) {
    if (err instanceof DispatchReservationConflictError) {
      return {
        allowed: false,
        code: 'DISPATCH_RESERVATION_CONFLICT',
        reason: err.message,
        expectedVersion: params.boundQuote.positionVersion,
        currentVersion: params.currentPosition.positionVersion
      };
    }
    throw err;
  }
}

/**
 * Reconciles custody balance against on-chain evidence before evaluating pre-send gate (P1-09, P0-01).
 * If on-chain balance diverged (e.g. external transfer/burn), bumps position version,
 * causing stale quote revalidation to fail-closed.
 */
export async function revalidateCustodyAndEvaluateGate(params: {
  positionRepo: IPositionRepository;
  positionId: string;
  boundQuote: BoundExecutionQuote;
  intentPolicy: 'FULL_REMAINDER' | 'PARTIAL_50' | 'CUSTOM';
  observedAtaBalanceAtomic?: bigint;
  evidence?: ReconciliationEvidenceMetadata;
  intendedAmountAtomic?: bigint;
  intentId?: string;
  timeoutMs?: number;
  reservationManager?: DispatchReservationManager;
}): Promise<ReservedVersionGateDecision> {
  const currentPos = await params.positionRepo.getPosition(params.positionId);
  if (!currentPos) {
    throw new Error(`Position ${params.positionId} not found in repository`);
  }

  // Reconcile custody if external balance is observed
  if (params.observedAtaBalanceAtomic !== undefined && params.evidence !== undefined) {
    await reconcilePositionCustody({
      positionRepo: params.positionRepo,
      positionId: params.positionId,
      expectedVersion: currentPos.positionVersion,
      observedAtaBalanceAtomic: params.observedAtaBalanceAtomic,
      evidence: params.evidence
    });
  }

  const freshPos = await params.positionRepo.getPosition(params.positionId);
  if (!freshPos) {
    throw new Error(`Position ${params.positionId} disappeared after custody reconciliation`);
  }

  return evaluateAndReservePreSendGate({
    currentPosition: takePositionSnapshot(freshPos),
    boundQuote: params.boundQuote,
    intentPolicy: params.intentPolicy,
    intendedAmountAtomic: params.intendedAmountAtomic,
    intentId: params.intentId,
    timeoutMs: params.timeoutMs,
    reservationManager: params.reservationManager
  });
}

export type IntentSupersedeAction =
  | 'SUPERSEDE'
  | 'MUST_RECONCILE'
  | 'ALREADY_TERMINAL';

export interface IntentSupersedeDecision {
  canSupersedeSafely: boolean;
  action: IntentSupersedeAction;
  status: ExitIntentStatus;
  reason: string;
}

/**
 * Requirement 9: Pre-Send Supersede Evaluation
 * CREATED, CLAIMED, PREPARED (unsigned/unsent) -> can be SUPERSEDED.
 * SIGNED, SUBMITTED, UNKNOWN -> CANNOT be superseded; requires MUST_RECONCILE.
 */
export function evaluateIntentSupersedeEligibility(
  intent: ExitIntent,
  attempts: ExecutionAttempt[] = []
): IntentSupersedeDecision {
  if (hasPotentiallyLiveChainAttempt(attempts)) {
    return {
      canSupersedeSafely: false,
      action: 'MUST_RECONCILE',
      status: intent.status,
      reason: `Intent ${intent.id} has potentially live on-chain attempt(s) (signed, submitted, or with signature); cannot supersede without on-chain reconciliation.`
    };
  }

  switch (intent.status) {
    case 'CREATED':
    case 'CLAIMED':
    case 'PREPARED':
      return {
        canSupersedeSafely: true,
        action: 'SUPERSEDE',
        status: intent.status,
        reason: `Intent ${intent.id} is in pre-broadcast state ${intent.status} with unsigned/unsent attempts; safe to supersede.`
      };

    case 'SUBMITTED':
    case 'UNKNOWN':
      return {
        canSupersedeSafely: false,
        action: 'MUST_RECONCILE',
        status: intent.status,
        reason: `Intent ${intent.id} is in broadcast/uncertain state ${intent.status}; cannot supersede without on-chain reconciliation.`
      };

    case 'CONFIRMED':
    case 'APPLIED':
    case 'SUPERSEDED':
    case 'CANCELLED':
    case 'FAILED_DEFINITIVE':
      return {
        canSupersedeSafely: false,
        action: 'ALREADY_TERMINAL',
        status: intent.status,
        reason: `Intent ${intent.id} is already in terminal/confirmed state ${intent.status}.`
      };

    default:
      return {
        canSupersedeSafely: false,
        action: 'MUST_RECONCILE',
        status: intent.status,
        reason: `Intent ${intent.id} is in unexpected status ${intent.status}; defaulting to MUST_RECONCILE.`
      };
  }
}
