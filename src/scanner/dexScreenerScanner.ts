import axios from 'axios';
import { MintCooldownCache } from './mintCooldownCache.js';
import { MaturityIncubator } from '../services/maturityIncubator.js';

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
  pairAddress?: string;
}

export interface TokenMarketSnapshot {
  symbol: string;
  priceUsd: number;
  liquidityUsd: number;
  volume5mUsd: number;
  buysM5: number;
  sellsM5: number;
  pairAddress?: string;
  dexId?: string;
  fetchedAt: number;
}

export interface IncubatorScanStats {
  waiting: number;
  mature: number;
  expired: number;
  technicalDiscards: number;
  upstreamFailures?: number;
  retrying?: number;
}

export interface ScannerOptions {
  fetchClient?: (url: string) => Promise<{ data: any }>;
  incubator?: MaturityIncubator;
  now?: () => number;
}

export class DexScreenerScanner {
  private fetchClient: (url: string) => Promise<{ data: any }>;
  public readonly cooldownCache: MintCooldownCache;
  public readonly incubator: MaturityIncubator;
  public lastIncubatorStats: IncubatorScanStats = { waiting: 0, mature: 0, expired: 0, technicalDiscards: 0 };
  private static readonly SOLANA_SEARCH_URL = 'https://api.dexscreener.com/latest/dex/search?q=solana';
  private static readonly RAYDIUM_POOLS_URL = 'https://api.dexscreener.com/latest/dex/search?q=raydium%20solana';
  private static readonly GECKOTERMINAL_POOLS_URL = 'https://api.geckoterminal.com/api/v2/networks/solana/new_pools';

  private lastGeckoFetchTime = 0;
  private readonly now: () => number;
  private readonly enrichmentRetryAt = new Map<string, number>();
  private static readonly ENRICHMENT_BACKOFF_MS = 15_000;

  constructor(options?: ScannerOptions) {
    this.now = options?.now || Date.now;
    this.cooldownCache = new MintCooldownCache(5);
    this.incubator = options?.incubator || new MaturityIncubator({ minMaturityMinutes: 5, maxMaturityMinutes: 60 });
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

  public async scanSolanaTrends(minLiquidityUsd: number = 15000): Promise<TokenCandidate[]> {
    try {
      let sourcesCount = 0;
      const discoveredMints = new Set<string>();
      let rawPairs: any[] = [];

      // Controla taxa do GeckoTerminal (máximo 1 chamada a cada 60s para respeitar rate limits públicos)
      const nowTs = this.now();
      let upstreamFailures = 0;
      const extractPairs = (data: any): any[] => {
        const pairs = Array.isArray(data) ? data : data?.pairs;
        return Array.isArray(pairs) ? pairs : [];
      };
      const canFetchGecko = (nowTs - this.lastGeckoFetchTime) >= 60000;
      if (canFetchGecko) {
        this.lastGeckoFetchTime = nowTs;
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
          if (fetched.length === 0) upstreamFailures++;
        }
      }

      // Extrai de search Raydium Solana
      if (poolsRes.status === 'fulfilled') {
        sourcesCount++;
        const data = poolsRes.value.data;
        const fetched = Array.isArray(data) ? data : (data?.pairs || []);
        if (Array.isArray(fetched)) {
          rawPairs.push(...fetched);
          if (fetched.length === 0) upstreamFailures++;
        }
      }

      // Extrai de GeckoTerminal Solana new_pools e alimenta a Incubadora de Maturação
      if (geckoRes.status === 'fulfilled') {
        sourcesCount++;
        const geckoPools = geckoRes.value.data?.data || [];
        for (const gp of geckoPools) {
          const attr = gp.attributes || {};
          const mint = gp.relationships?.base_token?.data?.id?.replace(/^solana_/, '');
          if (!mint || !this.cooldownCache.shouldProcess(mint)) {
            continue;
          }

          const poolCreatedAt = attr.pool_created_at ? new Date(attr.pool_created_at).getTime() : nowTs;
          const ageMinutes = (nowTs - poolCreatedAt) / (60 * 1000);

          if (ageMinutes < 5) {
            // Token recém-nascido (< 5 min): NÃO descarta sumariamente!
            // Envia para a Incubadora aguardar os 5 minutos pós-dump inicial.
            this.incubator.add({
              mint,
              poolAddress: attr.address || gp.id || '',
              symbol: attr.name ? attr.name.split(' / ')[0] : 'UNKNOWN',
              name: attr.name || 'Unknown',
              pairCreatedAt: poolCreatedAt
            }, nowTs);
          } else if (ageMinutes <= 60) {
            // Se já tiver entre 5 e 60 minutos na captura: avalia imediatamente
            discoveredMints.add(mint);
            this.incubator.add({ mint, poolAddress: attr.address || gp.id || '', pairCreatedAt: poolCreatedAt }, nowTs);
            // Gecko discovers the mint; only real DEX pairs may pass entry filters.
          }
        }
      }

      // 2. Varredura da Incubadora de Maturação: Puxa tokens que atingiram 15 a 60 minutos
      const incubatorSweep = this.incubator.sweep(nowTs);
      this.lastIncubatorStats = {
        waiting: incubatorSweep.waiting.length,
        mature: incubatorSweep.mature.length,
        expired: incubatorSweep.expiredCount,
        technicalDiscards: 0
      };

      for (const matureToken of incubatorSweep.mature) {
        // Só consome depois de receber pares reais para este mint.
        if (this.cooldownCache.shouldProcess(matureToken.mint)) {
          discoveredMints.add(matureToken.mint);
        }
      }

      // Enriquece mints descobertos (incluindo maturos da incubadora) em lotes de até 30 na DexScreener API
      const queuedMints = new Set(this.incubator.getAll().map(token => token.mint));
      for (const mint of this.enrichmentRetryAt.keys()) {
        if (!queuedMints.has(mint)) this.enrichmentRetryAt.delete(mint);
      }
      const mintsArray = Array.from(discoveredMints).filter(m =>
        this.cooldownCache.shouldProcess(m) && nowTs >= (this.enrichmentRetryAt.get(m) || 0)
      );
      if (mintsArray.length > 0) {
        const batchSize = 30;
        for (let i = 0; i < Math.min(mintsArray.length, 60); i += batchSize) {
          const chunkMints = mintsArray.slice(i, i + batchSize);
          let fetchedPairs: any[] = [];
          try {
            const tokensRes = await this.fetchClient(`https://api.dexscreener.com/latest/dex/tokens/${chunkMints.join(',')}`);
            fetchedPairs = extractPairs(tokensRes.data);
          } catch { upstreamFailures++; }
          // Lote vazio é upstream temporário, nunca veto técnico do mint.
          if (fetchedPairs.length === 0) {
            upstreamFailures++;
            if (chunkMints.length > 1) {
              // Limita concorrência para não serializar 30 timeouts nem disparar uma rajada sem limite.
              for (let offset = 0; offset < chunkMints.length; offset += 5) {
                const singles = await Promise.allSettled(chunkMints.slice(offset, offset + 5).map(mint =>
                  this.fetchClient(`https://api.dexscreener.com/latest/dex/tokens/${mint}`)
                ));
                for (const single of singles) {
                  if (single.status === 'fulfilled') fetchedPairs.push(...extractPairs(single.value.data));
                  else upstreamFailures++;
                }
              }
            }
          }
          rawPairs.push(...fetchedPairs);
          for (const mint of chunkMints) {
            const hasPairs = fetchedPairs.some(pair => pair?.baseToken?.address === mint && (!pair.chainId || pair.chainId === 'solana'));
            if (hasPairs) {
              this.incubator.remove(mint);
              this.enrichmentRetryAt.delete(mint);
            } else {
              this.enrichmentRetryAt.set(mint, this.now() + DexScreenerScanner.ENRICHMENT_BACKOFF_MS);
              console.warn(`[DEX_UPSTREAM_WAIT] ${mint}: pares ausentes; retentativa após 15000ms.`);
            }
          }
        }
      }

      // 3. Log de Diagnóstico: Tokens brutos extraídos antes dos filtros
      console.log(`📡 [Descoberta] ${rawPairs.length} tokens brutos extraídos de ${sourcesCount} fontes (${discoveredMints.size} mints únicos | Incubadora: ${incubatorSweep.waiting.length} aguardando, ${incubatorSweep.mature.length} maturos)`);

      this.lastIncubatorStats.upstreamFailures = upstreamFailures;
      this.lastIncubatorStats.retrying = this.enrichmentRetryAt.size;
      const now = this.now();
      const candidates: TokenCandidate[] = [];
      const seenMints = new Set<string>();
      const rejectedMints = new Set<string>();
      let technicalDiscards = 0;

      for (const item of rawPairs) {
        // Filtra estritamente tokens da rede Solana
        if (item.chainId && item.chainId.toLowerCase() !== 'solana') {
          continue;
        }

        const mint = item.baseToken?.address || item.tokenAddress;
        if (!mint || !this.cooldownCache.shouldProcess(mint)) {
          continue;
        }

        const rawLiquidity = item.liquidity?.usd;
        if (rawLiquidity == null || !Number.isFinite(Number(rawLiquidity)) || Number(rawLiquidity) < 0) {
          technicalDiscards++;
          console.log('[MARKET_DATA_WAIT] ' + mint + ' liquidity unavailable; not a confirmed zero');
          continue;
        }
        const liquidityUsd = Number(rawLiquidity);
        if (liquidityUsd < minLiquidityUsd) {
          technicalDiscards++;
          rejectedMints.add(mint);
          console.log(`🗑️ [Descarte Técnico] ${item.baseToken?.symbol || 'UNKNOWN'} (${mint}) | Motivo: Liq insuficiente | Liq: $${Math.round(liquidityUsd)} | m5: ${item.priceChange?.m5}% | B/S: ${item.txns?.m5?.buys}/${item.txns?.m5?.sells}`);
          continue;
        }

        const symbol = item.baseToken?.symbol;
        // Sanitização Estrita de Tokens (Fim do 'undefined'):
        if (!symbol || symbol === 'undefined' || symbol.trim() === '') {
          technicalDiscards++;
          rejectedMints.add(mint);
          console.log(`🗑️ [Descarte Técnico] ${symbol || 'UNKNOWN'} (${mint}) | Motivo: Symbol invalido | Liq: $${Math.round(liquidityUsd)} | m5: ${item.priceChange?.m5}% | B/S: ${item.txns?.m5?.buys}/${item.txns?.m5?.sells}`);
          continue;
        }

        if (seenMints.has(mint)) continue;


        const pairCreatedAt = Number(item.pairCreatedAt || 0);
        // Filtro de maturidade estrita da piscina: janela aceita entre 5 e 60 minutos
        if (pairCreatedAt > 0 && !this.isMaturityValid(pairCreatedAt, now)) {
          technicalDiscards++;
          rejectedMints.add(mint);
          console.log(`🗑️ [Descarte Técnico] ${symbol} (${mint}) | Motivo: Maturidade fora 5-60m | Liq: $${Math.round(liquidityUsd)} | m5: ${item.priceChange?.m5}% | B/S: ${item.txns?.m5?.buys}/${item.txns?.m5?.sells}`);
          continue;
        }

        // 1. Filtro de Variação de Preço nos Últimos 5 Minutos (m5): +3% a +85%
        const priceChangeM5 = item.priceChange?.m5 !== undefined ? Number(item.priceChange.m5) : undefined;
        if (priceChangeM5 !== undefined) {
          // VETO TÉCNICO IMEDIATO: Se priceChange.m5 < 3 ou > 85
          if (priceChangeM5 < 3 || priceChangeM5 > 85) {
            technicalDiscards++;
            console.log(`🗑️ [Descarte Técnico] ${symbol} (${mint}) | Motivo: m5 fora janela [${priceChangeM5}%] | Liq: $${Math.round(liquidityUsd)} | m5: ${priceChangeM5}% | B/S: ${item.txns?.m5?.buys}/${item.txns?.m5?.sells}`);
            continue;
          }
        }

        // 2. Dominância de Compradores (Order Flow: txns e volumes nos 5m)
        const buysM5 = item.txns?.m5?.buys !== undefined ? Number(item.txns.m5.buys) : undefined;
        const sellsM5 = item.txns?.m5?.sells !== undefined ? Number(item.txns.m5.sells) : undefined;
        if (buysM5 !== undefined && sellsM5 !== undefined && (buysM5 + sellsM5 > 0)) {
          // Paridade: buys >= sells * 1.0
          if (buysM5 < (sellsM5 * 1.0)) {
            technicalDiscards++;
            console.log(`🗑️ [Descarte Técnico] ${symbol} (${mint}) | Motivo: B/S insuficiente [${buysM5}/${sellsM5}] | Liq: $${Math.round(liquidityUsd)} | m5: ${priceChangeM5}% | B/S: ${buysM5}/${sellsM5}`);
            continue;
          }
        }

        // Volume comprador vs vendedor nos 5m (quando fornecido pela DexScreener)
        const volumeBuysM5 = item.volume?.m5?.buys !== undefined ? Number(item.volume.m5.buys) : undefined;
        const volumeSellsM5 = item.volume?.m5?.sells !== undefined ? Number(item.volume.m5.sells) : undefined;
        if (volumeBuysM5 !== undefined && volumeSellsM5 !== undefined && (volumeBuysM5 + volumeSellsM5 > 0)) {
          const buyVolRatio = volumeBuysM5 / (volumeBuysM5 + volumeSellsM5);
          if (buyVolRatio < 0.45) {
            technicalDiscards++;
            console.log(`🗑️ [Descarte Técnico] ${symbol} (${mint}) | Motivo: Vol comprador insuficiente [${(buyVolRatio * 100).toFixed(1)}%] | Liq: $${Math.round(liquidityUsd)} | m5: ${priceChangeM5}% | B/S: ${buysM5}/${sellsM5}`);
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

        // Filtro anti-faca caindo: preço atual deve ser >= 65% da máxima h1
        if (h1HighPriceUsd > 0 && (currentPriceUsd / h1HighPriceUsd) < 0.65) {
          technicalDiscards++;
          console.log(`🗑️ [Descarte Técnico] ${symbol} (${mint}) | Motivo: Faca caindo [${((currentPriceUsd / h1HighPriceUsd) * 100).toFixed(1)}% da max h1] | Liq: $${Math.round(liquidityUsd)} | m5: ${priceChangeM5}% | B/S: ${buysM5}/${sellsM5}`);
          continue;
        }

        // Validação complementar de agressão de fluxo se dados de txns estiverem presentes
        const buys = Number(item.txns?.h1?.buys || item.txns?.m5?.buys || 0);
        const sells = Number(item.txns?.h1?.sells || item.txns?.m5?.sells || 0);
        if (buys + sells >= 20 && !this.isBuyingAggressionValid(buys, sells)) {
          technicalDiscards++;
          console.log(`🗑️ [Descarte Técnico] ${symbol} (${mint}) | Motivo: Agressao compradora insuficiente [${((buys / (buys + sells)) * 100).toFixed(1)}%] | Liq: $${Math.round(liquidityUsd)} | m5: ${priceChangeM5}% | B/S: ${buysM5}/${sellsM5}`);
          continue;
        }

        seenMints.add(mint);
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
          h1HighPriceUsd,
          pairAddress: item.pairAddress ? String(item.pairAddress) : undefined
        });
      }

      for (const mint of rejectedMints) {
        if (!seenMints.has(mint)) this.cooldownCache.recordRejection(mint);
      }
      this.lastIncubatorStats.technicalDiscards = technicalDiscards;
      return candidates;
    } catch {
      return [];
    }
  }

  /**
   * Valida se a idade da pool está entre 5 e 60 minutos (pós-dump inicial).
   */
  public isMaturityValid(pairCreatedAt: number, now: number = Date.now()): boolean {
    if (!pairCreatedAt || pairCreatedAt <= 0) return false;
    const ageMs = now - pairCreatedAt;
    const minMaturityMs = 5 * 60 * 1000;       // Mínimo 5 minutos
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
    return buyRatio >= 0.50;
  }

  public async fetchCurrentTokenPriceUsd(mint: string): Promise<number | null> {
    const snapshot = await this.fetchCurrentTokenMarketSnapshot(mint);
    return snapshot ? snapshot.priceUsd : null;
  }

  /**
   * Snapshot de mercado usado pelo monitor de saída.
   * Uma única chamada ao endpoint /tokens traz preço, liquidez e fluxo recente;
   * isso evita consultar preço e liquidez separadamente e garante que o
   * SOLANA_LIQUIDITY_DRAIN compare a entrada com uma leitura atual.
   */
  public async fetchCurrentTokenMarketSnapshot(mint: string, preferredPairAddress?: string): Promise<TokenMarketSnapshot | null> {
    try {
      const res = await this.fetchClient(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
      const data = res.data;
      const pairs = Array.isArray(data) ? data : (data?.pairs || []);
      if (!Array.isArray(pairs) || pairs.length === 0) {
        return null;
      }

      // O endpoint pode devolver pares onde o mint aparece como quote token.
      // priceUsd refere-se ao base token, então preferimos estritamente pares
      // onde o mint monitorado é o base token para não contaminar o sensor.
      const solanaPairs = pairs.filter((pair: any) =>
        (!pair?.chainId || String(pair.chainId).toLowerCase() === 'solana')
      );
      const baseMatches = solanaPairs.filter((pair: any) =>
        String(pair?.baseToken?.address || '') === mint
      );
      const relevantPairs = baseMatches.length > 0 ? baseMatches : solanaPairs;
      if (relevantPairs.length === 0) return null;

      // Quando conhecemos a pool usada na entrada, mantemos a comparação de
      // liquidez na mesma pool. Se ela não estiver mais disponível, caímos para
      // a pool de maior liquidez apenas como referência de mercado.
      const preferred = preferredPairAddress
        ? relevantPairs.find((pair: any) => String(pair?.pairAddress || '') === preferredPairAddress)
        : undefined;
      const sortedPairs = [...relevantPairs].sort(
        (a, b) => Number(b?.liquidity?.usd || 0) - Number(a?.liquidity?.usd || 0)
      );
      const best = preferred || sortedPairs[0];
      const bestPrice = Number(best?.priceUsd || 0);
      if (!Number.isFinite(bestPrice) || bestPrice <= 0) return null;

      const rawSymbol = best?.baseToken?.symbol;
      const symbol = (rawSymbol && rawSymbol !== 'undefined' && rawSymbol.trim() !== '')
        ? rawSymbol
        : (mint.slice(0, 4) + '...' + mint.slice(-4));

      return {
        symbol,
        priceUsd: bestPrice,
        liquidityUsd: Number(best?.liquidity?.usd || 0),
        volume5mUsd: Number(best?.volume?.m5 || 0),
        buysM5: Number(best?.txns?.m5?.buys || 0),
        sellsM5: Number(best?.txns?.m5?.sells || 0),
        pairAddress: best?.pairAddress ? String(best.pairAddress) : undefined,
        dexId: best?.dexId ? String(best.dexId) : undefined,
        fetchedAt: Date.now()
      };
    } catch {
      return null;
    }
  }

  public async fetchTokenMetadata(mint: string): Promise<{ symbol: string; priceUsd: number } | null> {
    const snapshot = await this.fetchCurrentTokenMarketSnapshot(mint);
    return snapshot ? { symbol: snapshot.symbol, priceUsd: snapshot.priceUsd } : null;
  }
}
