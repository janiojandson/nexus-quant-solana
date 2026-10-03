import type { SwapQuoteParams, SwapQuoteResult } from '../blockchain/dexAggregator.js';
import type { PumpObservatorySnapshot } from './pumpObservatory.js';
import { PumpJupiterTimingTracker } from './pumpJupiterTiming.js';
import type { PumpStrategyCohort } from './pumpCohorts.js';
import {
  createShadowTrade,
  recordShadowExitMark,
  type PumpShadowTrade,
  type PumpShadowVenue
} from './pumpShadowTrade.js';
import { evaluatePumpStrategy, type PumpStrategySample } from './pumpStrategyEvaluator.js';
import {
  buildExecutableReplayPath,
  dueEntryWindows,
  entryWindowToCohort,
  strategySummaryKey,
  type PumpEntryWindow
} from './pumpMultiEntryLab.js';
import {
  BASELINE_CURRENT,
  PARTIAL_HARVEST_EARLIER,
  TIERED_PROFIT_LOCK,
  replayExitPolicy,
  type ExitReplayResult
} from './exitPolicyReplay.js';

const WSOL_MINT = 'So11111111111111111111111111111111111111112';

export interface PumpStrategyLabSource {
  snapshot(): PumpObservatorySnapshot;
}

export interface PumpStrategyLabQuoteProvider {
  getQuote(params: SwapQuoteParams): Promise<SwapQuoteResult>;
}

export interface PumpStrategyLabStore {
  appendObservation(record: any): Promise<void>;
  appendMarketSample(record: any): Promise<void>;
  appendShadowTrade(record: any): Promise<void>;
  upsertStrategySummary(record: any): Promise<void>;
}

export interface PumpStrategyHorizon {
  label: string;
  ms: number;
}

export interface PumpStrategyLabSnapshot {
  mode: 'SHADOW';
  totalSamples: number;
  preferredJupiterPlan: string;
  preferredPlanNetAfterCostSol?: number;
  strategies: Array<{
    cohort: string;
    entryWindow: PumpEntryWindow;
    horizon: string;
    venue: string;
    state: string;
    sampleCount: number;
    meanNetReturnPct?: number;
    executableExitRate: number;
    exitPolicyReplays: Array<{
      policy: string;
      meanNetReturnPct: number;
      meanMaxGiveBackFromPeakPct: number;
      prematureExitRate: number;
    }>;
  }>;
}

export interface PumpStrategyLabRuntimeOptions {
  enabled?: boolean;
  intervalMs?: number;
  entryLamports?: number;
  networkFeeLamports?: number;
  priorityFeeLamports?: number;
  horizons?: PumpStrategyHorizon[];
  now?: () => number;
  canRunResearch?: () => boolean;
}

interface ShadowState {
  mint: string;
  entryWindow: PumpEntryWindow;
  eventTimestampMs: number;
  tokenAmountAtomic: number;
  trade: PumpShadowTrade;
  markedHorizons: Set<string>;
}

interface TrackedMintState {
  eventTimestampMs: number;
  progressPct?: number;
  complete: boolean;
  graduatedAtMs?: number;
  attemptedWindows: Set<PumpEntryWindow>;
}

export class PumpStrategyLabRuntime {
  private readonly enabled: boolean;
  private readonly intervalMs: number;
  private readonly entryLamports: number;
  private readonly networkFeeLamports: number;
  private readonly priorityFeeLamports: number;
  private readonly horizons: PumpStrategyHorizon[];
  private readonly now: () => number;
  private readonly canRunResearch: () => boolean;
  private readonly timing: PumpJupiterTimingTracker;
  private readonly persistedObservations = new Set<string>();
  private readonly trackedMints = new Map<string, TrackedMintState>();
  private readonly shadows = new Map<string, ShadowState>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private currentSnapshot: PumpStrategyLabSnapshot = {
    mode: 'SHADOW',
    totalSamples: 0,
    preferredJupiterPlan: 'INSUFFICIENT_DATA',
    strategies: []
  };

  constructor(
    private readonly source: PumpStrategyLabSource,
    private readonly provider: PumpStrategyLabQuoteProvider,
    private readonly store: PumpStrategyLabStore | null | undefined,
    options: PumpStrategyLabRuntimeOptions = {}
  ) {
    this.enabled = options.enabled ?? true;
    this.intervalMs = Math.max(1_000, Number(options.intervalMs ?? 5_000));
    this.entryLamports = Math.max(1, Math.floor(Number(options.entryLamports ?? 1_000_000)));
    this.networkFeeLamports = Math.max(0, Math.floor(Number(options.networkFeeLamports ?? 0)));
    this.priorityFeeLamports = Math.max(0, Math.floor(Number(options.priorityFeeLamports ?? 0)));
    this.horizons = [...(options.horizons ?? [
      { label: '15s', ms: 15_000 },
      { label: '30s', ms: 30_000 },
      { label: '1m', ms: 60_000 },
      { label: '2m', ms: 120_000 },
      { label: '5m', ms: 300_000 },
      { label: '10m', ms: 600_000 }
    ])].sort((a, b) => a.ms - b.ms);
    this.now = options.now ?? Date.now;
    this.canRunResearch = options.canRunResearch ?? (() => true);
    this.timing = new PumpJupiterTimingTracker(provider, { now: this.now });
  }

  start(): void {
    if (!this.enabled || this.timer) return;
    void this.sample();
    this.timer = setInterval(() => void this.sample(), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  snapshot(): PumpStrategyLabSnapshot {
    return {
      ...this.currentSnapshot,
      strategies: this.currentSnapshot.strategies.map(item => ({ ...item }))
    };
  }

  async sample(): Promise<void> {
    if (!this.enabled || !this.canRunResearch()) return;

    const now = this.now();
    const observations = this.source.snapshot().recent;
    this.trackObservations(observations, now);
    await this.persistNewObservations(observations);

    // Saídas shadow sempre têm prioridade sobre abrir novas amostras.
    // Isso preserva uma única chamada P6 por tick.
    const due = [...this.shadows.values()].find(state =>
      this.horizons.some(h => !state.markedHorizons.has(h.label) && now - state.trade.entryAtMs >= h.ms)
    );
    if (due) {
      const horizon = this.horizons.find(h =>
        !due.markedHorizons.has(h.label) && now - due.trade.entryAtMs >= h.ms
      )!;
      await this.sampleExit(due.mint, due, horizon, now);
      await this.refreshSummary();
      return;
    }

    for (const [mint, tracked] of this.trackedMints) {
      const windows = dueEntryWindows({
        ageMs: now - tracked.eventTimestampMs,
        progressPct: tracked.progressPct,
        complete: tracked.complete,
        sinceGraduationMs: tracked.graduatedAtMs == null ? undefined : now - tracked.graduatedAtMs,
        seen: tracked.attemptedWindows
      });
      const entryWindow = windows[0];
      if (!entryWindow) continue;

      const opened = await this.openShadow(mint, tracked.eventTimestampMs, entryWindow, now);
      if (opened) tracked.attemptedWindows.add(entryWindow);
      break;
    }

    await this.refreshSummary();
  }

  private trackObservations(
    observations: PumpObservatorySnapshot['recent'],
    now: number
  ): void {
    for (const observation of observations) {
      const existing = this.trackedMints.get(observation.mint);
      const parsedCurveUpdatedAt = observation.curveUpdatedAt
        ? Date.parse(observation.curveUpdatedAt)
        : NaN;
      const graduatedAtMs = observation.complete
        ? (existing?.graduatedAtMs
          ?? (Number.isFinite(parsedCurveUpdatedAt) ? parsedCurveUpdatedAt : now))
        : existing?.graduatedAtMs;

      this.trackedMints.set(observation.mint, {
        eventTimestampMs: existing?.eventTimestampMs ?? observation.eventTimestampMs,
        progressPct: observation.progressPct,
        complete: observation.complete,
        graduatedAtMs,
        attemptedWindows: existing?.attemptedWindows ?? new Set<PumpEntryWindow>()
      });
    }

    // Retém o ciclo suficiente para minuto 5/pós-graduação, sem crescimento ilimitado.
    const cutoff = now - 30 * 60_000;
    for (const [mint, tracked] of this.trackedMints) {
      if (tracked.eventTimestampMs < cutoff) this.trackedMints.delete(mint);
    }
  }

  private async persistNewObservations(observations: PumpObservatorySnapshot['recent']): Promise<void> {
    if (!this.store) return;
    for (const observation of observations) {
      const key = `${observation.signature}:${observation.mint}`;
      if (this.persistedObservations.has(key)) continue;
      await this.store.appendObservation({
        mint: observation.mint,
        eventTimestampMs: observation.eventTimestampMs,
        observedAtMs: observation.observedAtMs,
        slot: observation.slot,
        signature: observation.signature,
        payload: observation
      });
      this.persistedObservations.add(key);
    }
  }

  private async openShadow(
    mint: string,
    eventTimestampMs: number,
    entryWindow: PumpEntryWindow,
    now: number
  ): Promise<boolean> {
    const cohort = entryWindowToCohort(entryWindow);
    const timing = await this.timing.probe({
      mint,
      eventTimestampMs,
      inputMint: WSOL_MINT,
      outputMint: mint,
      amountLamports: this.entryLamports
    });
    if (!timing.routeAvailable || !timing.outAmount || timing.outAmount <= 0) return false;

    const trade = createShadowTrade({
      mint,
      cohort,
      venue: 'JUPITER_ROUTE',
      entryAtMs: now,
      entryPrincipalSol: this.entryLamports / 1e9,
      entryFeeBps: 0,
      entrySlippageBps: 0,
      priorityFeeLamports: this.priorityFeeLamports,
      networkFeeLamports: this.networkFeeLamports
    });
    const shadowKey = `${mint}:${entryWindow}`;
    this.shadows.set(shadowKey, {
      mint,
      entryWindow,
      eventTimestampMs,
      tokenAmountAtomic: timing.outAmount,
      trade,
      markedHorizons: new Set()
    });
    await this.store?.appendShadowTrade({
      mint,
      cohort,
      venue: trade.venue,
      entryAtMs: now,
      payload: {
        trade,
        entryWindow,
        entryAgeMs: now - eventTimestampMs,
        firstRouteLagMs: timing.firstRouteLagMs,
        router: timing.router,
        tokenAmountAtomic: timing.outAmount
      }
    });
    return true;
  }

  private async sampleExit(
    mint: string,
    state: ShadowState,
    horizon: PumpStrategyHorizon,
    now: number
  ): Promise<void> {
    let grossExitValueSol = 0;
    let executable = false;
    let error: string | undefined;
    try {
      const quote = await this.provider.getQuote({
        inputMint: mint,
        outputMint: WSOL_MINT,
        amountLamports: state.tokenAmountAtomic,
        autoSlippage: true,
        trafficPriority: 6
      });
      grossExitValueSol = Math.max(0, quote.outAmount / 1e9);
      executable = grossExitValueSol > 0;
    } catch (err: any) {
      error = err?.message || String(err);
    }

    const mark = recordShadowExitMark(state.trade, {
      horizon: horizon.label,
      observedAtMs: now,
      grossExitValueSol,
      executable,
      exitFeeBps: 0,
      exitSlippageBps: 0,
      priorityFeeLamports: this.priorityFeeLamports,
      networkFeeLamports: this.networkFeeLamports
    });
    state.markedHorizons.add(horizon.label);

    const replayPath = buildExecutableReplayPath(
      state.trade.entryPrincipalSol,
      state.trade.entryAtMs,
      state.trade.exitMarks
    );
    const exitPolicyReplays = replayPath.length > 1
      ? [BASELINE_CURRENT, TIERED_PROFIT_LOCK, PARTIAL_HARVEST_EARLIER]
          .map(policy => replayExitPolicy(replayPath, policy, { feeBps: 0, slippageBps: 0 }))
      : [];

    await this.store?.appendMarketSample({
      mint,
      sampledAtMs: now,
      cohort: state.trade.cohort,
      venue: state.trade.venue,
      payload: {
        mark,
        error,
        entryWindow: state.entryWindow,
        exitPolicyReplays
      }
    });
  }

  private async refreshSummary(): Promise<void> {
    type ReplayAggregate = {
      policy: string;
      rows: ExitReplayResult[];
    };
    type Group = {
      cohort: PumpStrategyCohort;
      entryWindow: PumpEntryWindow;
      horizon: string;
      venue: PumpShadowVenue;
      samples: PumpStrategySample[];
      replays: Map<string, ReplayAggregate>;
    };

    const grouped = new Map<string, Group>();
    let totalSamples = 0;

    for (const state of this.shadows.values()) {
      if (state.trade.exitMarks.length === 0) continue;
      totalSamples++;

      for (let markIndex = 0; markIndex < state.trade.exitMarks.length; markIndex++) {
        const mark = state.trade.exitMarks[markIndex];
        const key = `${state.entryWindow}:${mark.horizon}:${state.trade.venue}`;
        const group = grouped.get(key) ?? {
          cohort: state.trade.cohort,
          entryWindow: state.entryWindow,
          horizon: mark.horizon,
          venue: state.trade.venue,
          samples: [],
          replays: new Map<string, ReplayAggregate>()
        };

        group.samples.push({
          cohort: state.trade.cohort,
          venue: state.trade.venue,
          executableEntry: true,
          executableExit: mark.executable,
          netReturnPct: mark.netReturnPct,
          entryLatencyMs: state.trade.entryAtMs - state.eventTimestampMs
        });

        const replayPath = buildExecutableReplayPath(
          state.trade.entryPrincipalSol,
          state.trade.entryAtMs,
          state.trade.exitMarks.slice(0, markIndex + 1)
        );
        if (replayPath.length > 1) {
          for (const policy of [BASELINE_CURRENT, TIERED_PROFIT_LOCK, PARTIAL_HARVEST_EARLIER]) {
            const result = replayExitPolicy(replayPath, policy, { feeBps: 0, slippageBps: 0 });
            const aggregate = group.replays.get(policy.name) ?? { policy: policy.name, rows: [] };
            aggregate.rows.push(result);
            group.replays.set(policy.name, aggregate);
          }
        }
        grouped.set(key, group);
      }
    }

    const strategies: PumpStrategyLabSnapshot['strategies'] = [];
    for (const group of grouped.values()) {
      const evaluation = evaluatePumpStrategy(group.samples);
      const exitPolicyReplays = [...group.replays.values()].map(aggregate => {
        const count = Math.max(1, aggregate.rows.length);
        return {
          policy: aggregate.policy,
          meanNetReturnPct: aggregate.rows.reduce((sum, row) => sum + row.netReturnPct, 0) / count,
          meanMaxGiveBackFromPeakPct:
            aggregate.rows.reduce((sum, row) => sum + row.maxGiveBackFromPeakPct, 0) / count,
          prematureExitRate:
            aggregate.rows.filter(row => row.prematureExit).length / count
        };
      });
      const row = {
        cohort: group.cohort,
        entryWindow: group.entryWindow,
        horizon: group.horizon,
        venue: group.venue,
        state: evaluation.state,
        sampleCount: evaluation.sampleCount,
        meanNetReturnPct: evaluation.meanNetReturnPct,
        executableExitRate: evaluation.executableExitRate,
        exitPolicyReplays
      };
      strategies.push(row);
      await this.store?.upsertStrategySummary({
        cohort: strategySummaryKey(group.entryWindow, group.horizon),
        venue: group.venue,
        state: evaluation.state,
        sampleCount: evaluation.sampleCount,
        metrics: {
          ...evaluation,
          cohort: group.cohort,
          entryWindow: group.entryWindow,
          horizon: group.horizon,
          exitPolicyReplays
        }
      });
    }

    this.currentSnapshot = {
      mode: 'SHADOW',
      totalSamples,
      preferredJupiterPlan: 'INSUFFICIENT_DATA',
      strategies
    };
  }
}
