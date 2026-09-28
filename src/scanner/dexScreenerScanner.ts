import axios from 'axios';

export interface TokenCandidate {
  mint: string;
  symbol: string;
  name: string;
  priceUsd: number;
  liquidityUsd: number;
  volume24hUsd: number;
  volume5mUsd?: number;
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
        const symbol = item.baseToken?.symbol;
        // Sanitização Estrita de Tokens (Fim do 'undefined'):
        if (!mint || !symbol || symbol === 'undefined' || symbol.trim() === '') {
          continue;
        }

        if (seenMints.has(mint)) continue;
        seenMints.add(mint);

        const pairCreatedAt = Number(item.pairCreatedAt || 0);
        // Filtro de maturidade estrita da piscina: janela aceita entre 20 min e 4 horas
        if (pairCreatedAt > 0 && !this.isMaturityValid(pairCreatedAt, now)) {
          continue;
        }

        // Validação de agressão de fluxo se dados de txns estiverem presentes
        const buys = Number(item.txns?.h1?.buys || item.txns?.m5?.buys || 0);
        const sells = Number(item.txns?.h1?.sells || item.txns?.m5?.sells || 0);
        if (buys + sells >= 20 && !this.isBuyingAggressionValid(buys, sells)) {
          continue;
        }

        candidates.push({
          mint,
          symbol,
          name: item.baseToken?.name || symbol,
          priceUsd: Number(item.priceUsd || 0),
          liquidityUsd,
          volume24hUsd: Number(item.volume?.h24 || 0),
          volume5mUsd: Number(item.volume?.m5 || 0),
          pairCreatedAt: pairCreatedAt || now,
          dexId: item.dexId || 'raydium'
        });
      }

      return candidates;
    } catch {
      return [];
    }
  }

  /**
   * Valida se a idade da pool está entre 20 minutos e 4 horas.
   */
  public isMaturityValid(pairCreatedAt: number, now: number = Date.now()): boolean {
    if (!pairCreatedAt || pairCreatedAt <= 0) return false;
    const ageMs = now - pairCreatedAt;
    const minMaturityMs = 20 * 60 * 1000;      // Mínimo 20 minutos
    const maxMaturityMs = 4 * 60 * 60 * 1000;   // Máximo 4 horas
    return ageMs >= minMaturityMs && ageMs <= maxMaturityMs;
  }

  /**
   * Valida se o ratio de agressão compradora é de pelo menos 70%.
   */
  public isBuyingAggressionValid(buys: number, sells: number): boolean {
    const total = buys + sells;
    if (total === 0) return false;
    const buyRatio = buys / total;
    return buyRatio >= 0.70;
  }

  public async fetchCurrentTokenPriceUsd(mint: string): Promise<number | null> {
    const meta = await this.fetchTokenMetadata(mint);
    return meta ? meta.priceUsd : null;
  }

  public async fetchTokenMetadata(mint: string): Promise<{ symbol: string; priceUsd: number } | null> {
    try {
      const res = await this.fetchClient(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
      const data = res.data;
      const pairs = Array.isArray(data) ? data : (data?.pairs || []);
      if (!Array.isArray(pairs) || pairs.length === 0) {
        return null;
      }
      // Ordena pelas pools com maior liquidez para garantir preço e dados representativos
      const sortedPairs = [...pairs].sort((a, b) => Number(b.liquidity?.usd || 0) - Number(a.liquidity?.usd || 0));
      const best = sortedPairs[0];
      const bestPrice = Number(best?.priceUsd || 0);
      const rawSymbol = best?.baseToken?.symbol;
      const symbol = (rawSymbol && rawSymbol !== 'undefined' && rawSymbol.trim() !== '') 
        ? rawSymbol 
        : (mint.slice(0, 4) + '...' + mint.slice(-4));
      return bestPrice > 0 ? { symbol, priceUsd: bestPrice } : null;
    } catch {
      return null;
    }
  }
}
