import {
  JupiterQuoteException,
  type SwapQuoteParams,
  type SwapQuoteResult
} from '../blockchain/dexAggregator.js';

export interface PumpJupiterProbeInput {
  mint: string;
  eventTimestampMs: number;
  inputMint: string;
  outputMint: string;
  amountLamports: number;
}

export interface PumpJupiterTimingSample {
  mint: string;
  attempts: number;
  rateLimitHits: number;
  routeAvailable: boolean;
  firstAttemptAtMs?: number;
  firstRouteAtMs?: number;
  firstRouteLagMs?: number;
  lastLatencyMs?: number;
  router?: string;
  outAmount?: number;
  priceImpactPct?: number;
  slippageBps?: number;
}

export interface PumpJupiterQuoteProvider {
  getQuote(params: SwapQuoteParams): Promise<SwapQuoteResult>;
}

export class PumpJupiterTimingTracker {
  private readonly now: () => number;
  private readonly samples = new Map<string, PumpJupiterTimingSample>();

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
    const startedAt = this.now();
    if (existing.firstAttemptAtMs == null) existing.firstAttemptAtMs = startedAt;
    existing.attempts++;

    try {
      const quote = await this.provider.getQuote({
        inputMint: input.inputMint,
        outputMint: input.outputMint,
        amountLamports: input.amountLamports,
        autoSlippage: true,
        trafficPriority: 6
      });
      const completedAt = this.now();
      existing.lastLatencyMs = Math.max(0, completedAt - startedAt);
      existing.routeAvailable = true;
      if (existing.firstRouteAtMs == null) {
        existing.firstRouteAtMs = completedAt;
        existing.firstRouteLagMs = completedAt - input.eventTimestampMs;
      }
      existing.router = quote.router;
      existing.outAmount = quote.outAmount;
      existing.priceImpactPct = quote.priceImpactPct;
      existing.slippageBps = quote.slippageBps;
    } catch (err: any) {
      const status = err instanceof JupiterQuoteException
        ? err.status
        : Number(err?.status ?? err?.response?.status ?? 0);
      if (status === 429) existing.rateLimitHits++;
      existing.routeAvailable = false;
      existing.lastLatencyMs = Math.max(0, this.now() - startedAt);
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
}
