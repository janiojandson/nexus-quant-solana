import { JupiterOrgHub } from '../hubs/jupiterOrgHub.js';

export interface DiscoveredToken {
  mint: string;
  symbol: string | null;
  name: string | null;
  priceUsd: number | null;
  liquidityUsd: number | null;
  priceChangeM5: number | null;
  buysM5: number | null;
  sellsM5: number | null;
  volumeBuysM5: number | null;
  volumeSellsM5: number | null;
  pairAddress: string | null;
  pairCreatedAt: number | null;
}

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const finite = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;
const positive = (value: unknown): number | null => {
  const n = finite(value);
  return n !== null && n > 0 ? n : null;
};
const string = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value : null;
const time = (value: unknown): number | null => {
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
};

/** Jupiter TokensV2 returns a direct array. Missing market facts remain unknown. */
function parseTokensV2(body: unknown): DiscoveredToken[] {
    if (!Array.isArray(body)) return [];
    return body.flatMap((item: unknown) => {
      const token = record(item);
      const mint = string(token?.id);
      if (!mint) return [];
      const stats = record(token?.stats5m);
      const firstPool = record(token?.firstPool);
      return [{
        mint, symbol: string(token?.symbol), name: string(token?.name),
        priceUsd: positive(token?.usdPrice), liquidityUsd: positive(token?.liquidity),
        priceChangeM5: finite(stats?.priceChange), buysM5: finite(stats?.buyCount),
        sellsM5: finite(stats?.sellCount), volumeBuysM5: finite(stats?.buyVolume),
        volumeSellsM5: finite(stats?.sellVolume),
        pairAddress: string(firstPool?.id), pairCreatedAt: time(firstPool?.createdAt)
      }];
    });
}

export class JupiterDiscoveryScanner {
  constructor(private readonly jupiterHub: Pick<JupiterOrgHub, 'request'>) {}

  async scanTrendingCandidates(): Promise<DiscoveredToken[]> {
    const response = await this.jupiterHub.request('DISCOVERY', '/tokens/v2/toptrending/5m');
    return response.status === 200 ? parseTokensV2(response.body) : [];
  }

  async fetchCandidate(mint: string, signal?: AbortSignal): Promise<DiscoveredToken | null> {
    const response = await this.jupiterHub.request('DISCOVERY','/tokens/v2/search',
      {query:mint},{signal,deadlineMs:Date.now()+10_000});
    return response.status === 200 ? parseTokensV2(response.body).find(candidate => candidate.mint === mint) ?? null : null;
  }

  async scanTrendingTokens(): Promise<string[]> {
    return (await this.scanTrendingCandidates()).map(candidate => candidate.mint);
  }
}
