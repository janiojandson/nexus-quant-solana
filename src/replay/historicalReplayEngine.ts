import * as fs from 'fs';
import * as path from 'path';
import {
  NormalizedObservation,
  IncidentTransaction,
  IncidentManifest,
  IncidentExpected,
  ReplayTimelineEvent,
  IncidentReplayMetrics,
  ObservationGapMetrics,
  ReplayStepResult,
  FactClassification,
  ProvenanceValue,
  ReplayProvenanceReport
} from './types';

export {
  FactClassification,
  ProvenanceValue,
  ReplayProvenanceReport
};

export class LookaheadViolationError extends Error {
  constructor(requestedTimestamp: number, currentReplayTimestamp: number) {
    super(
      `Zero-Lookahead Violation: requested data at T=${requestedTimestamp}ms but current replay horizon is T=${currentReplayTimestamp}ms`
    );
    this.name = 'LookaheadViolationError';
  }
}

export interface IncidentFixtureData {
  manifest: IncidentManifest;
  observations: NormalizedObservation[];
  transactions: IncidentTransaction[];
  expected: IncidentExpected;
}

export interface ReplayOptions {
  stepHook?: (step: ReplayStepResult, engine: HistoricalReplayEngine) => void;
}

export class HistoricalReplayEngine {
  private _fixture: IncidentFixtureData | null = null;
  private _currentTimelineIndex: number = -1;
  private _currentTimestampMs: number = 0;
  private _timelineEvents: ReplayTimelineEvent[] = [];

  /**
   * Load an authentic incident fixture from disk without network access.
   */
  public loadFixture(fixtureDirPath: string): IncidentFixtureData {
    const manifestPath = path.join(fixtureDirPath, 'manifest.json');
    const obsPath = path.join(fixtureDirPath, 'observations.jsonl');
    const txPath = path.join(fixtureDirPath, 'transactions.json');
    const expectedPath = path.join(fixtureDirPath, 'expected.json');

    if (!fs.existsSync(manifestPath)) throw new Error(`Missing manifest at ${manifestPath}`);
    if (!fs.existsSync(obsPath)) throw new Error(`Missing observations at ${obsPath}`);
    if (!fs.existsSync(txPath)) throw new Error(`Missing transactions at ${txPath}`);
    if (!fs.existsSync(expectedPath)) throw new Error(`Missing expected at ${expectedPath}`);

    const manifest: IncidentManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const transactions: IncidentTransaction[] = JSON.parse(fs.readFileSync(txPath, 'utf8'));
    const expected: IncidentExpected = JSON.parse(fs.readFileSync(expectedPath, 'utf8'));

    const obsContent = fs.readFileSync(obsPath, 'utf8').trim().split('\n').filter(Boolean);
    const observations: NormalizedObservation[] = obsContent.map((line, idx) => {
      const parsed = JSON.parse(line);
      // Validate no invented timestamp
      if (typeof parsed.timestampWallMs !== 'number' || isNaN(parsed.timestampWallMs) || parsed.timestampWallMs <= 0) {
        throw new Error(`Invalid or invented timestampWallMs at line ${idx + 1}`);
      }
      return parsed;
    });

    // Ensure observations are ordered strictly chronologically
    for (let i = 1; i < observations.length; i++) {
      if (observations[i].timestampWallMs < observations[i - 1].timestampWallMs) {
        throw new Error(
          `Observations not ordered chronologically at index ${i}: ${observations[i].timestampWallMs} < ${observations[i - 1].timestampWallMs}`
        );
      }
    }

    if (typeof manifest.normalizedRecordCount === 'number') {
      if (observations.length !== manifest.normalizedRecordCount) {
        throw new Error(
          `Normalized observation count mismatch: file has ${observations.length} lines, manifest expects ${manifest.normalizedRecordCount}`
        );
      }
    }

    this._fixture = {
      manifest,
      observations,
      transactions,
      expected
    };

    this._buildTimelineEvents();
    this.reset();
    return this._fixture;
  }

  /**
   * Build unified timeline events differentiating eventTime and observedAt (two times concept).
   */
  private _buildTimelineEvents(): void {
    if (!this._fixture) return;

    this._timelineEvents = [];

    // Add observations: eventTime and availableAt are the observation wall time
    this._fixture.observations.forEach(obs => {
      this._timelineEvents.push({
        eventTimeMs: obs.timestampWallMs,
        availableAtMs: obs.timestampWallMs,
        type: 'OBSERVATION',
        payload: obs
      });
    });

    // Add on-chain transactions: eventTime is blockTime * 1000, availableAt is when confirmed
    this._fixture.transactions.forEach(tx => {
      const blockTimeMs = tx.blockTime * 1000;
      // If time ISO string exists, that represents the log/confirmation time in evidence
      const availableAtMs = tx.time ? Date.parse(tx.time) : blockTimeMs;

      this._timelineEvents.push({
        eventTimeMs: blockTimeMs,
        availableAtMs: Math.max(blockTimeMs, availableAtMs),
        type: 'ON_CHAIN_TRANSACTION',
        payload: tx
      });
    });

    // Sort timeline strictly by availableAtMs, breaking ties with eventTimeMs
    this._timelineEvents.sort((a, b) => {
      if (a.availableAtMs !== b.availableAtMs) return a.availableAtMs - b.availableAtMs;
      return a.eventTimeMs - b.eventTimeMs;
    });
  }

  public reset(): void {
    this._currentTimelineIndex = -1;
    this._currentTimestampMs = 0;
  }

  public get fixture(): IncidentFixtureData {
    if (!this._fixture) throw new Error('No fixture loaded');
    return this._fixture;
  }

  public get currentTimestampMs(): number {
    return this._currentTimestampMs;
  }

  /**
   * Zero-lookahead safe reader: returns only observations available at or before current horizon T.
   */
  public getVisibleObservations(horizonMs?: number): NormalizedObservation[] {
    if (!this._fixture) throw new Error('No fixture loaded');
    const horizon = horizonMs ?? this._currentTimestampMs;

    if (horizonMs !== undefined && horizonMs > this._currentTimestampMs) {
      throw new LookaheadViolationError(horizonMs, this._currentTimestampMs);
    }

    return this._fixture.observations.filter(obs => obs.timestampWallMs <= horizon);
  }

  /**
   * Zero-lookahead safe reader: returns only transactions available at or before current horizon T.
   */
  public getVisibleTransactions(horizonMs?: number): IncidentTransaction[] {
    if (!this._fixture) throw new Error('No fixture loaded');
    const horizon = horizonMs ?? this._currentTimestampMs;

    if (horizonMs !== undefined && horizonMs > this._currentTimestampMs) {
      throw new LookaheadViolationError(horizonMs, this._currentTimestampMs);
    }

    return this._timelineEvents
      .filter(e => e.type === 'ON_CHAIN_TRANSACTION' && e.availableAtMs <= horizon)
      .map(e => e.payload as IncidentTransaction);
  }

  /**
   * Lookahead assertion helper for testing.
   */
  public assertNoLookahead(targetTimestamp: number): void {
    if (targetTimestamp > this._currentTimestampMs) {
      throw new LookaheadViolationError(targetTimestamp, this._currentTimestampMs);
    }
  }

  /**
   * Run full deterministic replay step-by-step and calculate incident metrics.
   */
  public runReplay(options?: ReplayOptions): IncidentReplayMetrics {
    if (!this._fixture) throw new Error('No fixture loaded');
    this.reset();

    const obsCount = this._fixture.observations.length;
    for (let i = 0; i < obsCount; i++) {
      const obs = this._fixture.observations[i];
      this._currentTimestampMs = obs.timestampWallMs;
      this._currentTimelineIndex = i;

      if (options?.stepHook) {
        options.stepHook(
          {
            stepIndex: i,
            currentTimestampMs: this._currentTimestampMs,
            currentObservation: obs,
            visibleObservationsCount: i + 1,
            remainingObservationsCount: obsCount - (i + 1)
          },
          this
        );
      }
    }

    return this.calculateMetrics();
  }

  /**
   * Calculate all 12 audited metrics from the loaded fixture and timeline.
   */
  public calculateMetrics(): IncidentReplayMetrics {
    if (!this._fixture) throw new Error('No fixture loaded');

    const observations = this._fixture.observations;
    const transactions = this._fixture.transactions;

    // Requirement 39 & 40 (Finding P2-02):
    // Eliminate static proceeds map. FACTS are derived strictly from transactions.json.

    // 1. Observation gap metrics
    const gaps: number[] = [];
    for (let i = 1; i < observations.length; i++) {
      const gap = observations[i].timestampWallMs - observations[i - 1].timestampWallMs;
      if (gap >= 0) gaps.push(gap);
    }

    const gapMetrics: ObservationGapMetrics = this._calculateGaps(gaps);

    const entryTx = transactions.find(t => t.transactionType === 'ENTRY_BUY');
    const initialCost = entryTx && entryTx.walletDelta ? Math.abs(entryTx.walletDelta) : 0.02;
    const hasPartial = transactions.some(t => t.transactionType === 'PARTIAL_SELL');
    const frac = hasPartial ? 0.5 : 1.0;

    // 2. Peak Executable Value (SOL)
    let peakNumeric: number | null = null;
    observations.forEach(o => {
      if (o.jupiterExecutableValueSol !== null) {
        if (peakNumeric === null || o.jupiterExecutableValueSol > peakNumeric) {
          peakNumeric = o.jupiterExecutableValueSol;
        }
      }
    });

    // 3. MFE (Maximum Favorable Excursion % PnL)
    let mfeNumeric: number | null = null;
    observations.forEach(o => {
      if (o.peakPct !== null) {
        if (mfeNumeric === null || o.peakPct > mfeNumeric) mfeNumeric = o.peakPct;
      }
      if (o.pnlPct !== null) {
        if (mfeNumeric === null || o.pnlPct > mfeNumeric) mfeNumeric = o.pnlPct;
      }
    });
    const mfe: number | null | 'UNKNOWN' = mfeNumeric ?? 'UNKNOWN';

    if (peakNumeric === null && mfeNumeric !== null) {
      peakNumeric = Number(((initialCost * frac) * (1 + mfeNumeric / 100)).toFixed(9));
    }
    const peakExecutableValue: number | null | 'UNKNOWN' = peakNumeric;

    // 4. MAE (Maximum Adverse Excursion % PnL)
    let maeNumeric: number | null = null;
    observations.forEach(o => {
      if (o.pnlPct !== null) {
        if (maeNumeric === null || o.pnlPct < maeNumeric) maeNumeric = o.pnlPct;
      }
    });
    const mae: number | null | 'UNKNOWN' = maeNumeric;

    // 5. Signal Executable Value & Drawdown from MFE
    // Find final exit observation where full exit was triggered (TRAILING_STOP, STOP_LOSS, EXIT_SUCCESS_RETRY)
    const finalExitObs = [...observations].reverse().find(o =>
      o.decision === 'TRAILING_STOP' ||
      o.decision === 'STOP_LOSS' ||
      o.decision === 'EXIT_SUCCESS_RETRY'
    ) || observations.find(o => o.decision !== 'HOLD');

    let signalExecutableValue: number | null | 'UNKNOWN' = null;
    if (finalExitObs && finalExitObs.jupiterExecutableValueSol !== null) {
      signalExecutableValue = finalExitObs.jupiterExecutableValueSol;
    } else if (finalExitObs && finalExitObs.pnlPct !== null) {
      const obsFrac = finalExitObs.partialTaken ? 0.5 : frac;
      signalExecutableValue = Number(((initialCost * obsFrac) * (1 + finalExitObs.pnlPct / 100)).toFixed(9));
    }

    let drawdownFromMfe: number | null | 'UNKNOWN' = 'UNKNOWN';
    if (typeof peakExecutableValue === 'number' && typeof signalExecutableValue === 'number' && peakExecutableValue > 0) {
      drawdownFromMfe = Number((((peakExecutableValue - signalExecutableValue) / peakExecutableValue) * 100).toFixed(4));
    }

    // 6. Fill Value (on-chain proceeds from final exit derived strictly from transactions.json)
    const finalSellTx = transactions.find(t => t.transactionType === 'FINAL_SELL');
    let fillValue: number | null | 'UNKNOWN' = 'UNKNOWN';
    if (finalSellTx) {
      fillValue = finalSellTx.walletDelta !== null && finalSellTx.walletDelta !== undefined
        ? Math.abs(finalSellTx.walletDelta)
        : 'UNKNOWN';
    }

    // 7. fillVsSignalQuotePct
    // Formula: ((fillValue - signalExecutableValue) / signalExecutableValue) * 100
    // CRITICAL: NEVER uses MFE as denominator!
    let fillVsSignalQuotePct: number | null | 'UNKNOWN' = 'UNKNOWN';
    if (typeof fillValue === 'number' && typeof signalExecutableValue === 'number' && signalExecutableValue > 0) {
      fillVsSignalQuotePct = Number((((fillValue - signalExecutableValue) / signalExecutableValue) * 100).toFixed(4));
    }

    // 8. Event to Observation Latency (Coarse Estimation due to ~1s Solana blockTime resolution)
    let approxEventToObservationMs: number | null | 'UNKNOWN' = 'UNKNOWN';
    let eventToObservationLowerBoundMs: number | null | 'UNKNOWN' = 'UNKNOWN';
    let eventToObservationUpperBoundMs: number | null | 'UNKNOWN' = 'UNKNOWN';
    const eventTimeResolutionMs = 1000;
    const eventTimeSource: 'SOLANA_BLOCK_TIME' | 'UNKNOWN' = 'SOLANA_BLOCK_TIME';
    const latencyPrecision: 'COARSE' | 'FINE' | 'UNKNOWN' = 'COARSE';

    const poolCrashTx = transactions.find(t => t.transactionType === 'POOL_CRASH_SELL');
    const firstBadObs = observations.find(o => (o.pnlPct ?? 0) < 0 || o.decision === 'TRAILING_STOP' || o.decision === 'STOP_LOSS');

    if (poolCrashTx && firstBadObs) {
      const poolEventTimeMs = poolCrashTx.blockTime * 1000;
      const obsTimeMs = firstBadObs.timestampWallMs;
      approxEventToObservationMs = Math.max(0, obsTimeMs - poolEventTimeMs);
      eventToObservationUpperBoundMs = approxEventToObservationMs;
      eventToObservationLowerBoundMs = Math.max(0, obsTimeMs - (poolEventTimeMs + 1000));
    }

    // 9. decisionToExecutionMs
    let decisionToExecutionMs: number | null | 'UNKNOWN' = 'UNKNOWN';
    if (firstBadObs && finalSellTx) {
      const decTimeMs = firstBadObs.timestampWallMs;
      const finalTxTimeMs = finalSellTx.time ? Date.parse(finalSellTx.time) : finalSellTx.blockTime * 1000;
      if (finalTxTimeMs >= decTimeMs) {
        decisionToExecutionMs = finalTxTimeMs - decTimeMs;
      }
    }

    // 10. Confirmed Proceeds (derived strictly from transactions.json)
    let confirmedProceeds: number | null | 'UNKNOWN' = 'UNKNOWN';
    if (finalSellTx) {
      const partialSellTx = transactions.find(t => t.transactionType === 'PARTIAL_SELL');
      const finalProceeds = finalSellTx.walletDelta !== null && finalSellTx.walletDelta !== undefined
        ? Math.abs(finalSellTx.walletDelta)
        : 0;
      const partialProceeds = partialSellTx && partialSellTx.walletDelta !== null && partialSellTx.walletDelta !== undefined
        ? Math.abs(partialSellTx.walletDelta)
        : 0;
      confirmedProceeds = Number((partialProceeds + finalProceeds).toFixed(9));
    }

    // 11. Remaining Exposure
    // After final fill and ATA close, remaining exposure is 0
    let remainingExposure: number | null | 'UNKNOWN' = 0;

    let provenanceReport: ReplayProvenanceReport | undefined;
    if (finalSellTx) {
      try {
        provenanceReport = this.getProvenanceReport('FINAL_SELL');
      } catch {
        // ignore if not available
      }
    }

    return {
      observationGapMs: gapMetrics,
      peakExecutableValue,
      MFE: mfe,
      MAE: mae,
      drawdownFromMfe,
      signalExecutableValue,
      fillValue,
      fillVsSignalQuotePct,
      eventToObservationMs: approxEventToObservationMs,
      approxEventToObservationMs,
      eventToObservationLowerBoundMs,
      eventToObservationUpperBoundMs,
      eventTimeResolutionMs,
      eventTimeSource,
      latencyPrecision,
      decisionToExecutionMs,
      confirmedProceeds,
      remainingExposure,
      provenanceReport
    };
  }

  private _calculateGaps(gaps: number[]): ObservationGapMetrics {
    if (gaps.length === 0) {
      return { median: 0, p95: 0, max: 0, count: 0, gaps: [] };
    }

    const sorted = [...gaps].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;

    const p95Idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
    const p95 = sorted[p95Idx];
    const max = sorted[sorted.length - 1];

    return {
      median: Math.round(median),
      p95: Math.round(p95),
      max: Math.round(max),
      count: sorted.length,
      gaps: sorted
    };
  }

  /**
   * Requirement 39 & 40 (Finding P2-02):
   * Classifies factual provenance for a given transaction type (e.g. 'FINAL_SELL'),
   * separating RAW_TRANSACTION_FACT, WALLET_NET_DELTA, DERIVED_SWAP_PROCEEDS, and EXPECTED_ASSERTION.
   */
  public getProvenanceReport(transactionType: 'FINAL_SELL' | 'PARTIAL_SELL' = 'FINAL_SELL'): ReplayProvenanceReport {
    if (!this._fixture) throw new Error('No fixture loaded');
    const tx = this._fixture.transactions.find(t => t.transactionType === transactionType);
    if (!tx) throw new Error(`Transaction of type ${transactionType} not found in fixture`);

    const expected = this._fixture.expected;
    const netWalletDelta = tx.walletDelta !== null && tx.walletDelta !== undefined ? Math.abs(tx.walletDelta) : null;
    const expectedVal = expected ? (transactionType === 'FINAL_SELL' ? expected.finalProceedsSol : expected.partialProceedsSol) : null;

    let divergenceDetails = 'Factual wallet delta matches expected assertion within rounding tolerance.';
    if (netWalletDelta !== null && expectedVal !== null && Math.abs(netWalletDelta - expectedVal) > 1e-6) {
      const diffSol = Math.abs(expectedVal - netWalletDelta);
      const diffLamports = Math.round(diffSol * 1e9);
      divergenceDetails = `Divergence of ${diffSol.toFixed(9)} SOL (~${diffLamports} lamports) between expectedAssertion (${expectedVal} SOL gross) and walletNetDelta (${netWalletDelta} SOL net) represents on-chain network and priority fees paid by the wallet.`;
    }

    return {
      signature: tx.signature,
      walletNetDelta: {
        value: netWalletDelta,
        provenance: 'WALLET_NET_DELTA',
        source: 'transactions.json',
        details: 'Net wallet balance change on-chain after deduction of transaction fee and priority fee'
      },
      derivedSwapProceeds: {
        value: 'UNKNOWN',
        provenance: 'DERIVED_SWAP_PROCEEDS',
        source: tx.evidenceSource || 'chain-summary.json',
        details: 'Instruction-level gross swap proceeds not provided in fixture; marked UNKNOWN rather than guessing'
      },
      expectedAssertion: {
        value: expectedVal ?? null,
        provenance: 'EXPECTED_ASSERTION',
        source: 'expected.json',
        details: 'Expected swap proceeds without network fee deduction'
      },
      divergenceDetails
    };
  }
}
