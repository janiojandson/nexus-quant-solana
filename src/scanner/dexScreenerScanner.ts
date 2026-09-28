import axios from 'axios';
import { MintCooldownCache } from './mintCooldownCache.js';

export interface TokenCandidate {
  mint: string;
  symbol: string;
  name: string;
  priceUsd: number;
  liquidityUsd: number;
  volume24hUsd: number;
  volume5mUsd?: number;
  volumeBuysM5?: number;
  volumeSellsM5?: number;
  pairCreatedAt: number;
  dexId: string;
  priceChangeM5?: number;
  buysM5?: number;
  sellsM5?: number;
  h1HighPriceUsd?: number;
}

export interface ScannerOptions {
  fetchClient?: (url: string) => Promise<{ data: any }>;
}

export class DexScreenerScanner {
  private fetchClient: (url: string) => Promise<{ data: any }>;
  public readonly cooldownCache: MintCooldownCache;
  private static readonly SOLANA_SEARCH_URL = 'https://api.dexscreener.com/latest/dex/search?q=solana';
  private static readonly RAYDIUM_POOLS_URL = 'https://api.dexscreener.com/latest/dex/search?q=raydium%20solana';
  private static readonly GECKOTERMINAL_POOLS_URL = 'https://api.geckoterminal.com/api/v2/networks/solana/new_pools';

  private static lastGeckoFetchTime = 0;

  constructor(options?: ScannerOptions) {
    this.cooldownCache = new MintCooldownCache(5);
    this.fetchClient = options?.fetchClient || (async (url: string) => {
      const startTime = Date.now();
      try {
        const res = await axios.get(url, {
          timeout: 8000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
            'Accept': 'application/json, text/plain, */*',
            'Accept-Language': 'en-US,en;q=0.9',
            'Referer': 'https://dexscreener.com/'
          }
        });
        const elapsed = Date.now() - startTime;
        console.log(`🌐 [Scanner HTTP ${res.status}] ${url.split('?')[0]} (${elapsed}ms)`);
        return res;
      } catch (err: any) {
        const elapsed = Date.now() - startTime;
        const status = err.response?.status || 'ERR';
        const msg = err.response?.statusText || err.message;
        // Se for 429 (Rate Limit) do GeckoTerminal ou DexScreener, silencia para não poluir o terminal
        if (status === 429) {
          // Log silencioso / sem poluição
        } else {
          console.warn(`⚠️ [Scanner HTTP ${status}] ${url.split('?')[0]} falhou após ${elapsed}ms: ${msg}`);
        }
        throw err;
      }
    });
  }

  public async scanSolanaTrends(minLiquidityUsd: number = 20000): Promise<TokenCandidate[]> {
    try {
      let sourcesCount = 0;
      const discoveredMints = new Set<string>();
      let rawPairs: any[] = [];

      // Controla taxa do GeckoTerminal (máximo 1 chamada a cada 60s para respeitar rate limits públicos)
      const nowTs = Date.now();
      const canFetchGecko = (nowTs - DexScreenerScanner.lastGeckoFetchTime) >= 60000;
      if (canFetchGecko) {
        DexScreenerScanner.lastGeckoFetchTime = nowTs;
      }

      // 1. Endpoints Qualificados On-Chain (DexScreener Search + GeckoTerminal new_pools)
      const [solanaSearchRes, poolsRes, geckoRes] = await Promise.allSettled([
        this.fetchClient(DexScreenerScanner.SOLANA_SEARCH_URL),
        this.fetchClient(DexScreenerScanner.RAYDIUM_POOLS_URL),
        canFetchGecko ? this.fetchClient(DexScreenerScanner.GECKOTERMINAL_POOLS_URL) : Promise.reject('GECKO_THROTTLED')
      ]);

      // Extrai de search Solana geral
      if (solanaSearchRes.status === 'fulfilled') {
        sourcesCount++;
        const data = solanaSearchRes.value.data;
        const fetched = Array.isArray(data) ? data : (data?.pairs || []);
        if (Array.isArray(fetched)) {
          rawPairs.push(...fetched);
        }
      }

      // Extrai de search Raydium Solana
      if (poolsRes.status === 'fulfilled') {
        sourcesCount++;
        const data = poolsRes.value.data;
        const fetched = Array.isArray(data) ? data : (data?.pairs || []);
        if (Array.isArray(fetched)) {
          rawPairs.push(...fetched);
        }
      }

      // Extrai de GeckoTerminal Solana new_pools
      if (geckoRes.status === 'fulfilled') {
        sourcesCount++;
        const geckoPools = geckoRes.value.data?.data || [];
        for (const gp of geckoPools) {
          const attr = gp.attributes || {};
          const mint = gp.relationships?.base_token?.data?.id?.replace(/^solana_/, '');
          if (mint && this.cooldownCache.shouldProcess(mint)) {
            discoveredMints.add(mint);
          }
          rawPairs.push({
            chainId: 'solana',
            dexId: 'geckoterminal',
            baseToken: {
              address: mint,
              symbol: attr.name ? attr.name.split(' / ')[0] : 'UNKNOWN',
              name: attr.name || 'Unknown'
            },
            priceUsd: Number(attr.base_token_price_usd || 0),
            liquidity: { usd: Number(attr.reserve_in_usd || 0) },
            volume: {
              h24: Number(attr.volume_usd?.h24 || 0),
              m5: Number(attr.volume_usd?.m5 || 0)
            },
            pairCreatedAt: attr.pool_created_at ? new Date(attr.pool_created_at).getTime() : Date.now()
          });
        }
      }

      // Enriquece mints descobertos em lotes de até 30 na DexScreener API (apenas mints liberados pelo TTL cache)
      const mintsArray = Array.from(discoveredMints).filter(m => this.cooldownCache.shouldProcess(m));
      if (mintsArray.length > 0) {
        const batchSize = 30;
        for (let i = 0; i < Math.min(mintsArray.length, 60); i += batchSize) {
          const chunk = mintsArray.slice(i, i + batchSize).join(',');
          try {
            const tokensRes = await this.fetchClient(`https://api.dexscreener.com/latest/dex/tokens/${chunk}`);
            const fetchedPairs = Array.isArray(tokensRes.data)
              ? tokensRes.data
              : (tokensRes.data?.pairs || (Array.isArray(tokensRes.data?.pairs) ? tokensRes.data.pairs : []));
            if (Array.isArray(fetchedPairs)) {
              rawPairs.push(...fetchedPairs);
            }
          } catch {}
        }
      }

      // 3. Log de Diagnóstico: Tokens brutos extraídos antes dos filtros
      console.log(`📡 [Descoberta] ${rawPairs.length} tokens brutos extraídos de ${sourcesCount} fontes (${discoveredMints.size} mints únicos)`);

      const now = Date.now();
      const candidates: TokenCandidate[] = [];
      const seenMints = new Set<string>();

      for (const item of rawPairs) {
        // Filtra estritamente tokens da rede Solana
        if (item.chainId && item.chainId.toLowerCase() !== 'solana') {
          continue;
        }

        const mint = item.baseToken?.address || item.tokenAddress;
        if (!mint || !this.cooldownCache.shouldProcess(mint)) {
          continue;
        }

        const liquidityUsd = Number(item.liquidity?.usd || 0);
        if (liquidityUsd < minLiquidityUsd) {
          this.cooldownCache.recordRejection(mint);
          continue;
        }

        const symbol = item.baseToken?.symbol;
        // Sanitização Estrita de Tokens (Fim do 'undefined'):
        if (!symbol || symbol === 'undefined' || symbol.trim() === '') {
          this.cooldownCache.recordRejection(mint);
          continue;
        }

        if (seenMints.has(mint)) continue;
        seenMints.add(mint);

        const pairCreatedAt = Number(item.pairCreatedAt || 0);
        // Filtro de maturidade estrita da piscina: janela aceita entre 15 e 60 minutos
        if (pairCreatedAt > 0 && !this.isMaturityValid(pairCreatedAt, now)) {
          this.cooldownCache.recordRejection(mint);
          continue;
        }

        // 1. Filtro de Variação de Preço nos Últimos 5 Minutos (m5): +3% a +35%
        const priceChangeM5 = item.priceChange?.m5 !== undefined ? Number(item.priceChange.m5) : undefined;
        if (priceChangeM5 !== undefined) {
          // VETO TÉCNICO IMEDIATO: Se priceChange.m5 <= 0 ou > 35
          if (priceChangeM5 <= 0 || priceChangeM5 > 35 || priceChangeM5 < 3) {
            continue;
          }
        }

        // 2. Dominância de Compradores (Order Flow: txns e volumes nos 5m)
        const buysM5 = item.txns?.m5?.buys !== undefined ? Number(item.txns.m5.buys) : undefined;
        const sellsM5 = item.txns?.m5?.sells !== undefined ? Number(item.txns.m5.sells) : undefined;
        if (buysM5 !== undefined && sellsM5 !== undefined && (buysM5 + sellsM5 > 0)) {
          // Exija no mínimo 20% mais compradores que vendedores (buys >= sells * 1.2)
          if (buysM5 < (sellsM5 * 1.2)) {
            continue;
          }
        }

        // Volume comprador vs vendedor nos 5m (quando fornecido pela DexScreener)
        const volumeBuysM5 = item.volume?.m5?.buys !== undefined ? Number(item.volume.m5.buys) : undefined;
        const volumeSellsM5 = item.volume?.m5?.sells !== undefined ? Number(item.volume.m5.sells) : undefined;
        if (volumeBuysM5 !== undefined && volumeSellsM5 !== undefined && (volumeBuysM5 + volumeSellsM5 > 0)) {
          if (volumeBuysM5 <= volumeSellsM5) {
            continue;
          }
        }

        // 3. Proximidade da Máxima Recente (Evitar Faca Caindo: h1HighPriceUsd)
        const currentPriceUsd = Number(item.priceUsd || 0);
        const priceChangeH1 = item.priceChange?.h1 !== undefined ? Number(item.priceChange.h1) : 0;
        // Se houver priceChangeH1 negativo, a máxima recente foi no mínimo o preço atual / (1 + priceChangeH1/100)
        let h1HighPriceUsd = currentPriceUsd;
        if (priceChangeH1 < 0) {
          h1HighPriceUsd = currentPriceUsd / (1 + (priceChangeH1 / 100));
        }
        if (item.h1HighPriceUsd) {
          h1HighPriceUsd = Number(item.h1HighPriceUsd);
        }

        // Filtro anti-faca caindo: preço atual deve ser >= 70% da máxima h1
        if (h1HighPriceUsd > 0 && (currentPriceUsd / h1HighPriceUsd) < 0.70) {
          continue;
        }

        // Validação complementar de agressão de fluxo se dados de txns estiverem presentes
        const buys = Number(item.txns?.h1?.buys || item.txns?.m5?.buys || 0);
        const sells = Number(item.txns?.h1?.sells || item.txns?.m5?.sells || 0);
        if (buys + sells >= 20 && !this.isBuyingAggressionValid(buys, sells)) {
          continue;
        }

        candidates.push({
          mint,
          symbol,
          name: item.baseToken?.name || symbol,
          priceUsd: currentPriceUsd,
          liquidityUsd,
          volume24hUsd: Number(item.volume?.h24 || 0),
          volume5mUsd: Number(item.volume?.m5 || 0),
          volumeBuysM5,
          volumeSellsM5,
          pairCreatedAt: pairCreatedAt || now,
          dexId: item.dexId || 'raydium',
          priceChangeM5,
          buysM5,
          sellsM5,
          h1HighPriceUsd
        });
      }

      return candidates;
    } catch {
      return [];
    }
  }

  /**
   * Valida se a idade da pool está entre 15 e 60 minutos (pós-dump inicial).
   */
  public isMaturityValid(pairCreatedAt: number, now: number = Date.now()): boolean {
    if (!pairCreatedAt || pairCreatedAt <= 0) return false;
    const ageMs = now - pairCreatedAt;
    const minMaturityMs = 15 * 60 * 1000;      // Mínimo 15 minutos
    const maxMaturityMs = 60 * 60 * 1000;      // Máximo 60 minutos (1 hora)
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
