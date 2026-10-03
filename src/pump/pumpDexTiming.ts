export interface PumpDexCorrelationCandidate {
  mint: string;
  eventTimestampMs: number;
}

export interface PumpDexCorrelationSample {
  observedAtMs: number;
  ready: boolean;
  pairAddress: string;
  pairCreatedAtMs?: number;
  priceUsd?: number;
  liquidityUsd?: number;
  dexUrl: string;
}

export interface PumpDexCorrelationTarget {
  getDexCorrelationCandidates(limit: number, maxAgeMs: number): PumpDexCorrelationCandidate[];
  applyDexCorrelation(mint: string, sample: PumpDexCorrelationSample): void;
}

export interface DexPairLike {
  chainId?: string;
  dexId?: string;
  pairAddress?: string;
  baseToken?: { address?: string };
  quoteToken?: { address?: string | null };
  priceUsd?: string | null;
  liquidity?: { usd?: number | null } | null;
  pairCreatedAt?: number | null;
}

export interface PumpDexTimingSnapshot {
  samples: number;
  batches: number;
  lastSampleAt?: string;
  lastBatchSize?: number;
  lastError?: string;
}

export interface PumpDexTimingOptions {
  now?: () => number;
  fetchJson?: (url: string) => Promise<unknown>;
  batchSize?: number;
  maxAgeMs?: number;
}

function finiteNumber(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

export function selectBestDexPairForMint(
  mint: string,
  pairs: DexPairLike[]
): DexPairLike | undefined {
  const matching = pairs.filter(pair => {
    if (String(pair.chainId || '').toLowerCase() !== 'solana') return false;
    return pair.baseToken?.address === mint || pair.quoteToken?.address === mint;
  });
  // DexScreener priceUsd describes the base token. If the Pump mint appears
  // as quote token, that price belongs to the other asset and cannot be used
  // as Pump price/economic readiness when a base-side pair exists.
  const baseMatches = matching.filter(pair => pair.baseToken?.address === mint);
  const relevant = baseMatches.length > 0 ? baseMatches : matching;

  return relevant.sort((a, b) => {
    const aLiq = finiteNumber(a.liquidity?.usd) ?? -1;
    const bLiq = finiteNumber(b.liquidity?.usd) ?? -1;
    if (aLiq !== bLiq) return bLiq - aLiq;

    const aCreated = finiteNumber(a.pairCreatedAt) ?? Number.MAX_SAFE_INTEGER;
    const bCreated = finiteNumber(b.pairCreatedAt) ?? Number.MAX_SAFE_INTEGER;
    return aCreated - bCreated;
  })[0];
}

async function defaultFetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    method: 'GET',
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(8_000)
  });
  if (!response.ok) {
    throw new Error(`DexScreener HTTP ${response.status}`);
  }
  return response.json();
}

export class PumpDexTimingTracker {
  private readonly now: () => number;
  private readonly fetchJson: (url: string) => Promise<unknown>;
  private readonly batchSize: number;
  private readonly maxAgeMs: number;
  private samples = 0;
  private batches = 0;
  private lastSampleAt: string | undefined;
  private lastBatchSize: number | undefined;
  private lastError: string | undefined;

  constructor(
    private readonly target: PumpDexCorrelationTarget,
    options: PumpDexTimingOptions = {}
  ) {
    this.now = options.now ?? Date.now;
    this.fetchJson = options.fetchJson ?? defaultFetchJson;
    this.batchSize = Math.max(1, Math.min(30, Math.floor(options.batchSize ?? 30)));
    this.maxAgeMs = Math.max(60_000, options.maxAgeMs ?? 15 * 60_000);
  }

  async sample(): Promise<void> {
    const candidates = this.target
      .getDexCorrelationCandidates(this.batchSize, this.maxAgeMs)
      .slice(0, this.batchSize);
    if (candidates.length === 0) return;

    const mintList = candidates.map(item => item.mint).join(',');
    const url = `https://api.dexscreener.com/tokens/v1/solana/${encodeURIComponent(mintList).replaceAll('%2C', ',')}`;

    try {
      const payload = await this.fetchJson(url);
      const pairs = Array.isArray(payload) ? payload as DexPairLike[] : [];
      const observedAtMs = this.now();

      for (const candidate of candidates) {
        const pair = selectBestDexPairForMint(candidate.mint, pairs);
        if (!pair?.pairAddress) continue;

        const priceUsd = finiteNumber(pair.priceUsd);
        const liquidityUsd = finiteNumber(pair.liquidity?.usd);
        const pairCreatedAtMs = finiteNumber(pair.pairCreatedAt);
        const ready = Boolean(
          priceUsd != null &&
          priceUsd > 0 &&
          liquidityUsd != null &&
          liquidityUsd > 0
        );
        const pairAddress = String(pair.pairAddress);

        this.target.applyDexCorrelation(candidate.mint, {
          observedAtMs,
          ready,
          pairAddress,
          pairCreatedAtMs,
          priceUsd,
          liquidityUsd,
          dexUrl: `https://dexscreener.com/solana/${encodeURIComponent(pairAddress.toLowerCase())}`
        });
        this.samples++;
      }

      this.batches++;
      this.lastBatchSize = candidates.length;
      this.lastSampleAt = new Date(observedAtMs).toISOString();
      this.lastError = undefined;
    } catch (err: any) {
      this.lastError = err?.message || String(err);
    }
  }

  snapshot(): PumpDexTimingSnapshot {
    return {
      samples: this.samples,
      batches: this.batches,
      lastSampleAt: this.lastSampleAt,
      lastBatchSize: this.lastBatchSize,
      lastError: this.lastError
    };
  }
}
