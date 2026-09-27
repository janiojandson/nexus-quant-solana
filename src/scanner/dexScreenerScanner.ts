import axios from 'axios';

export interface TokenCandidate {
  mint: string;
  symbol: string;
  name: string;
  priceUsd: number;
  liquidityUsd: number;
  volume24hUsd: number;
  pairCreatedAt: number;
  dexId: string;
}

export interface ScannerOptions {
  fetchClient?: (url: string) => Promise<{ data: any }>;
}

export class DexScreenerScanner {
  private fetchClient: (url: string) => Promise<{ data: any }>;
  private static readonly DEXSCREENER_TRENDS_URL = 'https://api.dexscreener.com/latest/dex/search?q=solana';

  constructor(options?: ScannerOptions) {
    this.fetchClient = options?.fetchClient || (async (url: string) => axios.get(url, { timeout: 8000 }));
  }

  public async scanSolanaTrends(minLiquidityUsd: number = 10000): Promise<TokenCandidate[]> {
    try {
      const response = await this.fetchClient(DexScreenerScanner.DEXSCREENER_TRENDS_URL);
      const rawData = Array.isArray(response.data) ? response.data : (response.data?.pairs || []);

      const candidates: TokenCandidate[] = [];

      for (const item of rawData) {
        // Filtra estritamente tokens da rede Solana
        if (item.chainId && item.chainId.toLowerCase() !== 'solana') {
          continue;
        }

        const liquidityUsd = Number(item.liquidity?.usd || 0);
        if (liquidityUsd < minLiquidityUsd) {
          continue;
        }

        const mint = item.baseToken?.address || item.tokenAddress;
        if (!mint) continue;

        candidates.push({
          mint,
          symbol: item.baseToken?.symbol || 'UNKNOWN',
          name: item.baseToken?.name || 'Unknown Token',
          priceUsd: Number(item.priceUsd || 0),
          liquidityUsd,
          volume24hUsd: Number(item.volume?.h24 || 0),
          pairCreatedAt: Number(item.pairCreatedAt || Date.now()),
          dexId: item.dexId || 'raydium'
        });
      }

      return candidates;
    } catch {
      return [];
    }
  }
}
