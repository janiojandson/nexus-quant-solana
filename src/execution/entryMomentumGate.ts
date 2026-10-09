export interface EntryMomentumGateConfig {
  samples: number;
  intervalMs: number;
  minRisePct: number;
  maxRisePct: number;
  maxPullbackPct: number;
  /** Maximum delay starting a nominal sample, including queue/scheduler delay. */
  maxStartLatenessMs?: number;
  /** Maximum response RTT; defaults to 400 ms, below the 500 ms cadence. */
  maxQuoteLatencyMs?: number;
}

export interface EntryMomentumSample {
  timestamp: number;
  priceUsd: number;
  latencyMs?: number;
  requestedAtMs?: number;
  completedAtMs?: number;
}

export interface EntryMomentumQuote {
  inputAmountAtomic: string;
  outputAmountAtomic: string;
  tokenDecimals: number;
  /** Local monotonic observation time at the response boundary. */
  observedAtMs: number;
}

export interface MomentumClock {
  now(): number;
  wallNow(): number;
  sleep(ms: number): Promise<void>;
}

export interface EntryMomentumResult {
  pass: boolean;
  risePct: number;
  maxPullbackPct: number;
  risingSteps: number;
  staleSource: boolean;
  reason: string;
  samples: EntryMomentumSample[];
}

export const DEFAULT_ENTRY_MOMENTUM_CONFIG: EntryMomentumGateConfig = {
  samples: 4,
  intervalMs: 500,
  minRisePct: 0.40,
  maxRisePct: 4.00,
  maxPullbackPct: 0.30,
  maxStartLatenessMs: 100,
  maxQuoteLatencyMs: 400
};

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function evaluateEntryMomentum(
  samples: EntryMomentumSample[],
  config: EntryMomentumGateConfig
): EntryMomentumResult {
  if (samples.length !== config.samples || samples.some(sample => !Number.isFinite(sample.priceUsd) || sample.priceUsd <= 0)) {
    return {
      pass: false,
      risePct: 0,
      maxPullbackPct: 0,
      risingSteps: 0,
      staleSource: false,
      reason: 'Amostras de preço insuficientes ou inválidas.',
      samples
    };
  }

  const uniquePrices = new Set(samples.map(sample => sample.priceUsd.toPrecision(15)));
  if (uniquePrices.size === 1) {
    return {
      pass: false,
      risePct: 0,
      maxPullbackPct: 0,
      risingSteps: 0,
      staleSource: true,
      reason: 'Momentum pré-voo indeterminado ou fonte estagnada (STALE_SOURCE): fonte sem atualização.',
      samples
    };
  }

  const first = samples[0].priceUsd;
  const last = samples[samples.length - 1].priceUsd;
  const risePct = ((last / first) - 1) * 100;

  let maxPullbackPct = 0;
  let risingSteps = 0;
  let peak = first;
  for (let i = 1; i < samples.length; i++) {
    const previous = samples[i - 1].priceUsd;
    const current = samples[i].priceUsd;
    if (current > previous) risingSteps++;
    peak = Math.max(peak, current);
    maxPullbackPct = Math.max(maxPullbackPct, ((peak - current) / peak) * 100);
  }

  const requiredRisingSteps = Math.ceil(2 * (samples.length - 1) / 3);
  let reason = 'Momentum de alta confirmado pela fonte de micropreço.';
  let pass = true;

  if (!Number.isFinite(config.minRisePct) || risePct <= 0 || risePct < config.minRisePct) {
    pass = false;
    reason = `Alta insuficiente: ${risePct.toFixed(3)}% < ${config.minRisePct}%.`;
  } else if (risePct > config.maxRisePct) {
    pass = false;
    reason = `Alta rápida demais: ${risePct.toFixed(3)}% > ${config.maxRisePct}%.`;
  } else if (risingSteps < requiredRisingSteps) {

    pass = false;
    reason = `Sequência sem continuidade: ${risingSteps}/${samples.length - 1} passos de alta.`;
  } else if (maxPullbackPct > config.maxPullbackPct) {
    pass = false;
    reason = `Pullback excessivo durante observação: ${maxPullbackPct.toFixed(3)}%.`;
  }

  return { pass, risePct, maxPullbackPct, risingSteps, staleSource: false, reason, samples };
}

export async function observeEntryMomentum(
  getQuote: (deadlineMs: number, signal?: AbortSignal) => Promise<EntryMomentumQuote | null>,
  config: EntryMomentumGateConfig = DEFAULT_ENTRY_MOMENTUM_CONFIG,
  clock: MomentumClock = { now: () => performance.now(), wallNow: () => Date.now(), sleep },
  signal?: AbortSignal
): Promise<EntryMomentumResult> {
  const samples: EntryMomentumSample[] = [];
  const begin = clock.now();
  const startLatenessMs = config.maxStartLatenessMs ?? 100;
  const quoteLatencyMs = config.maxQuoteLatencyMs ?? 400;
  const invalid = (reason: string): EntryMomentumResult => ({
    pass: false, risePct: 0, maxPullbackPct: 0, risingSteps: 0,
    staleSource: reason === 'STALE_SOURCE', reason, samples
  });
  if (!Number.isSafeInteger(config.samples) || config.samples < 2 ||
      !Number.isFinite(config.intervalMs) || config.intervalMs <= 0 ||
      !Number.isFinite(startLatenessMs) || startLatenessMs < 0 ||
      !Number.isFinite(quoteLatencyMs) || quoteLatencyMs <= 0 ||
      startLatenessMs + quoteLatencyMs > config.intervalMs)
    return invalid('INVALID_TIMING_CONFIG');
  for (let i = 0; i < config.samples; i++) {
    if (signal?.aborted) return invalid('ABORTED');
    const target = begin + i * config.intervalMs;
    if (clock.now() < target) await clock.sleep(target - clock.now());
    const started = clock.now();
    if (signal?.aborted) return invalid('ABORTED');
    if (started > target + startLatenessMs) return invalid('LATE_SAMPLE');
    const quote = await getQuote(clock.wallNow() + quoteLatencyMs, signal);
    const ended = clock.now();
    if (signal?.aborted) return invalid('ABORTED');
    if (ended - started > quoteLatencyMs || ended > target + startLatenessMs + quoteLatencyMs)
      return invalid('LATE_SAMPLE');
    if (!quote || !/^\d+$/.test(quote.inputAmountAtomic) || !/^\d+$/.test(quote.outputAmountAtomic) ||
        !Number.isInteger(quote.tokenDecimals) || quote.tokenDecimals < 0 || quote.tokenDecimals > 18)
      return invalid('INVALID_QUOTE');
    const input = BigInt(quote.inputAmountAtomic);
    const output = BigInt(quote.outputAmountAtomic);
    if (input <= 0n || output <= 0n || input > BigInt(Number.MAX_SAFE_INTEGER) || output > BigInt(Number.MAX_SAFE_INTEGER))
      return invalid('INVALID_QUOTE');
    if (!Number.isFinite(quote.observedAtMs) || quote.observedAtMs < started || quote.observedAtMs > ended)
      return invalid('STALE_SOURCE');
    const priceSolPerToken = Number(input) / 1e9 / (Number(output) / 10 ** quote.tokenDecimals);
    if (!Number.isFinite(priceSolPerToken) || priceSolPerToken <= 0) return invalid('INVALID_QUOTE');
    samples.push({ timestamp: ended, priceUsd: priceSolPerToken, latencyMs: ended - started,
      requestedAtMs: started, completedAtMs: ended });
  }
  return evaluateEntryMomentum(samples, config);
}
