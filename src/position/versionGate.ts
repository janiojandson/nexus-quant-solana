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

import { PositionVersion } from '../types/telemetry.js';
import { PositionSnapshot } from './types.js';
import { BoundExecutionQuote } from './quoteBinding.js';
import { ExitIntent, ExitIntentStatus } from '../journal/types.js';

export function isPositionVersionGateEnabled(): boolean {
  return process.env.NEXUS_V2_POSITION_VERSION_GATE_ENABLED === 'true';
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
  intent: ExitIntent
): IntentSupersedeDecision {
  switch (intent.status) {
    case 'CREATED':
    case 'CLAIMED':
    case 'PREPARED':
      return {
        canSupersedeSafely: true,
        action: 'SUPERSEDE',
        status: intent.status,
        reason: `Intent ${intent.id} is in pre-broadcast state ${intent.status}; safe to supersede.`
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
