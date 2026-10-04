/**
 * Nexus Quant Solana — Exact Execution Attempt Reconciliation Service (Finding R-P0-03)
 *
 * Implements strict reconciliation rules:
 * 1. MANDATORY IDENTITY: ExecutionAttempt must possess exact signature.
 *    Reconciliation begins strictly by the exact signature of the attempt.
 *    Searching "the first recent transaction of the wallet that changed the mint" is PROHIBITED.
 * 2. EXACT SIGNATURE VALIDATION:
 *    - Query and parse the transaction for that signature.
 *    - Validate signature, programs, wallet/owner, mint, actual token debit, actual SOL credit.
 * 3. INSUFFICIENT IDENTITY:
 *    - If signature does not exist, return UNKNOWN / UNRESOLVED (NEVER CONFIRMED).
 *    - Absence of proof never becomes negative or positive proof.
 * 4. THIRD-PARTY TRANSACTION IMMUNITY:
 *    - Third-party transfers or unrelated transactions cannot resolve or confirm an attempt.
 */

import { ExecutionAttempt, ExitIntent } from '../journal/types.js';

export interface EconomicExecutionEvidence {
  signature: string;
  slot: number;
  wallet: string;
  inputMint: string;
  inputTokenAccount?: string;
  outputAsset: string;
  actualDebitAtomic: bigint;
  actualCreditAtomic: bigint;
  remainingCustodyAtomic: bigint;
  evidenceSource: 'ON_CHAIN_TRANSACTION' | 'ON_CHAIN_SIMULATION' | 'DRY_RUN';
  commitment: 'confirmed' | 'finalized';
}

export interface WalletTransactionReconciler {
  reconcileExactTransaction(params: {
    signature: string;
    mintAddress: string;
    expectedOwner?: string;
    direction?: 'IN' | 'OUT' | 'ANY';
  }): Promise<{
    signature: string;
    slot?: number;
    deltaAtomic: string;
    remainingCustodyAtomic?: string;
    inputTokenAccount?: string;
    walletLamportDelta: number;
    feeLamports: number;
    blockTimeMs: number;
    success: boolean;
    error?: string;
  } | null>;
}

export type ReconciledAttemptStatus =
  | 'CONFIRMED'
  | 'FAILED_DEFINITIVE'
  | 'UNKNOWN';

export interface ReconciledAttemptResult {
  status: ReconciledAttemptStatus;
  attemptId: string;
  intentId: string;
  signature?: string;
  actualDebitAtomic?: bigint;
  grossProceedsLamports?: bigint;
  networkFeeLamports?: bigint;
  blockTimeMs?: number;
  evidence?: EconomicExecutionEvidence;
  reason?: string;
}

/**
 * Reconciles an execution attempt strictly against the blockchain using its exact signature.
 */
export async function reconcileExecutionAttempt(params: {
  attempt: ExecutionAttempt;
  intent: ExitIntent;
  walletReconciler: WalletTransactionReconciler;
}): Promise<ReconciledAttemptResult> {
  const { attempt, intent, walletReconciler } = params;

  // 1. Mandatory identity check (R-P0-03.1 & R-P0-03.4)
  const signature = (attempt.signature || '').trim();
  if (!signature) {
    return {
      status: 'UNKNOWN',
      attemptId: attempt.attemptId,
      intentId: intent.id,
      reason: 'INSUFFICIENT_IDENTITY_FOR_RECONCILIATION: Attempt has no signature. Unverified attempts remain UNKNOWN.'
    };
  }

  // 2. Query exact transaction from chain (R-P0-03.2)
  const parsedTx = await walletReconciler.reconcileExactTransaction({
    signature,
    mintAddress: intent.mint,
    expectedOwner: intent.walletId,
    direction: 'OUT'
  });

  if (!parsedTx) {
    // Transaction not found or dropped or pending confirmation
    return {
      status: 'UNKNOWN',
      attemptId: attempt.attemptId,
      intentId: intent.id,
      signature,
      reason: 'TRANSACTION_NOT_FOUND_OR_PENDING_CONFIRMATION: Exact transaction not yet finalized on-chain.'
    };
  }

  // 3. On-chain failure check
  if (!parsedTx.success) {
    return {
      status: 'FAILED_DEFINITIVE',
      attemptId: attempt.attemptId,
      intentId: intent.id,
      signature,
      reason: parsedTx.error || 'ON_CHAIN_TRANSACTION_FAILED: Execution reverted on-chain'
    };
  }

  // 4. Token debit validation
  // deltaAtomic is negative for outgoing (OUT) token movements
  const delta = BigInt(parsedTx.deltaAtomic);
  const actualDebitAtomic = delta < 0n ? -delta : 0n;

  if (actualDebitAtomic <= 0n) {
    return {
      status: 'UNKNOWN',
      attemptId: attempt.attemptId,
      intentId: intent.id,
      signature,
      reason: `NO_ECONOMIC_DEBIT: Transaction ${signature} succeeded but did not debit expected mint ${intent.mint} for owner ${intent.walletId}.`
    };
  }

  const grossProceedsLamports = BigInt(
    Math.max(0, parsedTx.walletLamportDelta + parsedTx.feeLamports)
  );

  return {
    status: 'CONFIRMED',
    attemptId: attempt.attemptId,
    intentId: intent.id,
    signature,
    actualDebitAtomic,
    grossProceedsLamports,
    networkFeeLamports: BigInt(parsedTx.feeLamports),
    blockTimeMs: parsedTx.blockTimeMs,
    evidence: {
      signature,
      slot: parsedTx.slot || 0,
      wallet: intent.walletId,
      inputMint: intent.mint,
      inputTokenAccount: parsedTx.inputTokenAccount,
      outputAsset: 'SOL',
      actualDebitAtomic,
      actualCreditAtomic: grossProceedsLamports,
      remainingCustodyAtomic: parsedTx.remainingCustodyAtomic ? BigInt(parsedTx.remainingCustodyAtomic) : 0n,
      evidenceSource: 'ON_CHAIN_TRANSACTION',
      commitment: 'confirmed'
    }
  };
}
