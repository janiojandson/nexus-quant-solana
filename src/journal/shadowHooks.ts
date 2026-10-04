/**
 * Nexus Quant Solana — V2.1B Shadow Lifecycle Hooks
 *
 * Provides non-blocking, fail-safe shadow observation hooks integrated into the
 * execution lifecycle without introducing financial I/O or altering trading flow.
 *
 * Invariants:
 * 1. Default disabled: NEXUS_V2_JOURNAL_SHADOW_ENABLED defaults to false.
 * 2. Zero live latency: when flag is false, hooks return immediately with no await.
 * 3. Zero extra network calls: no RPC, no HTTP queries, purely in-memory/repository writes.
 * 4. Fail-safe: shadow errors never abort or disrupt live execution; errors increment shadowJournalErrorCount.
 * 5. Telemetry: tracks journalShadowWriteMs and shadowJournalErrorCount.
 */

import { IExitJournalRepository } from './repository';
import {
  ExitIntentId,
  ExecutionAttemptId,
  ExitIntentSeverity,
  ExitIntentReason,
  ExitIntentAmountPolicy,
  ExecutionAttemptState,
  FillRecord,
  nowWallMs,
  nowMonotonicNs
} from './types';
import { isShadowJournalEnabled } from './shadowJournal';

export interface ShadowJournalMetrics {
  shadowJournalErrorCount: number;
  lastShadowJournalError?: string;
  totalShadowInvocations: number;
  lastShadowWriteMs: number;
  cumulativeShadowWriteMs: number;
}

export const shadowJournalMetrics: ShadowJournalMetrics = {
  shadowJournalErrorCount: 0,
  totalShadowInvocations: 0,
  lastShadowWriteMs: 0,
  cumulativeShadowWriteMs: 0
};

export function resetShadowJournalMetrics(): void {
  shadowJournalMetrics.shadowJournalErrorCount = 0;
  shadowJournalMetrics.lastShadowJournalError = undefined;
  shadowJournalMetrics.totalShadowInvocations = 0;
  shadowJournalMetrics.lastShadowWriteMs = 0;
  shadowJournalMetrics.cumulativeShadowWriteMs = 0;
}

// Active singleton repository for shadow execution (can be configured in tests or runtime)
let activeShadowRepository: IExitJournalRepository | null = null;

export function setShadowRepository(repo: IExitJournalRepository | null): void {
  activeShadowRepository = repo;
}

export function getShadowRepository(): IExitJournalRepository | null {
  return activeShadowRepository;
}

// Shadow context cache for tracking active intents across execution phases
const activeShadowContexts = new Map<string, ShadowExecutionContext>();

export interface ShadowExecutionContext {
  intentId: ExitIntentId;
  tradeId: string;
  positionId: string;
  mint: string;
  walletId: string;
  requestedAmountAtomic: string;
  claimEpoch: bigint;
  currentAttemptId?: ExecutionAttemptId;
  signature?: string;
  requestId?: string;
}

export interface OnExitDecisionInput {
  tradeId?: string;
  positionId?: string;
  walletId: string;
  mint: string;
  tokenProgram?: string;
  requestedAmountAtomic: string;
  reason: string;
  pnlPct?: number;
  exitSolValue?: number;
  traceId?: string;
  policyVersion?: string;
}

export interface OnJupiterOrderInput {
  mint: string;
  requestId: string;
  route?: string;
  expectedOutAtomic?: string;
  minimumOutAtomic?: string;
  lastValidBlockHeight?: string | number;
}

export interface OnLocalSignInput {
  mint: string;
  signature: string;
  messageHash?: string;
}

export interface OnSimulationResultInput {
  mint: string;
  success: boolean;
  unitsConsumed?: number;
  error?: string;
}

export interface OnSubmitInput {
  mint: string;
  signature?: string;
  lastValidBlockHeight?: string | number;
}

export interface OnProviderReceiptInput {
  mint: string;
  status: 'SUCCESS' | 'FAILED' | 'SUBMITTED_UNCONFIRMED' | string;
  error?: string;
  signature?: string;
  inAmount?: number;
  outAmount?: number;
}

export interface OnFillConfirmedInput {
  mint: string;
  signature: string;
  grossProceedsLamports: string | number;
  actualAmountAtomic?: string | number;
  networkFeeLamports?: string | number;
  priorityFeeLamports?: string | number;
  tipLamports?: string | number;
  rentMovementLamports?: string | number;
  slot?: number;
}

export interface OnLegacyPositionUpdateInput {
  mint: string;
  isPartial: boolean;
  committed: boolean;
  remainingAmountAtomic?: string | number;
  realizedPnlSol?: number;
  ataClosed?: boolean;
}

/**
 * Measure helper that tracks duration and catches errors safely.
 */
async function runShadowSafe(actionName: string, fn: () => Promise<void>): Promise<void> {
  if (!isShadowJournalEnabled()) return;
  const repo = activeShadowRepository;
  if (!repo) return;

  const startMs = Date.now();
  shadowJournalMetrics.totalShadowInvocations++;

  try {
    await fn();
  } catch (err: any) {
    shadowJournalMetrics.shadowJournalErrorCount++;
    shadowJournalMetrics.lastShadowJournalError = `[${actionName}] ${err?.message || String(err)}`;
    // Fail-safe: log warning, never throw to live financial caller
    console.warn(`[SHADOW_JOURNAL_WARN] Error in ${actionName}: ${err?.message}`);
  } finally {
    const elapsed = Date.now() - startMs;
    shadowJournalMetrics.lastShadowWriteMs = elapsed;
    shadowJournalMetrics.cumulativeShadowWriteMs += elapsed;
  }
}

// ==========================================
// SHADOW HOOK IMPLEMENTATIONS
// ==========================================

export async function shadowOnExitDecision(input: OnExitDecisionInput): Promise<ShadowExecutionContext | null> {
  if (!isShadowJournalEnabled()) return null;

  let resultCtx: ShadowExecutionContext | null = null;

  await runShadowSafe('onExitDecision', async () => {
    const repo = activeShadowRepository!;
    const tradeId = input.tradeId || `SHADOW_GENERATED:trade_${input.mint.slice(0, 8)}_${Date.now()}`;
    const positionId = input.positionId || `SHADOW_GENERATED:pos_${input.mint.slice(0, 8)}_${Date.now()}`;
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
      id: `SHADOW_GENERATED:intent_${input.mint.slice(0, 8)}_${Date.now()}` as any,
      tradeId: tradeId as any,
      positionId: positionId as any,
      walletId: input.walletId,
      mint: input.mint,
      tokenProgram,
      requestedAmountAtomic: String(input.requestedAmountAtomic),
      amountPolicy,
      initialSeverity: severity,
      reason: mappedReason,
      policyVersion: input.policyVersion || 'v2.1b_shadow'
    });

    // Claim in shadow mode
    const claimed = await repo.claimIntent({
      intentId: intent.id,
      workerId: 'shadow_worker_live',
      leaseDurationMs: 60_000
    });

    const ctx: ShadowExecutionContext = {
      intentId: intent.id,
      tradeId,
      positionId,
      mint: input.mint,
      walletId: input.walletId,
      requestedAmountAtomic: String(input.requestedAmountAtomic),
      claimEpoch: claimed?.claimEpoch ?? 1n
    };

    activeShadowContexts.set(input.mint, ctx);
    resultCtx = ctx;
  });

  return resultCtx;
}

export async function shadowOnJupiterOrder(input: OnJupiterOrderInput): Promise<void> {
  if (!isShadowJournalEnabled()) return;

  await runShadowSafe('onJupiterOrder', async () => {
    const repo = activeShadowRepository!;
    const ctx = activeShadowContexts.get(input.mint);
    if (!ctx) return;

    const attemptId = `SHADOW_GENERATED:att_${input.requestId || Date.now()}` as ExecutionAttemptId;
    ctx.currentAttemptId = attemptId;
    ctx.requestId = input.requestId;

    await repo.prepareAttempt({
      attemptId,
      intentId: ctx.intentId,
      provider: 'JUPITER_V2',
      route: input.route || 'JUPITER_V2_ORDER',
      requestId: input.requestId,
      requestedAmountAtomic: ctx.requestedAmountAtomic,
      expectedOutAtomic: input.expectedOutAtomic,
      minimumOutAtomic: input.minimumOutAtomic,
      initialState: 'ORDER_READY',
      lastValidBlockHeight: input.lastValidBlockHeight
    }, ctx.claimEpoch);
  });
}

export async function shadowOnLocalSign(input: OnLocalSignInput): Promise<void> {
  if (!isShadowJournalEnabled()) return;

  await runShadowSafe('onLocalSign', async () => {
    const repo = activeShadowRepository!;
    const ctx = activeShadowContexts.get(input.mint);
    if (!ctx || !ctx.currentAttemptId) return;

    ctx.signature = input.signature;

    await repo.updateAttemptState(ctx.currentAttemptId, 'SIGNED', {
      signature: input.signature,
      messageHash: input.messageHash,
      preparedAtWallMs: nowWallMs()
    }, ctx.claimEpoch);
  });
}

export async function shadowOnSimulationResult(input: OnSimulationResultInput): Promise<void> {
  if (!isShadowJournalEnabled()) return;

  await runShadowSafe('onSimulationResult', async () => {
    const repo = activeShadowRepository!;
    const ctx = activeShadowContexts.get(input.mint);
    if (!ctx || !ctx.currentAttemptId) return;

    if (!input.success) {
      await repo.updateAttemptState(ctx.currentAttemptId, 'SIMULATED', {
        failureReason: input.error || 'Simulation failed'
      }, ctx.claimEpoch);
    } else {
      await repo.updateAttemptState(ctx.currentAttemptId, 'SIMULATED', {}, ctx.claimEpoch);
    }
  });
}

export async function shadowOnSubmit(input: OnSubmitInput): Promise<void> {
  if (!isShadowJournalEnabled()) return;

  await runShadowSafe('onSubmit', async () => {
    const repo = activeShadowRepository!;
    const ctx = activeShadowContexts.get(input.mint);
    if (!ctx || !ctx.currentAttemptId) return;

    await repo.updateAttemptState(ctx.currentAttemptId, 'SUBMITTED', {
      signature: input.signature || ctx.signature,
      lastValidBlockHeight: input.lastValidBlockHeight != null ? BigInt(input.lastValidBlockHeight) : undefined,
      submittedAtWallMs: nowWallMs()
    }, ctx.claimEpoch);
  });
}

export async function shadowOnProviderReceipt(input: OnProviderReceiptInput): Promise<void> {
  if (!isShadowJournalEnabled()) return;

  await runShadowSafe('onProviderReceipt', async () => {
    const repo = activeShadowRepository!;
    const ctx = activeShadowContexts.get(input.mint);
    if (!ctx || !ctx.currentAttemptId) return;

    let targetState: ExecutionAttemptState = 'UNKNOWN';
    if (input.status === 'SUCCESS' || input.status === 'DRY_RUN_SUCCESS') {
      targetState = 'PROVIDER_SUCCESS';
    } else if (input.status === 'FAILED') {
      targetState = 'FAILED_DEFINITIVE';
    } else if (input.status === 'SUBMITTED_UNCONFIRMED') {
      targetState = 'UNKNOWN';
    }

    await repo.updateAttemptState(ctx.currentAttemptId, targetState, {
      signature: input.signature || ctx.signature,
      failureReason: input.error,
      providerReceiptAtWallMs: nowWallMs()
    }, ctx.claimEpoch);
  });
}

export async function shadowOnFillConfirmed(input: OnFillConfirmedInput): Promise<void> {
  if (!isShadowJournalEnabled()) return;

  await runShadowSafe('onFillConfirmed', async () => {
    const repo = activeShadowRepository!;
    const ctx = activeShadowContexts.get(input.mint);
    if (!ctx || !ctx.currentAttemptId) return;

    // Transition attempt from PROVIDER_SUCCESS / SUBMITTED to CONFIRMED (Finding R-P1-02)
    await repo.updateAttemptState(ctx.currentAttemptId, 'CONFIRMED', {
      confirmedAtWallMs: nowWallMs()
    }, ctx.claimEpoch);

    const fillId = `SHADOW_GENERATED:fill_${input.signature.slice(0, 16)}_${Date.now()}`;

    const fillRecord: FillRecord = {
      id: fillId as any,
      tradeId: ctx.tradeId as any,
      positionId: ctx.positionId as any,
      intentId: ctx.intentId,
      attemptId: ctx.currentAttemptId,
      signature: input.signature,
      realizationSequence: 0,
      chainLegIndex: 0,
      instructionIndex: 2,
      innerInstructionIndex: 0,
      assetMint: input.mint,
      requestedAmountAtomic: ctx.requestedAmountAtomic,
      actualAmountAtomic: String(input.actualAmountAtomic ?? ctx.requestedAmountAtomic),
      grossProceedsLamports: String(input.grossProceedsLamports),
      networkFeeLamports: String(input.networkFeeLamports ?? 5000),
      priorityFeeLamports: String(input.priorityFeeLamports ?? 0),
      tipLamports: String(input.tipLamports ?? 0),
      rentMovementLamports: String(input.rentMovementLamports ?? 0),
      slot: input.slot,
      confirmedAtWallMs: nowWallMs(),
      evidenceType: 'JUPITER_V2_RECEIPT',
      createdAtWallMs: nowWallMs()
    };

    await repo.recordFill(fillRecord, ctx.claimEpoch);
  });
}

export async function shadowOnLegacyPositionUpdate(input: OnLegacyPositionUpdateInput): Promise<void> {
  if (!isShadowJournalEnabled()) return;

  await runShadowSafe('onLegacyPositionUpdate', async () => {
    // Legacy position update observed; clean up context if total exit
    if (!input.isPartial) {
      activeShadowContexts.delete(input.mint);
    }
  });
}
