/**
 * Nexus Quant Solana — V2.3A Durable Position Repository Interface & In-Memory Implementation
 *
 * Provides optimistic concurrency control (CAS) and append-only version mutation logging.
 */

import {
  PositionVersion,
  PositionStatus,
  PositionMutationType,
  DurablePosition,
  PositionMutationRecord,
  CreatePositionInput,
  UpdatePositionCASParams,
  ApplyFillParams,
  ApplyConfirmedFillInput,
  ApplyReconciliationAdjustmentInput,
  ArbitraryBalanceMutationRejectedError,
  ExternalBalanceDivergenceAdjustment,
  StalePositionVersionError,
  DuplicateFillApplicationError,
  ActivePositionConflictError,
  PositionNotFoundError,
  DEFAULT_TOKEN_PROGRAM_ID
} from './types.js';

export interface IPositionRepository {
  createPosition(input: CreatePositionInput, client?: any): Promise<DurablePosition>;
  getPosition(positionId: string, client?: any): Promise<DurablePosition | null>;
  getActivePositionByWalletMint(
    walletId: string,
    mint: string,
    tokenProgram?: string,
    client?: any
  ): Promise<DurablePosition | null>;
  getAllPositions(filter?: { walletId?: string; status?: PositionStatus }): Promise<DurablePosition[]>;
  updatePositionCAS(params: UpdatePositionCASParams, client?: any): Promise<{
    position: DurablePosition;
    mutation: PositionMutationRecord;
  }>;
  applyFill(params: ApplyFillParams, client?: any): Promise<{
    position: DurablePosition;
    mutation: PositionMutationRecord;
    alreadyApplied: boolean;
  }>;
  applyConfirmedFill(input: ApplyConfirmedFillInput, client?: any): Promise<{
    position: DurablePosition;
    mutation: PositionMutationRecord;
    alreadyApplied: boolean;
  }>;
  applyReconciliationAdjustment(input: ApplyReconciliationAdjustmentInput, client?: any): Promise<{
    position: DurablePosition;
    mutation: PositionMutationRecord;
  }>;
  reconcileExternalBalance(adjustment: ExternalBalanceDivergenceAdjustment, client?: any): Promise<{
    position: DurablePosition;
    mutation: PositionMutationRecord;
  }>;
  markReconciliationRequired(
    positionId: string,
    expectedVersion: PositionVersion,
    required: boolean,
    client?: any
  ): Promise<DurablePosition>;
}

export class InMemoryPositionRepository implements IPositionRepository {
  private positions = new Map<string, DurablePosition>();
  private mutations: PositionMutationRecord[] = [];
  private fillMutationKeys = new Set<string>(); // "positionId:fillId"
  private signatureMutationKeys = new Set<string>(); // "positionId:signature"

  public async createPosition(input: CreatePositionInput): Promise<DurablePosition> {
    const tokenProgram = input.tokenProgram || DEFAULT_TOKEN_PROGRAM_ID;
    
    // Check for existing active position on (walletId, mint, tokenProgram)
    const existingActive = await this.getActivePositionByWalletMint(
      input.walletId,
      input.mint,
      tokenProgram
    );
    if (existingActive) {
      throw new ActivePositionConflictError(
        `Active position ${existingActive.positionId} already exists for wallet ${input.walletId} and mint ${input.mint}`,
        input.walletId,
        input.mint,
        existingActive.positionId
      );
    }

    const now = new Date();
    const pos: DurablePosition = {
      positionId: input.positionId,
      tradeId: input.tradeId,
      walletId: input.walletId,
      mint: input.mint,
      tokenProgram,
      status: input.status || 'OPEN',
      positionVersion: input.initialVersion ?? 1n,
      tokenAmountAtomic: input.tokenAmountAtomic ?? input.initialAmountAtomic,
      initialAmountAtomic: input.initialAmountAtomic,
      initialPrincipalLamports: input.initialPrincipalLamports,
      confirmedProceedsLamports: 0n,
      openedAt: now,
      updatedAt: now,
      closedAt: null,
      lastFillId: null,
      lastChainSignature: null,
      reconciliationRequired: false,
      source: input.source || 'LIVE_EXECUTOR',
      provenance: input.provenance || null
    };

    this.positions.set(pos.positionId, pos);

    // Initial entry mutation
    const initialMutation: PositionMutationRecord = {
      id: this.mutations.length + 1,
      positionId: pos.positionId,
      fromVersion: 0n,
      toVersion: pos.positionVersion,
      mutationType: 'ENTRY_OPEN',
      fillId: null,
      signature: null,
      tokenAmountBefore: 0n,
      tokenAmountAfter: pos.tokenAmountAtomic,
      deltaAtomic: pos.tokenAmountAtomic,
      proceedsLamports: 0n,
      createdAt: now
    };
    this.mutations.push(initialMutation);

    return { ...pos };
  }

  public async getPosition(positionId: string): Promise<DurablePosition | null> {
    const pos = this.positions.get(positionId);
    return pos ? { ...pos } : null;
  }

  public async getActivePositionByWalletMint(
    walletId: string,
    mint: string,
    tokenProgram: string = DEFAULT_TOKEN_PROGRAM_ID
  ): Promise<DurablePosition | null> {
    for (const pos of this.positions.values()) {
      if (
        pos.walletId === walletId &&
        pos.mint === mint &&
        pos.tokenProgram === tokenProgram &&
        pos.status !== 'CLOSED' &&
        pos.status !== 'TERMINATED'
      ) {
        return { ...pos };
      }
    }
    return null;
  }

  public async getAllPositions(filter?: {
    walletId?: string;
    status?: PositionStatus;
  }): Promise<DurablePosition[]> {
    const list: DurablePosition[] = [];
    for (const pos of this.positions.values()) {
      if (filter?.walletId && pos.walletId !== filter.walletId) continue;
      if (filter?.status && pos.status !== filter.status) continue;
      list.push({ ...pos });
    }
    return list;
  }

  public async updatePositionCAS(params: UpdatePositionCASParams): Promise<{
    position: DurablePosition;
    mutation: PositionMutationRecord;
  }> {
    const pos = this.positions.get(params.positionId);
    if (!pos) {
      throw new PositionNotFoundError(`Position ${params.positionId} not found`, params.positionId);
    }

    if (pos.positionVersion !== params.expectedVersion) {
      throw new StalePositionVersionError(
        `CAS update failed for position ${params.positionId}: expected version ${params.expectedVersion}, found ${pos.positionVersion}`,
        params.positionId,
        params.expectedVersion,
        pos.positionVersion
      );
    }

    if (params.newAmountAtomic < 0n) {
      throw new ArbitraryBalanceMutationRejectedError(
        `Position amount cannot be negative: ${params.newAmountAtomic}`,
        params.positionId
      );
    }

    const previousVersion = pos.positionVersion;
    const nextVersion = previousVersion + 1n;
    const amountBefore = pos.tokenAmountAtomic;
    const amountAfter = params.newAmountAtomic;
    const delta = amountAfter - amountBefore;
    const now = new Date();

    pos.positionVersion = nextVersion;
    pos.tokenAmountAtomic = amountAfter;
    pos.updatedAt = now;

    if (params.newStatus) {
      pos.status = params.newStatus;
    } else if (amountAfter === 0n) {
      pos.status = 'CLOSED';
    }

    if (pos.status === 'CLOSED' || pos.status === 'TERMINATED') {
      pos.closedAt = pos.closedAt || now;
    }

    if (params.proceedsDeltaLamports && params.proceedsDeltaLamports > 0n) {
      pos.confirmedProceedsLamports += params.proceedsDeltaLamports;
    }

    if (params.fillId) {
      pos.lastFillId = params.fillId;
      this.fillMutationKeys.add(`${pos.positionId}:${params.fillId}`);
    }
    if (params.signature) {
      pos.lastChainSignature = params.signature;
      this.signatureMutationKeys.add(`${pos.positionId}:${params.signature}`);
    }
    if (params.reconciliationRequired !== undefined) {
      pos.reconciliationRequired = params.reconciliationRequired;
    }

    const mutation: PositionMutationRecord = {
      id: this.mutations.length + 1,
      positionId: pos.positionId,
      fromVersion: previousVersion,
      toVersion: nextVersion,
      mutationType: params.mutationType,
      fillId: params.fillId ?? null,
      signature: params.signature ?? null,
      tokenAmountBefore: amountBefore,
      tokenAmountAfter: amountAfter,
      deltaAtomic: delta,
      proceedsLamports: params.proceedsDeltaLamports ?? 0n,
      createdAt: now
    };
    this.mutations.push(mutation);

    return {
      position: { ...pos },
      mutation: { ...mutation }
    };
  }

  public async applyConfirmedFill(input: ApplyConfirmedFillInput): Promise<{
    position: DurablePosition;
    mutation: PositionMutationRecord;
    alreadyApplied: boolean;
  }> {
    const pos = this.positions.get(input.positionId);
    if (!pos) {
      throw new PositionNotFoundError(`Position ${input.positionId} not found`, input.positionId);
    }

    // Idempotency: verify if this fill was already applied to this position by fillId OR by signature
    const fillKey = `${input.positionId}:${input.fillId}`;
    const sigKey = input.signature ? `${input.positionId}:${input.signature}` : null;
    if (this.fillMutationKeys.has(fillKey) || (sigKey && this.signatureMutationKeys.has(sigKey))) {
      const existing = this.mutations.find(
        m => m.positionId === input.positionId && (
          m.fillId === input.fillId || (input.signature && m.signature === input.signature)
        )
      );
      if (existing) {
        return {
          position: { ...pos },
          mutation: { ...existing },
          alreadyApplied: true
        };
      }
    }

    // Verify expected position version
    if (pos.positionVersion !== input.expectedVersion) {
      throw new StalePositionVersionError(
        `Fill application rejected for position ${input.positionId}: expected version ${input.expectedVersion}, found ${pos.positionVersion}`,
        input.positionId,
        input.expectedVersion,
        pos.positionVersion
      );
    }

    if (input.confirmedActualDebitAtomic < 0n) {
      throw new ArbitraryBalanceMutationRejectedError(
        `Confirmed debit atomic cannot be negative: ${input.confirmedActualDebitAtomic}`,
        input.positionId
      );
    }

    if (input.confirmedActualDebitAtomic > pos.tokenAmountAtomic) {
      throw new ArbitraryBalanceMutationRejectedError(
        `Fill debit ${input.confirmedActualDebitAtomic} exceeds current position balance ${pos.tokenAmountAtomic}`,
        input.positionId
      );
    }

    const newAmount = pos.tokenAmountAtomic - input.confirmedActualDebitAtomic;
    if (newAmount < 0n) {
      throw new ArbitraryBalanceMutationRejectedError(
        `Calculated position balance cannot be negative: ${newAmount}`,
        input.positionId
      );
    }

    const isFinal = Boolean(input.isFinal || newAmount === 0n);
    const newStatus: PositionStatus = isFinal ? 'CLOSED' : 'PARTIAL_CLOSED';
    const mutationType: PositionMutationType = isFinal ? 'FINAL_FILL' : 'PARTIAL_FILL';

    const result = await this.updatePositionCAS({
      positionId: input.positionId,
      expectedVersion: input.expectedVersion,
      newAmountAtomic: newAmount,
      newStatus,
      proceedsDeltaLamports: input.grossProceedsLamports,
      fillId: input.fillId,
      signature: input.signature,
      mutationType
    });

    return {
      position: result.position,
      mutation: result.mutation,
      alreadyApplied: false
    };
  }

  public async applyFill(params: ApplyFillParams): Promise<{
    position: DurablePosition;
    mutation: PositionMutationRecord;
    alreadyApplied: boolean;
  }> {
    return this.applyConfirmedFill({
      positionId: params.positionId,
      expectedVersion: params.expectedVersion,
      fillId: params.fillId,
      signature: params.signature,
      confirmedActualDebitAtomic: params.fillAmountAtomic,
      grossProceedsLamports: params.proceedsLamports,
      isFinal: params.isFinal
    });
  }

  public async applyReconciliationAdjustment(input: ApplyReconciliationAdjustmentInput): Promise<{
    position: DurablePosition;
    mutation: PositionMutationRecord;
  }> {
    const pos = this.positions.get(input.positionId);
    if (!pos) {
      throw new PositionNotFoundError(
        `Position ${input.positionId} not found`,
        input.positionId
      );
    }

    if (!input.evidence || !input.evidence.reason || !input.evidence.source) {
      throw new ArbitraryBalanceMutationRejectedError(
        'Evidence metadata (source and reason) is strictly required for reconciliation adjustment',
        input.positionId
      );
    }

    if (input.observedBalanceAtomic < 0n) {
      throw new ArbitraryBalanceMutationRejectedError(
        `Observed balance cannot be negative: ${input.observedBalanceAtomic}`,
        input.positionId
      );
    }

    if (pos.positionVersion !== input.expectedVersion) {
      throw new StalePositionVersionError(
        `Reconciliation rejected for position ${input.positionId}: expected version ${input.expectedVersion}, found ${pos.positionVersion}`,
        input.positionId,
        input.expectedVersion,
        pos.positionVersion
      );
    }

    const newStatus: PositionStatus = input.observedBalanceAtomic === 0n
      ? 'CLOSED'
      : pos.status;

    return this.updatePositionCAS({
      positionId: input.positionId,
      expectedVersion: input.expectedVersion,
      newAmountAtomic: input.observedBalanceAtomic,
      newStatus,
      mutationType: 'RECONCILIATION_ADJUSTMENT',
      reconciliationRequired: false
    });
  }

  public async reconcileExternalBalance(adjustment: ExternalBalanceDivergenceAdjustment): Promise<{
    position: DurablePosition;
    mutation: PositionMutationRecord;
  }> {
    const pos = this.positions.get(adjustment.positionId);
    if (!pos) {
      throw new PositionNotFoundError(
        `Position ${adjustment.positionId} not found`,
        adjustment.positionId
      );
    }

    if (pos.positionVersion !== adjustment.expectedVersion) {
      throw new StalePositionVersionError(
        `Reconciliation rejected for position ${adjustment.positionId}: expected version ${adjustment.expectedVersion}, found ${pos.positionVersion}`,
        adjustment.positionId,
        adjustment.expectedVersion,
        pos.positionVersion
      );
    }

    const newStatus: PositionStatus = adjustment.observedChainAmountAtomic === 0n
      ? 'CLOSED'
      : pos.status;

    return this.updatePositionCAS({
      positionId: adjustment.positionId,
      expectedVersion: adjustment.expectedVersion,
      newAmountAtomic: adjustment.observedChainAmountAtomic,
      newStatus,
      mutationType: 'RECONCILIATION_ADJUSTMENT',
      reconciliationRequired: false
    });
  }

  public async markReconciliationRequired(
    positionId: string,
    expectedVersion: PositionVersion,
    required: boolean
  ): Promise<DurablePosition> {
    const pos = this.positions.get(positionId);
    if (!pos) {
      throw new PositionNotFoundError(`Position ${positionId} not found`, positionId);
    }
    if (pos.positionVersion !== expectedVersion) {
      throw new StalePositionVersionError(
        `markReconciliationRequired failed: expected version ${expectedVersion}, found ${pos.positionVersion}`,
        positionId,
        expectedVersion,
        pos.positionVersion
      );
    }
    pos.reconciliationRequired = required;
    pos.updatedAt = new Date();
    return { ...pos };
  }

  public getMutations(positionId?: string): PositionMutationRecord[] {
    if (!positionId) return [...this.mutations];
    return this.mutations.filter(m => m.positionId === positionId);
  }

  public clear(): void {
    this.positions.clear();
    this.mutations = [];
    this.fillMutationKeys.clear();
  }
}
