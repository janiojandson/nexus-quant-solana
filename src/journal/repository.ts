/**
 * Nexus Quant Solana — V2.1A Exit Journal & Fill Ledger Repository
 *
 * Provides the durable repository interface, custom error hierarchies,
 * and an ACID-compliant in-memory implementation supporting concurrency,
 * SKIP LOCKED simulation, lease timeouts, and crash-recovery testing.
 */

import {
  ExitIntent,
  ExitIntentId,
  ExitIntentStatus,
  ExitIntentSeverity,
  ExitIntentReason,
  ExitIntentAmountPolicy,
  ExecutionAttempt,
  ExecutionAttemptId,
  ExecutionAttemptState,
  FillRecord,
  FillId,
  IntentSeverityEvent,
  ExecutionReconciliationEvent,
  ReconciliationVerdict,
  TradeId,
  PositionId,
  WallMs,
  nowWallMs,
  nowMonotonicNs,
  computeEconomicDedupeKey
} from './types';

// ==========================================
// 1. REPOSITORY ERRORS
// ==========================================

export class EconomicConflictError extends Error {
  constructor(message: string, public readonly dedupeKey: string, public readonly conflictingFields: Record<string, unknown>) {
    super(message);
    this.name = 'EconomicConflictError';
  }
}

export class AppendOnlyViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AppendOnlyViolationError';
  }
}

export class LeaseRecoveryBlockedError extends Error {
  constructor(message: string, public readonly intentId: string, public readonly blockingAttemptState: string) {
    super(message);
    this.name = 'LeaseRecoveryBlockedError';
  }
}

// ==========================================
// 2. INPUT / DTO INTERFACES
// ==========================================

export interface CreateIntentInput {
  id?: ExitIntentId;
  tradeId: TradeId;
  positionId: PositionId;
  walletId: string;
  mint: string;
  tokenProgram: string;
  positionVersion?: bigint | number | string | null;
  requestedAmountAtomic: string;
  amountPolicy: ExitIntentAmountPolicy;
  initialSeverity: ExitIntentSeverity;
  reason: ExitIntentReason;
  policyVersion: string;
  expiresInMs?: number;
  nowMs?: number;
}

export interface PrepareAttemptInput {
  attemptId: ExecutionAttemptId;
  intentId: ExitIntentId;
  provider: 'JUPITER_V2' | 'PUMP_NATIVE';
  route?: string;
  requestId?: string;
  messageHash?: string;
  signature?: string;
  requestedAmountAtomic: string;
  expectedOutAtomic?: string;
  minimumOutAtomic?: string;
  initialState?: ExecutionAttemptState;
  lastValidBlockHeight?: bigint | string | number;
  nowMs?: number;
}

export interface ClaimIntentInput {
  workerId: string;
  leaseDurationMs: number;
  nowMs?: number;
  intentId?: string;
}

// ==========================================
// 3. REPOSITORY INTERFACE
// ==========================================

export interface IExitJournalRepository {
  createOrGetIntent(input: CreateIntentInput): Promise<{ intent: ExitIntent; created: boolean }>;
  getIntentById(id: string): Promise<ExitIntent | null>;
  getIntentByDedupeKey(dedupeKey: string): Promise<ExitIntent | null>;
  updateIntentSeverity(
    intentId: string,
    newSeverity: ExitIntentSeverity,
    reason: ExitIntentReason,
    observationId?: string,
    expectedEpoch?: bigint | number
  ): Promise<IntentSeverityEvent>;
  claimIntent(input: ClaimIntentInput): Promise<ExitIntent | null>;
  prepareAttempt(input: PrepareAttemptInput, expectedEpoch?: bigint | number): Promise<ExecutionAttempt>;
  getAttemptById(attemptId: string): Promise<ExecutionAttempt | null>;
  getAttemptsForIntent(intentId: string): Promise<ExecutionAttempt[]>;
  updateAttemptState(
    attemptId: string,
    state: ExecutionAttemptState,
    updates?: Partial<ExecutionAttempt>,
    expectedEpoch?: bigint | number
  ): Promise<ExecutionAttempt>;
  recordFill(fill: FillRecord, expectedEpoch?: bigint | number): Promise<{ fill: FillRecord; created: boolean }>;
  getFillsForTrade(tradeId: string): Promise<FillRecord[]>;
  getFillsForPosition(positionId: string): Promise<FillRecord[]>;
  recordReconciliationEvent(
    event: Omit<ExecutionReconciliationEvent, 'id' | 'createdAtWallMs'>
  ): Promise<ExecutionReconciliationEvent>;
  getIntent?(id: string): Promise<ExitIntent | null>;
  claimNextIntent?(input: ClaimIntentInput): Promise<ExitIntent | null>;
  renewLease?(intentId: string, workerId: string, durationMs: number, expectedEpoch?: bigint | number): Promise<ExitIntent>;
  recordSeverityEvent?(intentId: string, newSeverity: ExitIntentSeverity, reason: ExitIntentReason, observationId?: string, expectedEpoch?: bigint | number): Promise<IntentSeverityEvent>;
  createAttempt?(input: PrepareAttemptInput, expectedEpoch?: bigint | number): Promise<ExecutionAttempt>;
  markReconciliationDebt?(intentId: string, debt: boolean, expectedEpoch?: bigint | number): Promise<ExitIntent>;
  applyFillIdempotently?(fill: FillRecord, expectedEpoch?: bigint | number): Promise<{ fill: FillRecord; created: boolean }>;
  releaseTerminalIntent?(intentId: string, terminalStatus: ExitIntentStatus, expectedEpoch?: bigint | number): Promise<ExitIntent>;
  getUnreconciledIntents?(): Promise<ExitIntent[]>;
}

// ==========================================
// 4. IN-MEMORY CONTRACT-TESTING IMPLEMENTATION
// ==========================================

import {
  isIntentEconomicallyActive,
  isIntentTerminal,
  StaleEpochError,
  ActiveIntentExclusionError
} from './types';

export class InMemoryJournalRepository implements IExitJournalRepository {
  private intents = new Map<string, ExitIntent>(); // id -> intent
  private intentsByDedupeKey = new Map<string, string>(); // dedupeKey -> id
  private attempts = new Map<string, ExecutionAttempt>(); // attemptId -> attempt
  private attemptsByIntent = new Map<string, string[]>(); // intentId -> attemptId[]
  private fills = new Map<string, FillRecord>(); // id -> fill
  private fillsByOnChainIdentity = new Map<string, string>(); // signature:leg:ix:inner -> fillId
  private reconciliationEvents: ExecutionReconciliationEvent[] = [];

  // Concurrency mutex simulation
  private lockedIntents = new Set<string>();

  public async createOrGetIntent(input: CreateIntentInput): Promise<{ intent: ExitIntent; created: boolean }> {
    const dedupeKey = computeEconomicDedupeKey({
      walletId: input.walletId,
      mint: input.mint,
      positionVersion: input.positionVersion,
      requestedAmountAtomic: input.requestedAmountAtomic,
      amountPolicy: input.amountPolicy
    });

    const existingId = this.intentsByDedupeKey.get(dedupeKey);
    if (existingId) {
      const existing = this.intents.get(existingId);
      if (existing) {
        // Validate economic compatibility: must not differ in economic fundamentals
        const sameWallet = existing.walletId === input.walletId;
        const sameMint = existing.mint === input.mint;
        const sameAmount = existing.requestedAmountAtomic === input.requestedAmountAtomic;
        const samePolicy = existing.amountPolicy === input.amountPolicy;

        if (!sameWallet || !sameMint || !sameAmount || !samePolicy) {
          throw new EconomicConflictError(
            `Economic intent dedupe key collision with conflicting parameters for key ${dedupeKey}`,
            dedupeKey,
            { walletId: input.walletId, mint: input.mint, amount: input.requestedAmountAtomic, policy: input.amountPolicy }
          );
        }

        return { intent: existing, created: false };
      }
    }

    // Active Intent Exclusion: check if any economically active intent exists on the same wallet + mint
    for (const existing of this.intents.values()) {
      if (existing.walletId === input.walletId && existing.mint === input.mint) {
        if (isIntentEconomicallyActive(existing.status) || existing.reconciliationDebt) {
          throw new ActiveIntentExclusionError(
            `Active intent ${existing.id} already exists for wallet ${input.walletId} and mint ${input.mint} in status '${existing.status}' (reconciliationDebt=${existing.reconciliationDebt}). Competing intent rejected.`,
            input.walletId,
            input.mint,
            existing.id,
            existing.status
          );
        }
      }
    }

    const now = (input.nowMs ?? nowWallMs()) as WallMs;
    const ttlMs = input.expiresInMs ?? 60_000;
    const expiresAt = (Number(now) + ttlMs) as WallMs;

    const id = (input.id || `intent_${now}_${Math.random().toString(36).slice(2, 8)}`) as ExitIntentId;

    const newIntent: ExitIntent = {
      id,
      tradeId: input.tradeId,
      positionId: input.positionId,
      walletId: input.walletId,
      mint: input.mint,
      tokenProgram: input.tokenProgram,
      positionVersion: (input.positionVersion !== null && input.positionVersion !== undefined ? String(input.positionVersion) : null) as any,
      requestedAmountAtomic: input.requestedAmountAtomic,
      amountPolicy: input.amountPolicy,
      economicDedupeKey: dedupeKey,
      initialSeverity: input.initialSeverity,
      currentSeverity: input.initialSeverity,
      severityAuditTrail: [],
      reason: input.reason,
      policyVersion: input.policyVersion,
      claimedBy: null,
      claimEpoch: 0n,
      claimedAtWallMs: null,
      leaseExpiresAtWallMs: null,
      status: 'CREATED',
      reconciliationDebt: false,
      createdAtWallMs: now,
      expiresAtWallMs: expiresAt
    };

    this.intents.set(id, newIntent);
    this.intentsByDedupeKey.set(dedupeKey, id);

    return { intent: newIntent, created: true };
  }

  public async getIntentById(id: string): Promise<ExitIntent | null> {
    return this.intents.get(id) || null;
  }

  public async getIntentByDedupeKey(dedupeKey: string): Promise<ExitIntent | null> {
    const id = this.intentsByDedupeKey.get(dedupeKey);
    return id ? (this.intents.get(id) || null) : null;
  }

  public async updateIntentSeverity(
    intentId: string,
    newSeverity: ExitIntentSeverity,
    reason: ExitIntentReason,
    observationId?: string,
    expectedEpoch?: bigint | number
  ): Promise<IntentSeverityEvent> {
    const intent = this.intents.get(intentId);
    if (!intent) {
      throw new Error(`ExitIntent not found: ${intentId}`);
    }

    if (expectedEpoch !== undefined && intent.claimEpoch !== BigInt(expectedEpoch)) {
      throw new StaleEpochError(
        `Stale claim epoch for intent ${intent.id}: expected ${expectedEpoch}, actual ${intent.claimEpoch}`,
        intent.id,
        BigInt(expectedEpoch),
        intent.claimEpoch
      );
    }

    const event: IntentSeverityEvent = {
      id: `sev_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
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

  public async claimIntent(input: ClaimIntentInput): Promise<ExitIntent | null> {
    const now = input.nowMs ?? nowWallMs();

    // Simulates SELECT ... FOR UPDATE SKIP LOCKED
    for (const intent of this.intents.values()) {
      if (this.lockedIntents.has(intent.id)) {
        continue; // Locked by another worker in flight
      }

      const isCreated = intent.status === 'CREATED';
      const isLeaseExpired =
        intent.leaseExpiresAtWallMs !== null &&
        intent.leaseExpiresAtWallMs !== undefined &&
        Number(intent.leaseExpiresAtWallMs) < now &&
        !isIntentTerminal(intent.status);

      if (!isCreated && !isLeaseExpired) {
        continue;
      }

      // CRITICAL LEASE RECOVERY RULE:
      // If an existing attempt reached SIGNED, SUBMITTED, UNKNOWN, or SENT,
      // or if reconciliationDebt is true, it CANNOT be blindly reassigned without prior reconciliation!
      if (isLeaseExpired) {
        const attempts = await this.getAttemptsForIntent(intent.id);
        const blockingAttempt = attempts.find(a =>
          a.state === 'SIGNED' || a.state === 'SUBMITTED' || a.state === 'UNKNOWN' || a.state === 'SENT'
        );
        if (blockingAttempt || intent.reconciliationDebt) {
          throw new LeaseRecoveryBlockedError(
            `Lease recovery blocked for intent ${intent.id}: attempt ${blockingAttempt?.attemptId ?? 'active'} is in active on-chain state '${blockingAttempt?.state ?? 'RECONCILIATION_DEBT'}'. Must reconcile before re-claim.`,
            intent.id,
            blockingAttempt?.state ?? 'RECONCILIATION_DEBT'
          );
        }
      }

      // Lock and claim
      this.lockedIntents.add(intent.id);
      try {
        intent.claimedBy = input.workerId;
        intent.claimEpoch += 1n;
        intent.claimedAtWallMs = now as WallMs;
        intent.leaseExpiresAtWallMs = (now + input.leaseDurationMs) as WallMs;
        intent.status = 'CLAIMED';
        return { ...intent };
      } finally {
        this.lockedIntents.delete(intent.id);
      }
    }

    return null;
  }

  public async prepareAttempt(input: PrepareAttemptInput, expectedEpoch?: bigint | number): Promise<ExecutionAttempt> {
    const intent = this.intents.get(input.intentId);
    if (!intent) {
      throw new Error(`ExitIntent not found for attempt: ${input.intentId}`);
    }

    if (expectedEpoch !== undefined && intent.claimEpoch !== BigInt(expectedEpoch)) {
      throw new StaleEpochError(
        `Stale claim epoch for intent ${intent.id}: expected ${expectedEpoch}, actual ${intent.claimEpoch}`,
        intent.id,
        BigInt(expectedEpoch),
        intent.claimEpoch
      );
    }

    const now = (input.nowMs ?? nowWallMs()) as WallMs;

    const attempt: ExecutionAttempt = {
      attemptId: input.attemptId,
      intentId: input.intentId,
      provider: input.provider,
      route: input.route,
      requestId: input.requestId,
      messageHash: input.messageHash,
      signature: input.signature as any,
      requestedAmountAtomic: input.requestedAmountAtomic,
      expectedOutAtomic: input.expectedOutAtomic,
      minimumOutAtomic: input.minimumOutAtomic,
      state: input.initialState ?? 'INITIALIZED',
      lastValidBlockHeight: input.lastValidBlockHeight,
      startedAtWallMs: now,
      preparedAtWallMs: input.initialState === 'ORDER_READY' || input.initialState === 'SIGNED' ? now : undefined
    };

    this.attempts.set(attempt.attemptId, attempt);
    const existingList = this.attemptsByIntent.get(input.intentId) || [];
    existingList.push(attempt.attemptId);
    this.attemptsByIntent.set(input.intentId, existingList);

    // Update parent intent status to PREPARED
    if (intent.status === 'CLAIMED' || intent.status === 'CREATED') {
      intent.status = 'PREPARED';
    }

    return { ...attempt };
  }

  public async getAttemptById(attemptId: string): Promise<ExecutionAttempt | null> {
    return this.attempts.get(attemptId) || null;
  }

  public async getAttemptsForIntent(intentId: string): Promise<ExecutionAttempt[]> {
    const ids = this.attemptsByIntent.get(intentId) || [];
    return ids.map(id => this.attempts.get(id)!).filter(Boolean);
  }

  public async updateAttemptState(
    attemptId: string,
    state: ExecutionAttemptState,
    updates?: Partial<ExecutionAttempt>,
    expectedEpoch?: bigint | number
  ): Promise<ExecutionAttempt> {
    const attempt = this.attempts.get(attemptId);
    if (!attempt) {
      throw new Error(`ExecutionAttempt not found: ${attemptId}`);
    }

    const intent = this.intents.get(attempt.intentId);
    if (intent) {
      if (expectedEpoch !== undefined && intent.claimEpoch !== BigInt(expectedEpoch)) {
        throw new StaleEpochError(
          `Stale claim epoch for intent ${intent.id}: expected ${expectedEpoch}, actual ${intent.claimEpoch}`,
          intent.id,
          BigInt(expectedEpoch),
          intent.claimEpoch
        );
      }
    }

    attempt.state = state;
    if (updates) {
      if (updates.signature !== undefined) attempt.signature = updates.signature;
      if (updates.requestId !== undefined) attempt.requestId = updates.requestId;
      if (updates.messageHash !== undefined) attempt.messageHash = updates.messageHash;
      if (updates.failureReason !== undefined) attempt.failureReason = updates.failureReason;
      if (updates.errorClassification !== undefined) attempt.errorClassification = updates.errorClassification;
      if (updates.preparedAtWallMs !== undefined) attempt.preparedAtWallMs = updates.preparedAtWallMs;
      if (updates.submittedAtWallMs !== undefined) attempt.submittedAtWallMs = updates.submittedAtWallMs;
      if (updates.providerReceiptAtWallMs !== undefined) attempt.providerReceiptAtWallMs = updates.providerReceiptAtWallMs;
      if (updates.confirmedAtWallMs !== undefined) attempt.confirmedAtWallMs = updates.confirmedAtWallMs;
    }

    // Update parent intent state and reconciliation debt accordingly
    if (intent) {
      if (state === 'SUBMITTED' || state === 'SENT') {
        intent.status = 'SUBMITTED';
        intent.reconciliationDebt = true;
      } else if (state === 'SIGNED') {
        intent.reconciliationDebt = true;
      } else if (state === 'UNKNOWN') {
        intent.status = 'UNKNOWN';
        intent.reconciliationDebt = true;
      } else if (state === 'CONFIRMED') {
        intent.status = 'CONFIRMED';
      } else if (state === 'FAILED_DEFINITIVE') {
        intent.status = 'FAILED_DEFINITIVE';
        // Clear reconciliation debt if no other active attempt is pending
        const otherAttempts = await this.getAttemptsForIntent(intent.id);
        const hasOtherActive = otherAttempts.some(a =>
          a.attemptId !== attemptId && (a.state === 'SIGNED' || a.state === 'SUBMITTED' || a.state === 'UNKNOWN')
        );
        if (!hasOtherActive) {
          intent.reconciliationDebt = false;
        }
      }
    }

    return { ...attempt };
  }

  public async recordFill(fill: FillRecord, expectedEpoch?: bigint | number): Promise<{ fill: FillRecord; created: boolean }> {
    // Unique on-chain identity: (signature, chainLegIndex, instructionIndex, innerInstructionIndex)
    const onChainKey = `${fill.signature}:${fill.chainLegIndex}:${fill.instructionIndex}:${fill.innerInstructionIndex}`;

    const existingId = this.fillsByOnChainIdentity.get(onChainKey);
    if (existingId) {
      const existing = this.fills.get(existingId);
      if (existing) {
        // Idempotent: return existing fill
        return { fill: existing, created: false };
      }
    }

    const intent = this.intents.get(fill.intentId);
    if (intent) {
      if (expectedEpoch !== undefined && intent.claimEpoch !== BigInt(expectedEpoch)) {
        throw new StaleEpochError(
          `Stale claim epoch for fill on intent ${intent.id}: expected ${expectedEpoch}, actual ${intent.claimEpoch}`,
          intent.id,
          BigInt(expectedEpoch),
          intent.claimEpoch
        );
      }
    }

    // Append-only rule: fill id must not already exist
    if (this.fills.has(fill.id)) {
      throw new AppendOnlyViolationError(`Fill ID already exists: ${fill.id}. Cannot overwrite existing fill.`);
    }

    this.fills.set(fill.id, { ...fill });
    this.fillsByOnChainIdentity.set(onChainKey, fill.id);

    // Update parent intent status to APPLIED and clear reconciliation debt
    if (intent) {
      intent.status = 'APPLIED';
      intent.reconciliationDebt = false;
    }

    return { fill: { ...fill }, created: true };
  }

  public async getFillsForTrade(tradeId: string): Promise<FillRecord[]> {
    return Array.from(this.fills.values()).filter(f => f.tradeId === tradeId);
  }

  public async getFillsForPosition(positionId: string): Promise<FillRecord[]> {
    return Array.from(this.fills.values()).filter(f => f.positionId === positionId);
  }

  public async getIntent(id: string): Promise<ExitIntent | null> {
    return this.getIntentById(id);
  }

  public async claimNextIntent(input: ClaimIntentInput): Promise<ExitIntent | null> {
    return this.claimIntent(input);
  }

  public async renewLease(
    intentId: string,
    workerId: string,
    durationMs: number,
    expectedEpoch?: bigint | number
  ): Promise<ExitIntent> {
    const intent = this.intents.get(intentId);
    if (!intent) {
      throw new Error(`ExitIntent not found: ${intentId}`);
    }
    if (intent.claimedBy !== workerId) {
      throw new Error(`Cannot renew lease for intent ${intentId}: claimed by ${intent.claimedBy}, caller is ${workerId}`);
    }
    if (expectedEpoch !== undefined && intent.claimEpoch !== BigInt(expectedEpoch)) {
      throw new StaleEpochError(
        `Stale claim epoch for intent ${intentId}: expected ${expectedEpoch}, actual ${intent.claimEpoch}`,
        intentId,
        BigInt(expectedEpoch),
        intent.claimEpoch
      );
    }
    intent.leaseExpiresAtWallMs = (Number(nowWallMs()) + durationMs) as WallMs;
    return { ...intent };
  }

  public async recordSeverityEvent(
    intentId: string,
    newSeverity: ExitIntentSeverity,
    reason: ExitIntentReason,
    observationId?: string,
    expectedEpoch?: bigint | number
  ): Promise<IntentSeverityEvent> {
    return this.updateIntentSeverity(intentId, newSeverity, reason, observationId, expectedEpoch);
  }

  public async createAttempt(input: PrepareAttemptInput, expectedEpoch?: bigint | number): Promise<ExecutionAttempt> {
    return this.prepareAttempt(input, expectedEpoch);
  }

  public async markReconciliationDebt(
    intentId: string,
    debt: boolean,
    expectedEpoch?: bigint | number
  ): Promise<ExitIntent> {
    const intent = this.intents.get(intentId);
    if (!intent) {
      throw new Error(`ExitIntent not found: ${intentId}`);
    }
    if (expectedEpoch !== undefined && intent.claimEpoch !== BigInt(expectedEpoch)) {
      throw new StaleEpochError(
        `Stale claim epoch for intent ${intentId}: expected ${expectedEpoch}, actual ${intent.claimEpoch}`,
        intentId,
        BigInt(expectedEpoch),
        intent.claimEpoch
      );
    }
    intent.reconciliationDebt = debt;
    return { ...intent };
  }

  public async applyFillIdempotently(fill: FillRecord, expectedEpoch?: bigint | number): Promise<{ fill: FillRecord; created: boolean }> {
    return this.recordFill(fill, expectedEpoch);
  }

  public async releaseTerminalIntent(
    intentId: string,
    terminalStatus: ExitIntentStatus,
    expectedEpoch?: bigint | number
  ): Promise<ExitIntent> {
    if (!isIntentTerminal(terminalStatus)) {
      throw new Error(`Cannot release intent ${intentId} with non-terminal status: ${terminalStatus}`);
    }
    const intent = this.intents.get(intentId);
    if (!intent) {
      throw new Error(`ExitIntent not found: ${intentId}`);
    }
    if (expectedEpoch !== undefined && intent.claimEpoch !== BigInt(expectedEpoch)) {
      throw new StaleEpochError(
        `Stale claim epoch for intent ${intentId}: expected ${expectedEpoch}, actual ${intent.claimEpoch}`,
        intentId,
        BigInt(expectedEpoch),
        intent.claimEpoch
      );
    }
    intent.status = terminalStatus;
    intent.reconciliationDebt = false;
    intent.claimedBy = undefined;
    intent.leaseExpiresAtWallMs = undefined;
    return { ...intent };
  }

  public async getUnreconciledIntents(): Promise<ExitIntent[]> {
    return Array.from(this.intents.values()).filter(
      i => i.reconciliationDebt || i.status === 'UNKNOWN'
    );
  }

  public async recordReconciliationEvent(
    event: Omit<ExecutionReconciliationEvent, 'id' | 'createdAtWallMs'>
  ): Promise<ExecutionReconciliationEvent> {
    const fullEvent: ExecutionReconciliationEvent = {
      ...event,
      id: `rec_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      createdAtWallMs: nowWallMs()
    };
    this.reconciliationEvents.push(fullEvent);
    return fullEvent;
  }


  /**
   * Helper for crash testing: snapshots in-memory state and reloads into a fresh repository.
   */
  public snapshotState(): string {
    return JSON.stringify({
      intents: Array.from(this.intents.entries()),
      attempts: Array.from(this.attempts.entries()),
      fills: Array.from(this.fills.entries()),
      reconciliations: this.reconciliationEvents
    }, (_k, v) => typeof v === 'bigint' ? `${v.toString()}n` : v);
  }

  public static restoreFromSnapshot(json: string): InMemoryJournalRepository {
    const parsed = JSON.parse(json, (_k, v) => {
      if (typeof v === 'string' && /^\d+n$/.test(v)) {
        return BigInt(v.slice(0, -1));
      }
      return v;
    });
    const repo = new InMemoryJournalRepository();
    for (const [k, v] of parsed.intents) {
      if (typeof v.claimEpoch === 'string' || typeof v.claimEpoch === 'number') {
        v.claimEpoch = BigInt(v.claimEpoch);
      }
      repo.intents.set(k, v);
      repo.intentsByDedupeKey.set(v.economicDedupeKey, k);
    }
    for (const [k, v] of parsed.attempts) {
      repo.attempts.set(k, v);
      const list = repo.attemptsByIntent.get(v.intentId) || [];
      list.push(k);
      repo.attemptsByIntent.set(v.intentId, list);
    }
    for (const [k, v] of parsed.fills) {
      repo.fills.set(k, v);
      const onChainKey = `${v.signature}:${v.chainLegIndex}:${v.instructionIndex}:${v.innerInstructionIndex}`;
      repo.fillsByOnChainIdentity.set(onChainKey, k);
    }
    repo.reconciliationEvents = parsed.reconciliations;
    return repo;
  }
}

// Backwards compatibility alias
export const InMemoryExitJournalRepository = InMemoryJournalRepository;

