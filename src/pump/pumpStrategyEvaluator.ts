import type { PumpStrategyCohort } from './pumpCohorts.js';
import type { PumpShadowVenue } from './pumpShadowTrade.js';

export type PumpStrategyState =
  | 'INSUFFICIENT_DATA'
  | 'NEGATIVE_EXPECTANCY'
  | 'PROMISING_SHADOW'
  | 'EXECUTION_CANDIDATE';

export interface PumpStrategySample {
  cohort: PumpStrategyCohort;
  venue: PumpShadowVenue;
  executableEntry: boolean;
  executableExit: boolean;
  netReturnPct?: number;
  entryLatencyMs?: number;
  maxDrawdownPct?: number;
}

export interface PumpStrategyEvaluation {
  state: PumpStrategyState;
  sampleCount: number;
  executableEntryRate: number;
  executableExitRate: number;
  meanNetReturnPct?: number;
  winRate?: number;
  medianEntryLatencyMs?: number;
  meanMaxDrawdownPct?: number;
}

export interface PumpStrategyEvaluatorOptions {
  minSamples?: number;
  candidateMinSamples?: number;
  minExecutableExitRate?: number;
  candidateMinWinRate?: number;
}

function mean(values: number[]): number | undefined {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : undefined;
}

function median(values: number[]): number | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function evaluatePumpStrategy(
  samples: PumpStrategySample[],
  options: PumpStrategyEvaluatorOptions = {}
): PumpStrategyEvaluation {
  const minSamples = Math.max(1, Math.floor(options.minSamples ?? 30));
  const candidateMinSamples = Math.max(minSamples, Math.floor(options.candidateMinSamples ?? 100));
  const minExecutableExitRate = options.minExecutableExitRate ?? 0.90;
  const candidateMinWinRate = options.candidateMinWinRate ?? 0.55;
  const sampleCount = samples.length;

  const executableEntryRate = sampleCount
    ? samples.filter(sample => sample.executableEntry).length / sampleCount
    : 0;
  const executableExitRate = sampleCount
    ? samples.filter(sample => sample.executableExit).length / sampleCount
    : 0;
  const validReturns = samples
    .filter(sample => sample.executableExit && Number.isFinite(sample.netReturnPct))
    .map(sample => Number(sample.netReturnPct));
  const latencies = samples
    .map(sample => Number(sample.entryLatencyMs))
    .filter(Number.isFinite);
  const drawdowns = samples
    .map(sample => Number(sample.maxDrawdownPct))
    .filter(Number.isFinite);
  const meanNetReturnPct = mean(validReturns);
  const winRate = validReturns.length
    ? validReturns.filter(value => value > 0).length / validReturns.length
    : undefined;

  let state: PumpStrategyState;
  if (sampleCount < minSamples) {
    state = 'INSUFFICIENT_DATA';
  } else if (
    executableExitRate < minExecutableExitRate ||
    meanNetReturnPct == null ||
    meanNetReturnPct <= 0
  ) {
    state = 'NEGATIVE_EXPECTANCY';
  } else if (
    sampleCount >= candidateMinSamples &&
    (winRate ?? 0) >= candidateMinWinRate
  ) {
    state = 'EXECUTION_CANDIDATE';
  } else {
    state = 'PROMISING_SHADOW';
  }

  return {
    state,
    sampleCount,
    executableEntryRate,
    executableExitRate,
    meanNetReturnPct,
    winRate,
    medianEntryLatencyMs: median(latencies),
    meanMaxDrawdownPct: mean(drawdowns)
  };
}
