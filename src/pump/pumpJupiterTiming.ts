import {
  JupiterQuoteException,
  type SwapQuoteParams,
  type SwapQuoteResult
} from '../blockchain/dexAggregator.js';

export const PUMP_JUPITER_MAX_SLIPPAGE_BPS = 750;
export const PUMP_MOMENT_ZERO_WINDOW_MS = 15_000;

export interface PumpJupiterProbeInput {
  mint: string;
  eventTimestampMs: number;
  inputMint: string;
  outputMint: string;
  amountLamports: number;
  amountLadderLamports?: number[];
  probeSeriesKey?: string;
}

export interface PumpJupiterTimingSample {
  mint: string;
  attempts: number;
  rateLimitHits: number;
  routeAvailable: boolean;
  firstAttemptAtMs?: number;
  firstRouteAtMs?: number;
  firstRouteLagMs?: number;
  firstCompliantRouteLagMs?: number;
  lastLatencyMs?: number;
  router?: string;
  outAmount?: number;
  priceImpactPct?: number;
  slippageBps?: number;
  lastProbeAmountLamports?: number;
  firstRouteAmountLamports?: number;
  firstRouteLadderIndex?: number;
  firstRouteSlippageBps?: number;
  firstRoutePriceImpactPct?: number;
  lastFailureReason?: 'RATE_LIMIT' | 'SLIPPAGE_ABOVE_CAP' | 'ROUTE_UNAVAILABLE';
}

export interface PumpJupiterTimingSummary {
  mode: 'SHADOW';
  maxSlippageBps: number;
  momentZeroWindowMs: number;
  probedMints: number;
  compliantRouteMints: number;
  compliantRouteRate: number;
  momentZeroMints: number;
  momentZeroRate: number;
  medianFirstCompliantRouteLagMs?: number;
  p90FirstCompliantRouteLagMs?: number;
  smallestFirstExecutableAmountLamports?: number;
  medianFirstExecutableAmountLamports?: number;
}

export interface PumpJupiterQuoteProvider {
  getQuote(params: SwapQuoteParams): Promise<SwapQuoteResult>;
}

function normalizeLadder(input: PumpJupiterProbeInput): number[] {
  const values = [
    ...(input.amountLadderLamports ?? []),
    input.amountLamports
  ]
    .map(value => Math.max(1, Math.floor(Number(value))))
    .filter(Number.isFinite)
    .sort((a, b) => b - a);
  return [...new Set(values)];
}

function percentile(values: number[], fraction: number): number | undefined {
  if (values.length === 0) return undefined;
  const ordered = [...values].sort((a, b) => a - b);
  const index = Math.min(
    ordered.length - 1,
    Math.max(0, Math.ceil(ordered.length * fraction) - 1)
  );
  return ordered[index];
}

export function summarizePumpJupiterTiming(
  samples: PumpJupiterTimingSample[],
  momentZeroWindowMs = PUMP_MOMENT_ZERO_WINDOW_MS
): PumpJupiterTimingSummary {
  const routed = samples.filter(sample =>
    sample.firstRouteAtMs != null &&
    sample.firstCompliantRouteLagMs != null &&
    Number(sample.firstRouteSlippageBps ?? 0) <= PUMP_JUPITER_MAX_SLIPPAGE_BPS
  );
  const lags = routed
    .map(sample => Math.max(0, Number(sample.firstCompliantRouteLagMs)))
    .filter(Number.isFinite);
  const amounts = routed
    .map(sample => Number(sample.firstRouteAmountLamports))
    .filter(value => Number.isFinite(value) && value > 0);
  const momentZeroMints = lags.filter(lag => lag <= momentZeroWindowMs).length;
  const probedMints = samples.length;

  return {
    mode: 'SHADOW',
    maxSlippageBps: PUMP_JUPITER_MAX_SLIPPAGE_BPS,
    momentZeroWindowMs,
    probedMints,
    compliantRouteMints: routed.length,
    compliantRouteRate: probedMints > 0 ? routed.length / probedMints : 0,
    momentZeroMints,
    momentZeroRate: probedMints > 0 ? momentZeroMints / probedMints : 0,
    medianFirstCompliantRouteLagMs: percentile(lags, 0.50),
    p90FirstCompliantRouteLagMs: percentile(lags, 0.90),
    smallestFirstExecutableAmountLamports: amounts.length > 0 ? Math.min(...amounts) : undefined,
    medianFirstExecutableAmountLamports: percentile(amounts, 0.50)
  };
}

export class PumpJupiterTimingTracker {
  private readonly now: () => number;
  private readonly samples = new Map<string, PumpJupiterTimingSample>();
  private readonly ladderCursors = new Map<string, number>();

  constructor(
    private readonly provider: PumpJupiterQuoteProvider,
    options: { now?: () => number } = {}
  ) {
    this.now = options.now ?? Date.now;
  }

  async probe(input: PumpJupiterProbeInput): Promise<PumpJupiterTimingSample> {
    const existing = this.samples.get(input.mint) ?? {
      mint: input.mint,
      attempts: 0,
      rateLimitHits: 0,
      routeAvailable: false
    };
    const ladder = normalizeLadder(input);
    const seriesKey = input.probeSeriesKey ?? input.mint;
    const cursor = Math.min(this.ladderCursors.get(seriesKey) ?? 0, ladder.length - 1);
    const amountLamports = ladder[cursor];
    const startedAt = this.now();
    if (existing.firstAttemptAtMs == null) existing.firstAttemptAtMs = startedAt;
    existing.attempts++;
    existing.lastProbeAmountLamports = amountLamports;

    try {
      const quote = await this.provider.getQuote({
        inputMint: input.inputMint,
        outputMint: input.outputMint,
        amountLamports,
        autoSlippage: true,
        maxAutoSlippageBps: PUMP_JUPITER_MAX_SLIPPAGE_BPS,
        trafficPriority: 6
      });
      const completedAt = this.now();
      existing.lastLatencyMs = Math.max(0, completedAt - startedAt);
      existing.routeAvailable = true;
      existing.lastFailureReason = undefined;
      if (existing.firstRouteAtMs == null) {
        const lagMs = Math.max(0, completedAt - input.eventTimestampMs);
        existing.firstRouteAtMs = completedAt;
        existing.firstRouteLagMs = lagMs;
        existing.firstCompliantRouteLagMs = lagMs;
        existing.firstRouteAmountLamports = amountLamports;
        existing.firstRouteLadderIndex = cursor;
        existing.firstRouteSlippageBps = quote.slippageBps;
        existing.firstRoutePriceImpactPct = quote.priceImpactPct;
      }
      existing.router = quote.router;
      existing.outAmount = quote.outAmount;
      existing.priceImpactPct = quote.priceImpactPct;
      existing.slippageBps = quote.slippageBps;
    } catch (err: any) {
      const status = err instanceof JupiterQuoteException
        ? err.status
        : Number(err?.status ?? err?.response?.status ?? 0);
      const message = String(err?.message || err || '');
      if (status === 429) {
        existing.rateLimitHits++;
        existing.lastFailureReason = 'RATE_LIMIT';
      } else if (/hard-cap|slippage.*750|750.*slippage/i.test(message)) {
        existing.lastFailureReason = 'SLIPPAGE_ABOVE_CAP';
      } else {
        existing.lastFailureReason = 'ROUTE_UNAVAILABLE';
      }
      existing.routeAvailable = false;
      existing.lastLatencyMs = Math.max(0, this.now() - startedAt);
      this.ladderCursors.set(seriesKey, Math.min(cursor + 1, ladder.length - 1));
    }

    this.samples.set(input.mint, existing);
    return { ...existing };
  }

  get(mint: string): PumpJupiterTimingSample | undefined {
    const sample = this.samples.get(mint);
    return sample ? { ...sample } : undefined;
  }

  snapshot(): PumpJupiterTimingSample[] {
    return [...this.samples.values()].map(sample => ({ ...sample }));
  }

  summary(): PumpJupiterTimingSummary {
    return summarizePumpJupiterTiming(this.snapshot());
  }
}
