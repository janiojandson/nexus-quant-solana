/**
 * Nexus Quant Solana — V2.0 Telemetry, Clocks, Tracing and Accounting Types
 * Strict Separation:
 * 1. Monotonic Clock (nanoseconds) vs Wall Clock (milliseconds)
 * 2. Non-critical Telemetry (drop-tolerant) vs Financial Journal (strictly durable)
 * 3. Economic Identity vs Strategy Triggers / Severity Elevation
 * 4. Profit Tranches (business realization) vs Chain Legs / Instruction Indices
 */

// ==========================================
// 1. BRANDED CLOCK DOMAINS
// ==========================================

export type MonotonicNs = bigint & { readonly __brand: unique symbol };
export type WallMs = number & { readonly __brand: unique symbol };

/**
 * Returns current monotonic timestamp in nanoseconds using process.hrtime.bigint().
 * Use ONLY for relative interval and process-local latency measurements.
 */
export function nowMonotonicNs(): MonotonicNs {
  return process.hrtime.bigint() as MonotonicNs;
}

/**
 * Returns current wall-clock timestamp in milliseconds (Date.now()).
 * Use ONLY for audit logs, human readability and persistent timestamps.
 */
export function nowWallMs(): WallMs {
  return Date.now() as WallMs;
}

/**
 * Calculates elapsed duration in milliseconds between two MonotonicNs marks.
 */
export function diffMonotonicMs(start: MonotonicNs, end: MonotonicNs): number {
  return Number(end - start) / 1_000_000;
}

/**
 * Safely calculates latency between external event wall-clock and process receipt wall-clock.
 * Returns null (UNKNOWN) if timestamps are missing, inverted or semantically incompatible.
 */
export function calculateSourceToReceiveMs(
  sourceEventWallMs?: WallMs | null,
  receivedWallMs?: WallMs | null
): number | null {
  if (sourceEventWallMs === undefined || sourceEventWallMs === null) return null;
  if (receivedWallMs === undefined || receivedWallMs === null) return null;
  const delta = Number(receivedWallMs) - Number(sourceEventWallMs);
  // Negative delta implies uncalibrated clock skew across machines
  if (delta < 0) return null;
  return delta;
}

// ==========================================
// 2. TIMING PROFILE PER PIPELINE STAGE
// ==========================================

export interface EventTimingProfile {
  // Wall-clock domain (audit & synchronization)
  sourceEventWallMs?: WallMs;
  sourceSlot?: number;
  sourceCommitment?: 'processed' | 'confirmed' | 'finalized';
  receivedWallMs: WallMs;
  persistedWallMs?: WallMs;
  confirmedWallMs?: WallMs;

  // Monotonic domain (strictly internal process profiling)
  receivedMonoNs: MonotonicNs;
  parsedMonoNs: MonotonicNs;
  decisionStartMonoNs: MonotonicNs;
  decisionEndMonoNs: MonotonicNs;
  queueEnterMonoNs?: MonotonicNs;
  queueClaimMonoNs?: MonotonicNs;
  orderStartMonoNs?: MonotonicNs;
  orderEndMonoNs?: MonotonicNs;
  signStartMonoNs?: MonotonicNs;
  signEndMonoNs?: MonotonicNs;
  simulationStartMonoNs?: MonotonicNs;
  simulationEndMonoNs?: MonotonicNs;
  preSendPersistStartMonoNs?: MonotonicNs;
  preSendPersistEndMonoNs?: MonotonicNs;
  sendStartMonoNs?: MonotonicNs;
  sendEndMonoNs?: MonotonicNs;
  confirmationStartMonoNs?: MonotonicNs;
  confirmationEndMonoNs?: MonotonicNs;
  reconciliationStartMonoNs?: MonotonicNs;
  reconciliationEndMonoNs?: MonotonicNs;
  fillAppliedMonoNs?: MonotonicNs;
}

// ==========================================
// 3. CORE IDENTIFIERS & TRACEABILITY
// ==========================================

export type TradeId = string;
export type PositionId = string;
export type PositionVersion = number;
export type ObservationId = string;
export type DecisionId = string;
export type ExitIntentId = string;
export type ExecutionAttemptId = string;
/**
 * Solana transaction signature: 64-byte Ed25519 signature encoded in base58.
 * NOTE: This is a cryptographic digital signature, NOT a hash.
 */
export type SolanaSignature = string;
export type FillId = string;

// ==========================================
// 4. FINANCIAL JOURNAL: EXIT INTENT
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

export type ExitIntentReason =
  | 'STOP_LOSS'
  | 'TRAILING_STOP'
  | 'TAKE_PROFIT_PARTIAL'
  | 'PANIC'
  | 'LIQUIDITY_DRAIN';

export interface ExitIntent {
  readonly id: ExitIntentId;
  readonly tradeId: TradeId;
  readonly positionId: PositionId;
  readonly walletId: string;
  readonly mint: string;
  readonly tokenProgram: string;
  readonly positionVersion: PositionVersion;
  readonly requestedAmountAtomic: string;
  readonly amountPolicy: 'FULL_REMAINDER' | 'PARTIAL_50' | 'CUSTOM';
  
  // Economic Dedupe Key: decoupled from reason and severity
  // Formula: sha256(walletId:mint:positionVersion:requestedAmountAtomic:amountPolicy)
  readonly economicDedupeKey: string;

  // Mutable operational triggers on the same active economic intent
  reason: ExitIntentReason;
  severity: ExitIntentSeverity;
  severityElevatedAt?: WallMs;
  policyVersion: string;

  status: ExitIntentStatus;
  supersededBy?: ExitIntentId;

  readonly createdAtWallMs: WallMs;
  readonly expiresAtWallMs: WallMs;
}

// ==========================================
// 5. FINANCIAL JOURNAL: EXECUTION ATTEMPT
// ==========================================

export type ExecutionAttemptState =
  | 'INITIALIZED'
  | 'ORDER_READY'
  | 'SIGNED'
  | 'SIMULATED'
  | 'SENT'
  | 'CONFIRMED'
  | 'FAILED'
  | 'UNKNOWN';

export interface ExecutionAttempt {
  readonly id: ExecutionAttemptId;
  readonly intentId: ExitIntentId;
  readonly provider: 'JUPITER_V2' | 'PUMP_NATIVE';
  readonly route: string;
  requestId?: string;
  messageHash?: string;
  signature?: SolanaSignature;
  readonly requestedAmountAtomic: string;
  readonly expectedOutLamports: string;
  readonly minimumOutLamports: string;
  
  state: ExecutionAttemptState;
  failureReason?: string;

  readonly startedAtWallMs: WallMs;
  submittedAtWallMs?: WallMs;
  confirmedAtWallMs?: WallMs;
}

// ==========================================
// 6. FINANCIAL JOURNAL: FILL RECORD
// ==========================================

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
  readonly instructionIndex?: number;
  readonly innerInstructionIndex?: number;

  readonly requestedAmountAtomic: string;
  readonly actualAmountAtomic: string;
  readonly proceedsLamports: string;
  readonly proceedsSol: number;
  readonly networkFeeLamports: string;
  readonly priorityFeeLamports: string;
  readonly tipLamports: string;
  
  // Rent movement is recorded strictly separated from trading proceeds
  readonly rentMovementLamports: string;

  readonly slot?: number;
  readonly commitment?: string;
  readonly confirmedAtWallMs: WallMs;
  readonly evidenceType: 'JUPITER_V2_RECEIPT' | 'CHAIN_PARSED_TRANSACTION';
}

// ==========================================
// 7. FINANCIAL ACCOUNTING CONTRACT
// ==========================================

export interface TradeAccounting {
  readonly tradeId: TradeId;
  
  // Capital & Costs
  readonly initialPrincipalLamports: bigint;
  readonly entryFeesLamports: bigint;
  
  // Confirmed Trading Realizations
  readonly confirmedGrossProceedsLamports: bigint;
  // Trading costs: network fees + priority fees + tips + protocol fees (excludes initialPrincipal)
  readonly confirmedTradingCostsLamports: bigint;
  
  // Net Recovered Capital = confirmedGrossProceeds - confirmedTradingCosts
  readonly netRecoveredLamports: bigint;
  
  // Capital Recovered Pct = 100 * (netRecoveredLamports / initialPrincipalLamports)
  readonly capitalRecoveredPct: number;

  // Realized PnL of closed portions
  readonly realizedPnLLamports: bigint;
  
  // Trade Equity PnL = (netRecoveredLamports + currentExecutableValueLamports) - initialPrincipalLamports
  readonly tradeEquityPnLLamports: bigint;

  // Rent movement: segregated from swap profit
  readonly rentRecoveredLamports: bigint;
}

// ==========================================
// 8. ERROR CLASSIFICATION
// ==========================================

export interface ErrorClassification {
  programId?: string;
  customCode?: number;
  instructionIndex?: number;
  logsDigest?: string;
  classifiedAs:
    | 'SLIPPAGE_EXCEEDED'
    | 'INSUFFICIENT_POOL_DEPTH'
    | 'CUSTOM_PROGRAM_ERROR'
    | 'NETWORK_TIMEOUT'
    | 'RATE_LIMITED'
    | 'UNKNOWN';
  confidence: 'DEFINITIVE' | 'INFERRED' | 'UNVERIFIED';
  evidence: string;
}

// ==========================================
// 9. TELEMETRY SPAN (BOUNDED / DROP-TOLERANT)
// ==========================================

export interface TelemetrySpan {
  readonly id: string;
  readonly traceId: string;
  readonly spanName: string;
  readonly providerAlias?: 'HELIUS' | 'QUICKNODE' | 'SOLANA_PUBLIC' | 'JUPITER' | 'CUSTOM';
  readonly durationMs: number;
  readonly status: 'SUCCESS' | 'ERROR' | 'DROPPED';
  readonly metadata?: Record<string, unknown>;
  readonly createdAtWallMs: WallMs;
}
