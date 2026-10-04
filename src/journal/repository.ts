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
  positionVersion?: number | string | null;
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
  nowMs?: number;
}

export interface ClaimIntentInput {
  workerId: string;
  leaseDurationMs: number;
  nowMs?: number;
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
    observationId?: string
  ): Promise<IntentSeverityEvent>;
  claimIntent(input: ClaimIntentInput): Promise<ExitIntent | null>;
  prepareAttempt(input: PrepareAttemptInput): Promise<ExecutionAttempt>;
  getAttemptById(attemptId: string): Promise<ExecutionAttempt | null>;
  getAttemptsForIntent(intentId: string): Promise<ExecutionAttempt[]>;
  updateAttemptState(
    attemptId: string,
    state: ExecutionAttemptState,
    updates?: Partial<ExecutionAttempt>
  ): Promise<ExecutionAttempt>;
  recordFill(fill: FillRecord): Promise<{ fill: FillRecord; created: boolean }>;
  getFillsForTrade(tradeId: string): Promise<FillRecord[]>;
  getFillsForPosition(positionId: string): Promise<FillRecord[]>;
  recordReconciliationEvent(
    event: Omit<ExecutionReconciliationEvent, 'id' | 'createdAtWallMs'>
  ): Promise<ExecutionReconciliationEvent>;
}

// ==========================================
// 4. IN-MEMORY ACID-COMPLIANT IMPLEMENTATION
// ==========================================

export class InMemoryExitJournalRepository implements IExitJournalRepository {
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
      claimEpoch: 0,
      claimedAtWallMs: null,
      leaseExpiresAtWallMs: null,
      status: 'CREATED',
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
    observationId?: string
  ): Promise<IntentSeverityEvent> {
    const intent = this.intents.get(intentId);
    if (!intent) {
      throw new Error(`ExitIntent not found: ${intentId}`);
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
        (intent.status === 'CLAIMED' || intent.status === 'PREPARED') &&
        intent.leaseExpiresAtWallMs !== null &&
        intent.leaseExpiresAtWallMs !== undefined &&
        Number(intent.leaseExpiresAtWallMs) < now;

      if (!isCreated && !isLeaseExpired) {
        continue;
      }

      // CRITICAL LEASE RECOVERY RULE:
      // If an existing attempt reached SIGNED, SUBMITTED, or UNKNOWN,
      // it CANNOT be reassigned without prior reconciliation!
      if (isLeaseExpired) {
        const attempts = await this.getAttemptsForIntent(intent.id);
        const blockingAttempt = attempts.find(a =>
          a.state === 'SIGNED' || a.state === 'SUBMITTED' || a.state === 'UNKNOWN' || a.state === 'SENT'
        );
        if (blockingAttempt) {
          throw new LeaseRecoveryBlockedError(
            `Lease recovery blocked for intent ${intent.id}: attempt ${blockingAttempt.attemptId} is in active on-chain state '${blockingAttempt.state}'. Must reconcile before re-claim.`,
            intent.id,
            blockingAttempt.state
          );
        }
      }

      // Lock and claim
      this.lockedIntents.add(intent.id);
      try {
        intent.claimedBy = input.workerId;
        intent.claimEpoch += 1;
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

  public async prepareAttempt(input: PrepareAttemptInput): Promise<ExecutionAttempt> {
    const intent = this.intents.get(input.intentId);
    if (!intent) {
      throw new Error(`ExitIntent not found for attempt: ${input.intentId}`);
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
    updates?: Partial<ExecutionAttempt>
  ): Promise<ExecutionAttempt> {
    const attempt = this.attempts.get(attemptId);
    if (!attempt) {
      throw new Error(`ExecutionAttempt not found: ${attemptId}`);
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

    // Update parent intent state accordingly
    const intent = this.intents.get(attempt.intentId);
    if (intent) {
      if (state === 'SUBMITTED' || state === 'SENT') {
        intent.status = 'SUBMITTED';
      } else if (state === 'CONFIRMED') {
        intent.status = 'CONFIRMED';
      } else if (state === 'FAILED_DEFINITIVE') {
        intent.status = 'FAILED_DEFINITIVE';
      } else if (state === 'UNKNOWN') {
        intent.status = 'UNKNOWN';
      }
    }

    return { ...attempt };
  }

  public async recordFill(fill: FillRecord): Promise<{ fill: FillRecord; created: boolean }> {
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

    // Append-only rule: fill id must not already exist
    if (this.fills.has(fill.id)) {
      throw new AppendOnlyViolationError(`Fill ID already exists: ${fill.id}. Cannot overwrite existing fill.`);
    }

    this.fills.set(fill.id, { ...fill });
    this.fillsByOnChainIdentity.set(onChainKey, fill.id);

    // Update parent intent status to APPLIED
    const intent = this.intents.get(fill.intentId);
    if (intent) {
      intent.status = 'APPLIED';
    }

    return { fill: { ...fill }, created: true };
  }

  public async getFillsForTrade(tradeId: string): Promise<FillRecord[]> {
    return Array.from(this.fills.values()).filter(f => f.tradeId === tradeId);
  }

  public async getFillsForPosition(positionId: string): Promise<FillRecord[]> {
    return Array.from(this.fills.values()).filter(f => f.positionId === positionId);
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
    });
  }

  public static restoreFromSnapshot(json: string): InMemoryExitJournalRepository {
    const parsed = JSON.parse(json);
    const repo = new InMemoryExitJournalRepository();
    for (const [k, v] of parsed.intents) {
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
