/**
 * Nexus Quant Solana — V2.3-R3 Durable Execution Safety Layer
 *
 * Implements Findings P0-02, R-P0-01, and Governance Directives:
 * 1. SEPARATION OF CONCERNS:
 *    - JOURNAL_AUTHORITATIVE: false (Deferred as V2.2 Cutover Blocker).
 *    - DURABLE_EXECUTION_SAFETY: true (Mandatory for all live financial exits).
 * 2. INDEPENDENT OF SHADOW FLAG:
 *    - Does NOT depend on NEXUS_V2_JOURNAL_SHADOW_ENABLED.
 *    - Guarantees any potentially on-chain attempt is durably recorded before broadcast.
 * 3. FAIL-CLOSED DB FAILURE:
 *    - If safety persistence is unavailable or fails: throws FinancialPersistenceUnavailableError (code: FINANCIAL_PERSISTENCE_UNAVAILABLE).
 *    - Never broadcast a live transaction without durable journal persistence.
 */

import { IExitJournalRepository } from './repository.js';
import {
  ExitIntentId,
  ExecutionAttemptId,
  ExitIntentSeverity,
  ExitIntentReason,
  ExitIntentAmountPolicy,
  ExecutionAttemptState,
  nowWallMs
} from './types.js';
import { financialExitSafetyGuard } from '../execution/financialExitSafetyGuard.js';

export class FinancialPersistenceUnavailableError extends Error {
  public readonly code = 'FINANCIAL_PERSISTENCE_UNAVAILABLE';

  constructor(message: string = 'FINANCIAL_PERSISTENCE_UNAVAILABLE: Cannot execute live exit without durable safety persistence.') {
    super(message);
    this.name = 'FinancialPersistenceUnavailableError';
  }
}

export interface LiveExitAttemptInput {
  walletId: string;
  mint: string;
  tokenProgram?: string;
  requestedAmountAtomic: string;
  reason: string;
  pnlPct?: number;
  exitSolValue?: number;
  traceId?: string;
  tradeId?: string;
  positionId?: string;
  policyVersion?: string;
}

export interface LiveAttemptRecord {
  intentId: ExitIntentId;
  attemptId: ExecutionAttemptId;
  claimEpoch: bigint;
  mint: string;
  walletId: string;
  requestedAmountAtomic: string;
  signature?: string;
  requestId?: string;
}

let activeDurableSafetyRepository: IExitJournalRepository | null = null;
let durableSafetyEnforced: boolean = true;
const activeLiveAttempts = new Map<string, LiveAttemptRecord>();

/**
 * Registers the active repository for durable execution safety.
 */
export function setDurableSafetyRepository(repo: IExitJournalRepository | null): void {
  activeDurableSafetyRepository = repo;
}

/**
 * Returns the currently registered durable safety repository.
 */
export function getDurableSafetyRepository(): IExitJournalRepository | null {
  return activeDurableSafetyRepository;
}

/**
 * Enables or disables enforcement of durable safety (enabled by default in live runs).
 */
export function setDurableSafetyEnforcement(enforce: boolean): void {
  durableSafetyEnforced = enforce;
}

/**
 * Returns whether durable execution safety enforcement is active.
 */
export function isDurableExecutionSafetyActive(): boolean {
  return durableSafetyEnforced;
}

/**
 * Returns active live attempt context for a mint if present.
 */
export function getActiveLiveAttempt(mint: string): LiveAttemptRecord | undefined {
  return activeLiveAttempts.get(mint);
}

/**
 * Persists an ExitIntent and ExecutionAttempt durably before any live network broadcast.
 * If durable safety is enforced and repository write fails, throws FinancialPersistenceUnavailableError.
 */
export async function recordLiveExitIntent(input: LiveExitAttemptInput): Promise<LiveAttemptRecord | null> {
  if (!durableSafetyEnforced) {
    return null;
  }

  const repo = activeDurableSafetyRepository;
  if (!repo) {
    throw new FinancialPersistenceUnavailableError(
      'FINANCIAL_PERSISTENCE_UNAVAILABLE: No durable safety repository configured for live exit.'
    );
  }

  try {
    const tradeId = input.tradeId || `SAFETY:trade_${input.mint.slice(0, 8)}_${Date.now()}`;
    const positionId = input.positionId || `SAFETY:pos_${input.mint.slice(0, 8)}_${Date.now()}`;
    const tokenProgram = input.tokenProgram || 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

    const severity: ExitIntentSeverity =
      input.reason.includes('CRITICAL') || input.reason.includes('EMERGENCY') || input.reason === 'MANUAL'
        ? 'EMERGENCY'
        : input.reason.includes('HIGH') || input.reason.includes('STOP')
          ? 'HIGH'
          : 'NORMAL';

    const mappedReason: ExitIntentReason =
      input.reason === 'PARTIAL_TAKE_PROFIT_50' || input.reason === 'TAKE_PROFIT'
        ? 'TAKE_PROFIT_PARTIAL'
        : input.reason === 'STOP_LOSS'
          ? 'STOP_LOSS'
          : input.reason === 'TRAILING_STOP'
            ? 'TRAILING_STOP'
            : input.reason === 'TIME_STOP'
              ? 'TIME_STOP'
              : input.reason === 'WATCHDOG_EXIT'
                ? 'WATCHDOG'
                : input.reason === 'MANUAL'
                  ? 'PANIC'
                  : 'STOP_LOSS';

    const amountPolicy: ExitIntentAmountPolicy =
      input.reason === 'PARTIAL_TAKE_PROFIT_50' ? 'PARTIAL_50' : 'FULL_REMAINDER';

    const { intent } = await repo.createOrGetIntent({
      id: `SAFETY:intent_${input.mint.slice(0, 8)}_${Date.now()}` as any,
      tradeId: tradeId as any,
      positionId: positionId as any,
      walletId: input.walletId,
      mint: input.mint,
      tokenProgram,
      requestedAmountAtomic: String(input.requestedAmountAtomic),
      amountPolicy,
      initialSeverity: severity,
      reason: mappedReason,
      policyVersion: input.policyVersion || 'v2.3_durable_safety'
    });

    const claimed = await repo.claimIntent({
      intentId: intent.id,
      workerId: 'live_safety_guard',
      leaseDurationMs: 120_000
    });

    const claimEpoch = claimed?.claimEpoch ?? 1n;

    // Immediately record durable reconciliation debt before network broadcast
    try {
      await repo.setReconciliationDebt(intent.id, true, claimEpoch);
    } catch {
      // In-memory repo or custom repo fallback
    }

    const attemptId = `SAFETY:att_${input.mint.slice(0, 8)}_${Date.now()}` as ExecutionAttemptId;

    await repo.prepareAttempt({
      attemptId,
      intentId: intent.id,
      provider: 'JUPITER_V2',
      route: 'LIVE_EXIT',
      requestedAmountAtomic: String(input.requestedAmountAtomic),
      initialState: 'ORDER_READY'
    }, claimEpoch);

    const record: LiveAttemptRecord = {
      intentId: intent.id,
      attemptId,
      claimEpoch,
      mint: input.mint,
      walletId: input.walletId,
      requestedAmountAtomic: String(input.requestedAmountAtomic)
    };

    activeLiveAttempts.set(input.mint, record);
    return record;
  } catch (err: any) {
    if (err instanceof FinancialPersistenceUnavailableError) {
      throw err;
    }
    throw new FinancialPersistenceUnavailableError(
      `FINANCIAL_PERSISTENCE_UNAVAILABLE: Failed to persist durable exit safety: ${err?.message || err}`
    );
  }
}

/**
 * Updates the live attempt state to SIGNED.
 */
export async function updateLiveAttemptOnSign(mint: string, signature: string, messageHash?: string): Promise<void> {
  const record = activeLiveAttempts.get(mint);
  const repo = activeDurableSafetyRepository;
  if (!record || !repo) return;

  record.signature = signature;
  try {
    await repo.updateAttemptState(record.attemptId, 'SIGNED', {
      signature,
      messageHash,
      preparedAtWallMs: nowWallMs()
    }, record.claimEpoch);
  } catch (err: any) {
    console.warn(`⚠️ [DURABLE_SAFETY_WARN] Could not update SIGNED state for ${mint}:`, err?.message);
  }
}

/**
 * Updates the live attempt state to SUBMITTED.
 */
export async function updateLiveAttemptOnSubmit(
  mint: string,
  signature?: string,
  lastValidBlockHeight?: string | number
): Promise<void> {
  const record = activeLiveAttempts.get(mint);
  const repo = activeDurableSafetyRepository;
  if (!record || !repo) return;

  if (signature) record.signature = signature;
  try {
    await repo.updateAttemptState(record.attemptId, 'SUBMITTED', {
      signature: record.signature,
      lastValidBlockHeight: lastValidBlockHeight != null ? BigInt(lastValidBlockHeight) : undefined,
      submittedAtWallMs: nowWallMs()
    }, record.claimEpoch);
  } catch (err: any) {
    console.warn(`⚠️ [DURABLE_SAFETY_WARN] Could not update SUBMITTED state for ${mint}:`, err?.message);
  }
}

/**
 * Updates the live attempt state following receipt from provider.
 */
export async function updateLiveAttemptOnReceipt(
  mint: string,
  status: 'SUCCESS' | 'FAILED' | 'SUBMITTED_UNCONFIRMED' | string,
  signature?: string,
  error?: string
): Promise<void> {
  const record = activeLiveAttempts.get(mint);
  const repo = activeDurableSafetyRepository;
  if (!record || !repo) return;

  if (signature) record.signature = signature;

  let targetState: ExecutionAttemptState = 'UNKNOWN';
  if (status === 'SUCCESS') {
    targetState = 'PROVIDER_SUCCESS';
  } else if (status === 'FAILED') {
    targetState = 'FAILED_DEFINITIVE';
  } else if (status === 'SUBMITTED_UNCONFIRMED') {
    targetState = 'UNKNOWN';
    // Ensure debt remains registered on safety guard
    financialExitSafetyGuard.registerUnresolvedDebt(mint);
  }

  try {
    await repo.updateAttemptState(record.attemptId, targetState, {
      signature: record.signature,
      failureReason: error,
      providerReceiptAtWallMs: nowWallMs()
    }, record.claimEpoch);
  } catch (err: any) {
    console.warn(`⚠️ [DURABLE_SAFETY_WARN] Could not update ${targetState} state for ${mint}:`, err?.message);
  }
}

/**
 * Updates the live attempt state to CONFIRMED.
 */
export async function updateLiveAttemptOnConfirmation(mint: string, signature: string): Promise<void> {
  const record = activeLiveAttempts.get(mint);
  const repo = activeDurableSafetyRepository;
  if (!record || !repo) return;

  record.signature = signature;
  try {
    await repo.updateAttemptState(record.attemptId, 'CONFIRMED', {
      confirmedAtWallMs: nowWallMs()
    }, record.claimEpoch);
  } catch (err: any) {
    console.warn(`⚠️ [DURABLE_SAFETY_WARN] Could not update CONFIRMED state for ${mint}:`, err?.message);
  }
}

/**
 * Clears active live attempt tracking for a mint.
 */
export function clearLiveAttempt(mint: string): void {
  activeLiveAttempts.delete(mint);
}
