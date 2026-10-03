import type { SwapQuoteParams, SwapQuoteResult } from '../blockchain/dexAggregator.js';
import type { PumpObservatorySnapshot } from './pumpObservatory.js';
import { PumpJupiterTimingTracker } from './pumpJupiterTiming.js';
import { classifyPumpCohort, type PumpStrategyCohort } from './pumpCohorts.js';
import {
  createShadowTrade,
  recordShadowExitMark,
  type PumpShadowTrade,
  type PumpShadowVenue
} from './pumpShadowTrade.js';
import { evaluatePumpStrategy, type PumpStrategySample } from './pumpStrategyEvaluator.js';

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
    venue: string;
    state: string;
    sampleCount: number;
    meanNetReturnPct?: number;
    executableExitRate: number;
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
  eventTimestampMs: number;
  tokenAmountAtomic: number;
  trade: PumpShadowTrade;
  markedHorizons: Set<string>;
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
    await this.persistNewObservations(observations);

    const due = [...this.shadows.entries()].find(([, state]) =>
      this.horizons.some(h => !state.markedHorizons.has(h.label) && now - state.trade.entryAtMs >= h.ms)
    );
    if (due) {
      const [mint, state] = due;
      const horizon = this.horizons.find(h =>
        !state.markedHorizons.has(h.label) && now - state.trade.entryAtMs >= h.ms
      )!;
      await this.sampleExit(mint, state, horizon, now);
      await this.refreshSummary();
      return;
    }

    const candidate = observations.find(observation => {
      if (this.shadows.has(observation.mint)) return false;
      return classifyPumpCohort({
        ageMs: now - observation.eventTimestampMs,
        progressPct: observation.progressPct,
        graduatedAtMs: observation.complete ? Number(observation.curveUpdatedAt ? Date.parse(observation.curveUpdatedAt) : now) : undefined,
        nowMs: now
      }) != null;
    });

    if (candidate) {
      const cohort = classifyPumpCohort({
        ageMs: now - candidate.eventTimestampMs,
        progressPct: candidate.progressPct,
        graduatedAtMs: candidate.complete ? Number(candidate.curveUpdatedAt ? Date.parse(candidate.curveUpdatedAt) : now) : undefined,
        nowMs: now
      });
      if (cohort) await this.openShadow(candidate.mint, candidate.eventTimestampMs, cohort, now);
    }
    await this.refreshSummary();
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
    cohort: PumpStrategyCohort,
    now: number
  ): Promise<void> {
    const timing = await this.timing.probe({
      mint,
      eventTimestampMs,
      inputMint: WSOL_MINT,
      outputMint: mint,
      amountLamports: this.entryLamports
    });
    if (!timing.routeAvailable || !timing.outAmount || timing.outAmount <= 0) return;

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
    this.shadows.set(mint, {
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
        firstRouteLagMs: timing.firstRouteLagMs,
        router: timing.router,
        tokenAmountAtomic: timing.outAmount
      }
    });
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

    await this.store?.appendMarketSample({
      mint,
      sampledAtMs: now,
      cohort: state.trade.cohort,
      venue: state.trade.venue,
      payload: { mark, error }
    });
  }

  private async refreshSummary(): Promise<void> {
    const grouped = new Map<string, { cohort: PumpStrategyCohort; venue: PumpShadowVenue; samples: PumpStrategySample[] }>();
    let totalSamples = 0;

    for (const state of this.shadows.values()) {
      const latest = state.trade.exitMarks.at(-1);
      if (!latest) continue;
      totalSamples++;
      const key = `${state.trade.cohort}:${state.trade.venue}`;
      const group = grouped.get(key) ?? {
        cohort: state.trade.cohort,
        venue: state.trade.venue,
        samples: []
      };
      group.samples.push({
        cohort: state.trade.cohort,
        venue: state.trade.venue,
        executableEntry: true,
        executableExit: latest.executable,
        netReturnPct: latest.netReturnPct,
        entryLatencyMs: state.trade.entryAtMs - state.eventTimestampMs
      });
      grouped.set(key, group);
    }

    const strategies: PumpStrategyLabSnapshot['strategies'] = [];
    for (const group of grouped.values()) {
      const evaluation = evaluatePumpStrategy(group.samples);
      const row = {
        cohort: group.cohort,
        venue: group.venue,
        state: evaluation.state,
        sampleCount: evaluation.sampleCount,
        meanNetReturnPct: evaluation.meanNetReturnPct,
        executableExitRate: evaluation.executableExitRate
      };
      strategies.push(row);
      await this.store?.upsertStrategySummary({
        cohort: group.cohort,
        venue: group.venue,
        state: evaluation.state,
        sampleCount: evaluation.sampleCount,
        metrics: evaluation
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
