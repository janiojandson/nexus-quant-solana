export interface NormalizedObservation {
  timestampWallMs: number;
  monotonicOffsetMs: number | null;
  slot: number | null;
  source: string;
  mint: string;
  poolId: string | null;
  tokenAmountAtomic: string | null;
  jupiterExecutableValueSol: number | null;
  observablePrice: number | null;
  reserveBase: number | null;
  reserveQuote: number | null;
  liquiditySol: number | null;
  positionVersion: number | null;
  partialTaken: boolean;
  pnlPct: number | null;
  peakPct: number | null;
  decision: string;
  reason: string | null;
}

export interface IncidentTransaction {
  signature: string;
  slot: number;
  blockTime: number;
  time: string;
  programId: string | null;
  instructionIndex: number | null;
  innerInstructionIndex: number | null;
  walletDelta: number | null;
  tokenDelta: number | null;
  reserveBefore: number | null;
  reserveAfter: number | null;
  transactionType: string;
  evidenceSource: string;
}

export interface SourceFileMetadata {
  file: string;
  bytes: number;
  sha256: string;
  recordCount: number;
}

export interface IncidentManifest {
  incidentId: string;
  tokenSymbol: string;
  mint: string;
  poolId: string | null;
  sourceFiles: SourceFileMetadata[];
  sourceSha256: string;
  sourceRecordCount: number;
  normalizedRecordCount: number;
  auditVersion: string;
  firstTimestamp: string;
  lastTimestamp: string;
  knownDeploymentSha: string;
  dataCompleteness: string;
  knownLimitations: string[];
}

export interface AtomicExecutionConstraints {
  allowsPreCrashFill: boolean;
  atomicSwapConfirmedBeforeExit: boolean;
  detectionAdvantageMeasurable: boolean;
  retroactiveExecutionAllowed: boolean;
}

export interface IncidentExpected {
  incidentId: string;
  taxonomy: string[];
  priceGapStatus?: 'CONFIRMED' | 'NOT_APPLICABLE' | 'UNKNOWN';
  detectionFailureStatus?: 'NOT_DEMONSTRATED' | 'DEMONSTRATED' | 'UNKNOWN';
  currentPathMissedAvailableData?: boolean;
  alternativeSensorCouldObserveEarlier?: 'UNKNOWN' | 'NOT_DEMONSTRATED' | 'CONFIRMED';
  atomicExecutionConstraints?: AtomicExecutionConstraints;
  capitalSwapSol: number;
  partialTaken: boolean;
  partialProceedsSol: number;
  finalProceedsSol: number;
  netLiquidSol: number;
  netReturnPct: number;
  boughtTokensAtomic: number;
  partialTokensAtomic?: number;
  finalTokensAtomic: number;
  peakObservedPnlPct: number;
  lastGoodObservationPnlPct?: number;
  firstDeterioratedPnlPct: number;
  poolDropReservePreSol?: number;
  poolDropReservePostSol?: number;
  poolDropPct?: number;
  poolCrashTxSignature?: string;
  finalExitTxSignature: string;
  fillVsSignalQuotePct: number;
  firstBadObservationAlreadyDeteriorated?: boolean;
  partialOccurredBeforeCrash?: boolean;
  finalFillConfirmed?: boolean;
  isPreQuoteCollapse?: boolean;
  isExecutionSlippage?: boolean;
  firstObservationAlreadyNegative?: boolean;
  firstObservationPnlPct?: number;
  simulationsRejectedCustomCode?: number;
  simulationRejectedCount?: number;
  simulationProgramIdProven?: boolean;
  simulationClassification?: string;
  confirmationTimeoutOccurred?: boolean;
  databaseRecordedExitSol?: number;
  databaseRecordedPnlPct?: number;
  actualOnChainProceedsSol?: number;
  actualOnChainNetPnlPct?: number;
  accountingDivergenceSol?: number;
  accountingDivergencePctPoints?: number;
}

export interface ReplayTimelineEvent {
  eventTimeMs: number;
  availableAtMs: number;
  type: 'ON_CHAIN_TRANSACTION' | 'OBSERVATION';
  payload: IncidentTransaction | NormalizedObservation;
}

export interface ObservationGapMetrics {
  median: number;
  p95: number;
  max: number;
  count: number;
  gaps: number[];
}

export interface IncidentReplayMetrics {
  observationGapMs: ObservationGapMetrics;
  peakExecutableValue: number | null | 'UNKNOWN';
  MFE: number | null | 'UNKNOWN';
  MAE: number | null | 'UNKNOWN';
  drawdownFromMfe: number | null | 'UNKNOWN';
  signalExecutableValue: number | null | 'UNKNOWN';
  fillValue: number | null | 'UNKNOWN';
  fillVsSignalQuotePct: number | null | 'UNKNOWN';
  eventToObservationMs: number | null | 'UNKNOWN';
  approxEventToObservationMs: number | null | 'UNKNOWN';
  eventToObservationLowerBoundMs: number | null | 'UNKNOWN';
  eventToObservationUpperBoundMs: number | null | 'UNKNOWN';
  eventTimeResolutionMs: number;
  eventTimeSource: 'SOLANA_BLOCK_TIME' | 'UNKNOWN';
  latencyPrecision: 'COARSE' | 'FINE' | 'UNKNOWN';
  decisionToExecutionMs: number | null | 'UNKNOWN';
  confirmedProceeds: number | null | 'UNKNOWN';
  remainingExposure: number | null | 'UNKNOWN';
}

export interface IncidentFixtureLock {
  manifestSha256: string;
  observationsSha256: string;
  transactionsSha256: string;
  expectedSha256: string;
}

export interface FixturesLockFile {
  version: string;
  fixtures: Record<string, IncidentFixtureLock>;
}

export interface ReplayStepResult {
  stepIndex: number;
  currentTimestampMs: number;
  currentObservation: NormalizedObservation;
  visibleObservationsCount: number;
  remainingObservationsCount: number;
}
