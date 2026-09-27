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
  private static readonly TOKEN_PROFILES_URL = 'https://api.dexscreener.com/token-profiles/latest/v1';
  private static readonly RAYDIUM_POOLS_URL = 'https://api.dexscreener.com/latest/dex/search?q=raydium%20solana';

  constructor(options?: ScannerOptions) {
    this.fetchClient = options?.fetchClient || (async (url: string) => axios.get(url, { timeout: 8000 }));
  }

  public async scanSolanaTrends(minLiquidityUsd: number = 10000): Promise<TokenCandidate[]> {
    try {
      // Consome feeds dinâmicos: perfis recém-atualizados e novas pools
      const [profilesRes, poolsRes] = await Promise.allSettled([
        this.fetchClient(DexScreenerScanner.TOKEN_PROFILES_URL),
        this.fetchClient(DexScreenerScanner.RAYDIUM_POOLS_URL)
      ]);

      const tokenMintsFromProfiles: string[] = [];
      if (profilesRes.status === 'fulfilled') {
        const rawProfiles = Array.isArray(profilesRes.value.data) ? profilesRes.value.data : [];
        for (const p of rawProfiles) {
          if (p.chainId?.toLowerCase() === 'solana' && p.tokenAddress) {
            tokenMintsFromProfiles.push(p.tokenAddress);
          }
        }
      }

      let rawPairs: any[] = [];
      if (poolsRes.status === 'fulfilled') {
        const data = poolsRes.value.data;
        rawPairs = Array.isArray(data) ? data : (data?.pairs || []);
      }

      // Enriquece e busca pares dos tokens recém-perfilados na Solana
      if (tokenMintsFromProfiles.length > 0) {
        try {
          const sampleMints = tokenMintsFromProfiles.slice(0, 15).join(',');
          const tokensRes = await this.fetchClient(`https://api.dexscreener.com/latest/dex/tokens/${sampleMints}`);
          const fetchedPairs = Array.isArray(tokensRes.data) 
            ? tokensRes.data 
            : (tokensRes.data?.pairs || (Array.isArray(tokensRes.data?.pairs) ? tokensRes.data.pairs : []));
          if (Array.isArray(fetchedPairs)) {
            rawPairs = [...rawPairs, ...fetchedPairs];
          }
        } catch {}
      }

      const now = Date.now();
      const tenMinMs = 10 * 60 * 1000;
      const sixtyMinMs = 60 * 60 * 1000;

      const candidates: TokenCandidate[] = [];
      const seenMints = new Set<string>();

      for (const item of rawPairs) {
        // Filtra estritamente tokens da rede Solana
        if (item.chainId && item.chainId.toLowerCase() !== 'solana') {
          continue;
        }

        const liquidityUsd = Number(item.liquidity?.usd || 0);
        if (liquidityUsd < minLiquidityUsd) {
          continue;
        }

        const mint = item.baseToken?.address || item.tokenAddress;
        if (!mint || seenMints.has(mint)) continue;
        seenMints.add(mint);

        const pairCreatedAt = Number(item.pairCreatedAt || 0);
        // Filtro de maturidade da piscina: aceita se criado entre 10 e 60 min, ou se recém-perfilado, ou pool ativa
        const ageMs = pairCreatedAt > 0 ? (now - pairCreatedAt) : 0;
        const isIdealWindow = pairCreatedAt > 0 ? (ageMs >= tenMinMs && ageMs <= 24 * 60 * 60 * 1000) : true;
        const isProfiled = tokenMintsFromProfiles.includes(mint);

        // Se tiver carimbo de criação fora da janela de operação e não for perfil novo, descarta
        if (pairCreatedAt > 0 && !isIdealWindow && !isProfiled) {
          continue;
        }

        candidates.push({
          mint,
          symbol: item.baseToken?.symbol || 'UNKNOWN',
          name: item.baseToken?.name || 'Unknown Token',
          priceUsd: Number(item.priceUsd || 0),
          liquidityUsd,
          volume24hUsd: Number(item.volume?.h24 || 0),
          pairCreatedAt: pairCreatedAt || now,
          dexId: item.dexId || 'raydium'
        });
      }

      return candidates;
    } catch {
      return [];
    }
  }
}
