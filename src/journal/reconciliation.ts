/**
 * Nexus Quant Solana — V2.1A Reconciliation State Machine
 *
 * Provides pure, deterministic reconciliation evaluation functions for execution attempts.
 *
 * Invariants:
 * 1. Pure function: no network I/O, no DB side-effects, deterministic outputs.
 * 2. UNKNOWN !== FAILED_DEFINITIVE. HTTP timeouts or inconclusive RPC statuses
 *    MUST produce UNKNOWN or MUST_RECONCILE, NEVER FAILED_DEFINITIVE.
 * 3. FAILED_DEFINITIVE requires proven evidence: on-chain execution error OR
 *    blockhash expiration without inclusion.
 * 4. Only CONFIRMED and FAILED_DEFINITIVE are terminal verdicts.
 */

import {
  ExecutionAttempt,
  ReconciliationVerdict,
  SolanaSignature
} from './types';

export interface OnChainReconciliationEvidence {
  readonly signature?: SolanaSignature;
  readonly signatureFound?: boolean;
  readonly err?: unknown;
  readonly confirmationStatus?: 'processed' | 'confirmed' | 'finalized' | null;
  readonly slot?: number | null;
  readonly blockhashValid?: boolean | null;
  readonly blockhashExpired?: boolean | null;
  readonly recentBlockhash?: string | null;
  readonly tokenBalanceDeltaAtomic?: string | null;
  readonly solBalanceDeltaLamports?: string | null;
  readonly httpTimeout?: boolean;
  readonly rpcError?: string | null;
}

export interface ReconciliationEvaluationResult {
  readonly verdict: ReconciliationVerdict;
  readonly reason: string;
  readonly canRetry: boolean;
  readonly requiresReconciliation: boolean;
  readonly isTerminal: boolean;
  readonly onChainStatus: 'CONFIRMED' | 'FAILED' | 'PENDING' | 'DROPPED' | 'UNKNOWN';
}

/**
 * Pure evaluation function mapping (attempt, onChainEvidence) to a formal ReconciliationEvaluationResult.
 */
export function evaluateReconciliationState(
  attempt: ExecutionAttempt,
  evidence?: OnChainReconciliationEvidence
): ReconciliationEvaluationResult {
  // Case 1: Attempt was already confirmed
  if (attempt.state === 'CONFIRMED') {
    return {
      verdict: 'CONFIRMED',
      reason: 'Attempt is already marked CONFIRMED.',
      canRetry: false,
      requiresReconciliation: false,
      isTerminal: true,
      onChainStatus: 'CONFIRMED'
    };
  }

  // Case 2: Attempt was already definitive failure
  if (attempt.state === 'FAILED_DEFINITIVE') {
    return {
      verdict: 'FAILED_DEFINITIVE',
      reason: attempt.failureReason || 'Attempt is already marked FAILED_DEFINITIVE.',
      canRetry: true,
      requiresReconciliation: false,
      isTerminal: true,
      onChainStatus: 'FAILED'
    };
  }

  // Case 3: Attempt never signed and never broadcasted (safe to retry or cancel)
  if (attempt.state === 'INITIALIZED' || attempt.state === 'ORDER_READY') {
    return {
      verdict: 'CAN_RETRY',
      reason: 'Attempt was never signed or broadcasted to network; no on-chain footprint exists.',
      canRetry: true,
      requiresReconciliation: false,
      isTerminal: false,
      onChainStatus: 'DROPPED'
    };
  }

  // Case 4: Evidence communication failure (HTTP timeout / RPC unreachable)
  if (evidence?.httpTimeout || (evidence?.rpcError && evidence.signatureFound === undefined)) {
    return {
      verdict: 'UNKNOWN',
      reason: `Reconciliation query failed due to transport/RPC issue: ${evidence?.rpcError || 'HTTP timeout'}. Status is unknown; CANNOT assume failure.`,
      canRetry: false,
      requiresReconciliation: true,
      isTerminal: false,
      onChainStatus: 'UNKNOWN'
    };
  }

  // Case 5: No evidence provided for active/in-flight attempt
  if (!evidence) {
    if (attempt.state === 'SIGNED') {
      return {
        verdict: 'MUST_RECONCILE',
        reason: 'Attempt was signed locally; no on-chain evidence provided, transaction may be in mempool.',
        canRetry: false,
        requiresReconciliation: true,
        isTerminal: false,
        onChainStatus: 'PENDING'
      };
    }
    return {
      verdict: 'UNKNOWN',
      reason: `No on-chain evidence provided for attempt in state '${attempt.state}'.`,
      canRetry: false,
      requiresReconciliation: true,
      isTerminal: false,
      onChainStatus: 'UNKNOWN'
    };
  }

  // Case 6: Transaction signature found on-chain
  if (evidence.signatureFound === true) {
    // If err is null/undefined, transaction landed successfully
    if (!evidence.err) {
      return {
        verdict: 'CONFIRMED',
        reason: `Transaction signature found confirmed on-chain in slot ${evidence.slot ?? 'unknown'}.`,
        canRetry: false,
        requiresReconciliation: false,
        isTerminal: true,
        onChainStatus: 'CONFIRMED'
      };
    }

    // Transaction landed but failed on-chain (reverted by program or instruction failure)
    return {
      verdict: 'FAILED_DEFINITIVE',
      reason: `Transaction landed on-chain but executed with error: ${typeof evidence.err === 'object' ? JSON.stringify(evidence.err) : String(evidence.err)}.`,
      canRetry: true,
      requiresReconciliation: false,
      isTerminal: true,
      onChainStatus: 'FAILED'
    };
  }

  // Case 7: Transaction signature NOT found on-chain (signatureFound === false)
  if (evidence.signatureFound === false) {
    // If blockhash is expired, transaction can NEVER land on-chain
    if (evidence.blockhashExpired === true || evidence.blockhashValid === false) {
      return {
        verdict: 'FAILED_DEFINITIVE',
        reason: 'Transaction not found in ledger and blockhash has expired. Transaction cannot land on-chain.',
        canRetry: true,
        requiresReconciliation: false,
        isTerminal: true,
        onChainStatus: 'DROPPED'
      };
    }

    // Blockhash is still valid or validity unknown: transaction might still be propagating
    return {
      verdict: 'MUST_RECONCILE',
      reason: 'Transaction not yet found in ledger, but blockhash is still valid. Transaction may still be confirmed.',
      canRetry: false,
      requiresReconciliation: true,
      isTerminal: false,
      onChainStatus: 'PENDING'
    };
  }

  // Default fallback: UNKNOWN
  return {
    verdict: 'UNKNOWN',
    reason: 'Inconclusive on-chain evidence; cannot determine definitive status.',
    canRetry: false,
    requiresReconciliation: true,
    isTerminal: false,
    onChainStatus: 'UNKNOWN'
  };
}

/**
 * Validates that an UNKNOWN verdict is never confused with FAILED_DEFINITIVE.
 */
export function isVerdictTerminal(verdict: ReconciliationVerdict): boolean {
  return verdict === 'CONFIRMED' || verdict === 'FAILED_DEFINITIVE';
}
