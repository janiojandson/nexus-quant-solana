/**
 * Nexus Quant Solana — V2.1A Durable Exit Journal & Fill Ledger Types
 *
 * Provides immutable contracts and state definitions for:
 * - ExitIntent (Economic desire to reduce risk)
 * - ExecutionAttempt (Individual execution attempts against providers)
 * - FillRecord (Append-only on-chain financial realizations)
 * - IntentSeverityEvent (Audit trail of severity transitions)
 * - ExecutionReconciliationEvent (Reconciliation decisions)
 */

import * as crypto from 'crypto';
import {
  WallMs,
  MonotonicNs,
  nowWallMs,
  nowMonotonicNs,
  TradeId,
  PositionId,
  ExitIntentId,
  ExecutionAttemptId,
  FillId,
  PositionVersion,
  SolanaSignature
} from '../types/telemetry';

export {
  WallMs,
  MonotonicNs,
  nowWallMs,
  nowMonotonicNs,
  TradeId,
  PositionId,
  ExitIntentId,
  ExecutionAttemptId,
  FillId,
  PositionVersion,
  SolanaSignature
};

// ==========================================
// 1. EXIT INTENT STATES & SEVERITY
// ==========================================

export type ExitIntentStatus =
  | 'CREATED'
  | 'CLAIMED'
  | 'PREPARED'
  | 'SUBMITTED'
  | 'CONFIRMED'
  | 'APPLIED'
  | 'SUPERSEDED'
  | 'CANCELLED'
  | 'FAILED_DEFINITIVE'
  | 'UNKNOWN';

export type ExitIntentSeverity = 'NORMAL' | 'HIGH' | 'EMERGENCY';

export type ExitIntentAmountPolicy = 'FULL_REMAINDER' | 'PARTIAL_50' | 'CUSTOM';

export type ExitIntentReason =
  | 'STOP_LOSS'
  | 'TRAILING_STOP'
  | 'TAKE_PROFIT_PARTIAL'
  | 'PANIC'
  | 'LIQUIDITY_DRAIN'
  | 'SIMULATION_REJECTED'
  | 'CONFIRMATION_TIMEOUT'
  | 'MANUAL_OVERRIDE'
  | 'TIME_STOP'
  | 'WATCHDOG';

export interface IntentSeverityEvent {
  readonly id?: string | number;
  readonly intentId: ExitIntentId;
  readonly fromSeverity: ExitIntentSeverity;
  readonly toSeverity: ExitIntentSeverity;
  readonly reason: ExitIntentReason;
  readonly observationId?: string;
  readonly changedAtWallMs: WallMs;
  readonly changedAtMonoNs?: MonotonicNs;
}

export interface ExitIntent {
  readonly id: ExitIntentId;
  readonly tradeId: TradeId;
  readonly positionId: PositionId;
  readonly walletId: string;
  readonly mint: string;
  readonly tokenProgram: string;
  readonly positionVersion: PositionVersion | null;
  readonly requestedAmountAtomic: string;
  readonly amountPolicy: ExitIntentAmountPolicy;

  // Economic Dedupe Key: decoupled from reason and severity
  // Formula: sha256(walletId:mint:positionVersion:requestedAmountAtomic:amountPolicy)
  readonly economicDedupeKey: string;

  // Severity audit trail: initialSeverity is immutable; transitions append to severityAuditTrail
  readonly initialSeverity: ExitIntentSeverity;
  currentSeverity: ExitIntentSeverity;
  readonly severityAuditTrail: IntentSeverityEvent[];

  reason: ExitIntentReason;
  policyVersion: string;

  // Claim & Lease semantics
  claimedBy?: string | null;
  claimEpoch: bigint;
  claimedAtWallMs?: WallMs | null;
  leaseExpiresAtWallMs?: WallMs | null;

  status: ExitIntentStatus;
  supersededBy?: ExitIntentId;

  // Reconciliation Debt: true when an active on-chain attempt is unresolved
  reconciliationDebt: boolean;

  readonly createdAtWallMs: WallMs;
  readonly expiresAtWallMs: WallMs;
}

export type ClaimEpoch = bigint;

export const TERMINAL_INTENT_STATUSES: ReadonlySet<ExitIntentStatus> = new Set([
  'APPLIED',
  'CANCELLED',
  'SUPERSEDED',
  'FAILED_DEFINITIVE'
]);

export const ECONOMICALLY_ACTIVE_INTENT_STATUSES: ReadonlySet<ExitIntentStatus> = new Set([
  'CREATED',
  'CLAIMED',
  'PREPARED',
  'SUBMITTED',
  'CONFIRMED',
  'UNKNOWN'
]);

export function isIntentEconomicallyActive(status: ExitIntentStatus): boolean {
  return ECONOMICALLY_ACTIVE_INTENT_STATUSES.has(status);
}

export function isIntentTerminal(status: ExitIntentStatus): boolean {
  return TERMINAL_INTENT_STATUSES.has(status);
}

export class StaleEpochError extends Error {
  constructor(
    message: string,
    public readonly intentId: string,
    public readonly expectedEpoch: bigint | number,
    public readonly actualEpoch: bigint | number
  ) {
    super(message);
    this.name = 'StaleEpochError';
  }
}

export class ActiveIntentExclusionError extends Error {
  constructor(
    message: string,
    public readonly walletId: string,
    public readonly mint: string,
    public readonly activeIntentId: string,
    public readonly activeStatus: ExitIntentStatus
  ) {
    super(message);
    this.name = 'ActiveIntentExclusionError';
  }
}

export class EpochRequiredError extends Error {
  constructor(message: string = 'expectedEpoch is mandatory for worker-owned mutations to enforce fencing') {
    super(message);
    this.name = 'EpochRequiredError';
  }
}

export class IllegalStateTransitionError extends Error {
  constructor(entityType: string, fromState: string, toState: string) {
    super(`Illegal state transition for ${entityType}: cannot transition from '${fromState}' to '${toState}'.`);
    this.name = 'IllegalStateTransitionError';
  }
}

export const VALID_INTENT_TRANSITIONS: ReadonlyMap<ExitIntentStatus, ReadonlySet<ExitIntentStatus>> = new Map([
  ['CREATED', new Set<ExitIntentStatus>(['CLAIMED', 'PREPARED', 'APPLIED', 'SUPERSEDED', 'CANCELLED'])],
  ['CLAIMED', new Set<ExitIntentStatus>(['PREPARED', 'SUBMITTED', 'CONFIRMED', 'APPLIED', 'SUPERSEDED', 'CANCELLED', 'FAILED_DEFINITIVE', 'UNKNOWN'])],
  ['PREPARED', new Set<ExitIntentStatus>(['SUBMITTED', 'CONFIRMED', 'APPLIED', 'SUPERSEDED', 'CANCELLED', 'FAILED_DEFINITIVE', 'UNKNOWN'])],
  ['SUBMITTED', new Set<ExitIntentStatus>(['CONFIRMED', 'APPLIED', 'UNKNOWN', 'FAILED_DEFINITIVE'])],
  ['UNKNOWN', new Set<ExitIntentStatus>(['CONFIRMED', 'APPLIED', 'FAILED_DEFINITIVE'])],
  ['CONFIRMED', new Set<ExitIntentStatus>(['APPLIED'])],
  ['APPLIED', new Set<ExitIntentStatus>()],
  ['SUPERSEDED', new Set<ExitIntentStatus>()],
  ['CANCELLED', new Set<ExitIntentStatus>()],
  ['FAILED_DEFINITIVE', new Set<ExitIntentStatus>()]
]);

export function assertValidIntentTransition(from: ExitIntentStatus, to: ExitIntentStatus): void {
  if (from === to) return;
  const allowed = VALID_INTENT_TRANSITIONS.get(from);
  if (!allowed || !allowed.has(to)) {
    throw new IllegalStateTransitionError('ExitIntent', from, to);
  }
}

/**
 * Finding P1-03 & 9.1 & 23: Explicit matrix of allowed intent states for prepareAttempt.
 * Intents in terminal states (APPLIED, FAILED_DEFINITIVE, SUPERSEDED, CANCELLED)
 * or active chain states (SUBMITTED, CONFIRMED, UNKNOWN) cannot prepare new attempts.
 */
export const ALLOWED_INTENT_STATUSES_FOR_PREPARE_ATTEMPT: ReadonlySet<ExitIntentStatus> = new Set([
  'CREATED',
  'CLAIMED',
  'PREPARED'
]);

export function assertCanPrepareAttemptForIntent(intentStatus: ExitIntentStatus): void {
  if (!ALLOWED_INTENT_STATUSES_FOR_PREPARE_ATTEMPT.has(intentStatus)) {
    throw new IllegalStateTransitionError(
      'ExitIntent',
      intentStatus,
      `PREPARE_ATTEMPT_REJECTED: Intent in status '${intentStatus}' cannot prepare a new attempt`
    );
  }
}

/**
 * Finding P1-04 & 24 & 25: Strict audit context for system/administrative mutations.
 * Distinguishes OBSERVATIONAL_SYSTEM_EVENT from FINANCIAL_STATE_MUTATION.
 */
export type SystemMutationClass = 'OBSERVATIONAL_SYSTEM_EVENT' | 'FINANCIAL_STATE_MUTATION';

export interface ObservationalSystemEventContext {
  readonly mutationClass: 'OBSERVATIONAL_SYSTEM_EVENT';
  readonly actor: string;
  readonly reason: string;
  readonly correlationId?: string;
  readonly expectedCurrentState?: string;
  readonly expectedEpoch?: bigint | number;
}

export interface FinancialStateMutationContext {
  readonly mutationClass?: 'FINANCIAL_STATE_MUTATION';
  readonly actor: string;
  readonly reason: string;
  readonly expectedCurrentState: string;
  readonly expectedEpoch: bigint | number;
  readonly transactionContext: {
    readonly wallet: string;
    readonly mint: string;
    readonly intentId?: string;
    readonly attemptId?: string;
  };
  readonly correlationId?: string;
}

export type SystemMutationContext = ObservationalSystemEventContext | FinancialStateMutationContext;

export interface SystemAuditEvent {
  readonly id?: number | string;
  readonly eventId: string;
  readonly actor: string;
  readonly reason: string;
  readonly mutationClass: SystemMutationClass;
  readonly entityType: 'ExitIntent' | 'ExecutionAttempt' | 'Position';
  readonly entityId: string;
  readonly beforeState: string;
  readonly afterState: string;
  readonly correlationId?: string;
  readonly createdAtWallMs: WallMs;
}

export function assertValidSystemMutationContext(
  context: SystemMutationContext,
  currentActualState?: string,
  options?: { isFinancial?: boolean }
): void {
  if (!context || !context.actor || context.actor.trim() === '') {
    throw new Error('System mutation rejected: actor is required.');
  }
  if (!context.reason || context.reason.trim() === '') {
    throw new Error('System mutation rejected: reason is required.');
  }

  const isFinancial = (context as any).mutationClass === 'FINANCIAL_STATE_MUTATION' ||
    (context as any).mutationClass === undefined ||
    options?.isFinancial === true;

  if (isFinancial && (context as any).mutationClass !== 'OBSERVATIONAL_SYSTEM_EVENT') {
    const finCtx = context as FinancialStateMutationContext;
    if (!finCtx.expectedCurrentState || finCtx.expectedCurrentState.trim() === '') {
      throw new Error('Financial system mutation rejected: expectedCurrentState is mandatory.');
    }
    if (finCtx.expectedEpoch === undefined || finCtx.expectedEpoch === null) {
      throw new EpochRequiredError('Financial system mutation rejected: expectedEpoch is mandatory.');
    }
    if (!finCtx.transactionContext || !finCtx.transactionContext.wallet || !finCtx.transactionContext.mint) {
      throw new Error('Financial system mutation rejected: transactionContext with wallet and mint is mandatory.');
    }
  }

  if (context.mutationClass === 'OBSERVATIONAL_SYSTEM_EVENT' && options?.isFinancial) {
    throw new Error('System mutation rejected: cannot apply OBSERVATIONAL_SYSTEM_EVENT to state mutation; must be FINANCIAL_STATE_MUTATION.');
  }

  if ((context as any).expectedCurrentState && currentActualState && (context as any).expectedCurrentState !== currentActualState) {
    throw new Error(
      `System mutation rejected: expectedCurrentState '${(context as any).expectedCurrentState}' does not match actual state '${currentActualState}'.`
    );
  }
}


export const VALID_ATTEMPT_TRANSITIONS: ReadonlyMap<ExecutionAttemptState, ReadonlySet<ExecutionAttemptState>> = new Map([
  ['INITIALIZED', new Set<ExecutionAttemptState>(['ORDER_READY', 'SIGNED', 'SIMULATED', 'SUBMITTED', 'SENT', 'FAILED', 'FAILED_DEFINITIVE'])],
  ['ORDER_READY', new Set<ExecutionAttemptState>(['SIGNED', 'SIMULATED', 'SUBMITTED', 'SENT', 'FAILED', 'FAILED_DEFINITIVE'])],
  ['SIGNED', new Set<ExecutionAttemptState>(['SIMULATED', 'SUBMITTED', 'SENT', 'UNKNOWN', 'FAILED', 'FAILED_DEFINITIVE'])],
  ['SIMULATED', new Set<ExecutionAttemptState>(['SUBMITTED', 'SENT', 'FAILED', 'FAILED_DEFINITIVE'])],
  ['SUBMITTED', new Set<ExecutionAttemptState>(['PROVIDER_SUCCESS', 'CONFIRMED', 'UNKNOWN', 'FAILED', 'FAILED_DEFINITIVE'])],
  ['SENT', new Set<ExecutionAttemptState>(['PROVIDER_SUCCESS', 'CONFIRMED', 'UNKNOWN', 'FAILED', 'FAILED_DEFINITIVE'])],
  ['PROVIDER_SUCCESS', new Set<ExecutionAttemptState>(['CONFIRMED', 'UNKNOWN', 'FAILED', 'FAILED_DEFINITIVE'])],
  ['UNKNOWN', new Set<ExecutionAttemptState>(['CONFIRMED', 'FAILED_DEFINITIVE'])],

  ['CONFIRMED', new Set<ExecutionAttemptState>()],
  ['FAILED_DEFINITIVE', new Set<ExecutionAttemptState>()],
  ['FAILED', new Set<ExecutionAttemptState>()]
]);

export function assertValidAttemptTransition(from: ExecutionAttemptState, to: ExecutionAttemptState): void {
  if (from === to) return;
  const allowed = VALID_ATTEMPT_TRANSITIONS.get(from);
  if (!allowed || !allowed.has(to)) {
    throw new IllegalStateTransitionError('ExecutionAttempt', from, to);
  }
}

export function hasPotentiallyLiveChainAttempt(attempts: ExecutionAttempt[]): boolean {
  return attempts.some(a => {
    if (a.signature && a.signature.trim().length > 0) return true;
    if (a.state === 'SIGNED' || a.state === 'SUBMITTED' || a.state === 'UNKNOWN' || a.state === 'SENT') return true;
    return false;
  });
}


// ==========================================
// 2. EXECUTION ATTEMPT STATES & CONTRACT
// ==========================================

export type ExecutionAttemptState =
  | 'INITIALIZED'
  | 'ORDER_READY'
  | 'SIGNED'
  | 'SIMULATED'
  | 'SUBMITTED'
  | 'PROVIDER_SUCCESS'
  | 'CONFIRMED'
  | 'FAILED_DEFINITIVE'
  | 'UNKNOWN'
  // Backwards compatibility aliases:
  | 'SENT'
  | 'FAILED';

export interface ExecutionAttempt {
  readonly attemptId: ExecutionAttemptId;
  readonly intentId: ExitIntentId;
  readonly provider: 'JUPITER_V2' | 'PUMP_NATIVE';
  readonly route?: string;
  requestId?: string;
  messageHash?: string;
  signature?: SolanaSignature;
  readonly requestedAmountAtomic: string;
  readonly expectedOutAtomic?: string;
  readonly minimumOutAtomic?: string;

  state: ExecutionAttemptState;
  failureReason?: string;
  errorClassification?: string;
  lastValidBlockHeight?: bigint | string;

  readonly startedAtWallMs: WallMs;
  preparedAtWallMs?: WallMs;
  submittedAtWallMs?: WallMs;
  providerReceiptAtWallMs?: WallMs;
  confirmedAtWallMs?: WallMs;
}

// ==========================================
// 3. FILL RECORD & RECONCILIATION CONTRACT
// ==========================================

export type FillEvidenceType =
  | 'CHAIN_PARSED_TRANSACTION'
  | 'CHAIN_ECONOMIC_EVIDENCE'
  | 'JUPITER_V2_RECEIPT'
  | 'HISTORICAL_RECONSTRUCTION';

export interface FillRecord {
  readonly id: FillId;
  readonly tradeId: TradeId;
  readonly positionId: PositionId;
  readonly intentId: ExitIntentId;
  readonly attemptId: ExecutionAttemptId;
  readonly signature: SolanaSignature;

  // Realization Tranche (Business level: e.g. 1 for first 50% partial, 2 for final exit)
  readonly realizationSequence: number;

  // On-chain Leg & Instruction identity (Blockchain level)
  readonly chainLegIndex: number;
  readonly instructionIndex: number;
  readonly innerInstructionIndex: number;

  readonly assetMint?: string;
  readonly requestedAmountAtomic: string;
  readonly actualAmountAtomic: string;
  readonly grossProceedsLamports: string;
  readonly networkFeeLamports: string;
  readonly priorityFeeLamports: string;
  readonly tipLamports: string;

  // Rent movement is recorded strictly separated from trading proceeds
  readonly rentMovementLamports: string;

  readonly slot?: number;
  readonly commitment?: string;
  readonly confirmedAtWallMs: WallMs;
  readonly evidenceType: FillEvidenceType;
  readonly createdAtWallMs: WallMs;
}

export type ReconciliationVerdict =
  | 'CAN_RETRY'
  | 'MUST_RECONCILE'
  | 'CONFIRMED'
  | 'FAILED_DEFINITIVE'
  | 'UNKNOWN';

export interface ExecutionReconciliationEvent {
  readonly id: string;
  readonly attemptId: ExecutionAttemptId;
  readonly signature?: SolanaSignature;
  readonly verdict: ReconciliationVerdict;
  readonly reason: string;
  readonly onChainStatus?: string;
  readonly blockhashValid?: boolean;
  readonly createdAtWallMs: WallMs;
}

// ==========================================
// 4. HELPER UTILITIES
// ==========================================

export interface ComputeDedupeKeyInput {
  walletId: string;
  mint: string;
  positionVersion?: bigint | number | string | null;
  requestedAmountAtomic: string;
  amountPolicy: ExitIntentAmountPolicy;
}

/**
 * Computes deterministic economic dedupe key decoupled from reason and severity.
 * Formula: sha256("walletId:mint:positionVersion:requestedAmountAtomic:amountPolicy")
 */
export function computeEconomicDedupeKey(input: ComputeDedupeKeyInput): string {
  const versionStr = input.positionVersion !== null && input.positionVersion !== undefined
    ? String(input.positionVersion)
    : 'none';
  const raw = `${input.walletId}:${input.mint}:${versionStr}:${input.requestedAmountAtomic}:${input.amountPolicy}`;
  return crypto.createHash('sha256').update(raw).digest('hex');
}

/**
 * Safely escalates an intent severity while recording an immutable audit event.
 * Severity can only remain same or increase (NORMAL -> HIGH -> EMERGENCY).
 */
export function recordSeverityEscalation(
  intent: ExitIntent,
  newSeverity: ExitIntentSeverity,
  reason: ExitIntentReason,
  observationId?: string
): IntentSeverityEvent {
  const event: IntentSeverityEvent = {
    intentId: intent.id,
    fromSeverity: intent.currentSeverity,
    toSeverity: newSeverity,
    reason,
    observationId,
    changedAtWallMs: nowWallMs(),
    changedAtMonoNs: nowMonotonicNs()
  };
  intent.currentSeverity = newSeverity;
  intent.reason = reason;
  intent.severityAuditTrail.push(event);
  return event;
}
