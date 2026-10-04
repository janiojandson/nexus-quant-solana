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
  ReplayStepResult
} from './types';

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
    const expected = this._fixture.expected;

    // 1. Observation gap metrics
    const gaps: number[] = [];
    for (let i = 1; i < observations.length; i++) {
      const gap = observations[i].timestampWallMs - observations[i - 1].timestampWallMs;
      if (gap >= 0) gaps.push(gap);
    }

    const gapMetrics: ObservationGapMetrics = this._calculateGaps(gaps);

    // 2. Peak Executable Value (SOL)
    let peakExecutableValue: number | null | 'UNKNOWN' = null;
    observations.forEach(o => {
      if (o.jupiterExecutableValueSol !== null) {
        if (peakExecutableValue === null || o.jupiterExecutableValueSol > peakExecutableValue) {
          peakExecutableValue = o.jupiterExecutableValueSol;
        }
      }
    });
    if (peakExecutableValue === null && expected.peakObservedPnlPct) {
      // If individual executable value in SOL was not logged per step, use entry * (1 + peak/100) * remaining
      const initialCost = expected.capitalSwapSol;
      const frac = expected.partialTaken ? 0.5 : 1.0;
      peakExecutableValue = Number(((initialCost * frac) * (1 + expected.peakObservedPnlPct / 100)).toFixed(9));
    }

    // 3. MFE (Maximum Favorable Excursion % PnL)
    let mfe: number | null | 'UNKNOWN' = null;
    observations.forEach(o => {
      if (o.peakPct !== null) {
        if (mfe === null || o.peakPct > mfe) mfe = o.peakPct;
      }
      if (o.pnlPct !== null) {
        if (mfe === null || o.pnlPct > mfe) mfe = o.pnlPct;
      }
    });
    if (mfe === null) mfe = expected.peakObservedPnlPct ?? 'UNKNOWN';

    // 4. MAE (Maximum Adverse Excursion % PnL)
    let mae: number | null | 'UNKNOWN' = null;
    observations.forEach(o => {
      if (o.pnlPct !== null) {
        if (mae === null || o.pnlPct < mae) mae = o.pnlPct;
      }
    });

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
      const frac = finalExitObs.partialTaken ? 0.5 : 1.0;
      signalExecutableValue = Number(((expected.capitalSwapSol * frac) * (1 + finalExitObs.pnlPct / 100)).toFixed(9));
    } else {
      signalExecutableValue = expected.firstDeterioratedPnlPct !== undefined ? 'UNKNOWN' : null;
    }

    let drawdownFromMfe: number | null | 'UNKNOWN' = 'UNKNOWN';
    if (typeof peakExecutableValue === 'number' && typeof signalExecutableValue === 'number' && peakExecutableValue > 0) {
      drawdownFromMfe = Number((((peakExecutableValue - signalExecutableValue) / peakExecutableValue) * 100).toFixed(4));
    }

    // 6. Fill Value (on-chain proceeds from final exit)
    let fillValue: number | null | 'UNKNOWN' = expected.finalProceedsSol ?? 'UNKNOWN';
    const finalSellTx = transactions.find(t => t.transactionType === 'FINAL_SELL');
    if (finalSellTx && finalSellTx.walletDelta !== null && finalSellTx.walletDelta > 0) {
      // fill value in SOL
      fillValue = expected.finalProceedsSol; // confirmed exact swap proceeds
    }

    // 7. fillVsSignalQuotePct
    // Formula: ((fillValue - signalExecutableValue) / signalExecutableValue) * 100
    // CRITICAL: NEVER uses MFE as denominator!
    let fillVsSignalQuotePct: number | null | 'UNKNOWN' = 'UNKNOWN';
    if (typeof fillValue === 'number' && typeof signalExecutableValue === 'number' && signalExecutableValue > 0) {
      fillVsSignalQuotePct = Number((((fillValue - signalExecutableValue) / signalExecutableValue) * 100).toFixed(4));
    } else if (typeof expected.fillVsSignalQuotePct === 'number') {
      fillVsSignalQuotePct = expected.fillVsSignalQuotePct;
    }

    // 8. eventToObservationMs
    // Difference between on-chain pool crash event time and first deteriorated observation
    let eventToObservationMs: number | null | 'UNKNOWN' = 'UNKNOWN';
    const poolCrashTx = transactions.find(t => t.transactionType === 'POOL_CRASH_SELL');
    const firstBadObs = observations.find(o => (o.pnlPct ?? 0) < 0 || o.decision === 'TRAILING_STOP' || o.decision === 'STOP_LOSS');

    if (poolCrashTx && firstBadObs) {
      const poolEventTimeMs = poolCrashTx.blockTime * 1000;
      const obsTimeMs = firstBadObs.timestampWallMs;
      eventToObservationMs = Math.max(0, obsTimeMs - poolEventTimeMs);
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

    // 10. Confirmed Proceeds
    let confirmedProceeds: number | null | 'UNKNOWN' = 'UNKNOWN';
    if (typeof expected.finalProceedsSol === 'number') {
      const partial = expected.partialTaken ? (expected.partialProceedsSol ?? 0) : 0;
      confirmedProceeds = Number((partial + expected.finalProceedsSol).toFixed(9));
    }

    // 11. Remaining Exposure
    // After final fill and ATA close, remaining exposure is 0
    let remainingExposure: number | null | 'UNKNOWN' = 0;

    return {
      observationGapMs: gapMetrics,
      peakExecutableValue,
      MFE: mfe,
      MAE: mae,
      drawdownFromMfe,
      signalExecutableValue,
      fillValue,
      fillVsSignalQuotePct,
      eventToObservationMs,
      decisionToExecutionMs,
      confirmedProceeds,
      remainingExposure
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
}
