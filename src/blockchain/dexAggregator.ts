import axios from 'axios';
import {
  computeCollisionUsd,
  describeSlippageParams,
  HARD_CAP_SLIPPAGE_BPS
} from './slippageCalibration.js';

export interface SwapQuoteParams {
  inputMint: string;
  outputMint: string;
  amountLamports: number;
  slippageBps?: number;
  autoSlippage?: boolean;
  autoSlippageCollisionUsdValue?: number;
  maxAutoSlippageBps?: number;
  /** Liquidez real da pool em USD. Baseia a calibracao dinamica da colisao. */
  poolLiquidityUsd?: number | null;
}

export interface SwapQuoteResult {
  inputMint: string;
  outputMint: string;
  inAmount: number;
  outAmount: number;
  priceImpactPct: number;
  slippageBps: number;
  routePlanSummary: string;
  rawQuote?: any;
}

export interface DexAggregatorConfig {
  apiKey?: string;
  rateLimitMs?: number;
  cacheTtlMs?: number;
}

/**
 * Erro explícito de falha na camada de cotação (política Fail-Closed).
 *
 * Existe para impedir que qualquer falha de rede, rate-limit (429) ou resposta
 * malformada da Jupiter seja silenciosamente convertida em cotação. Sem esta
 * excecao, o motor executaria ordens com `outAmount` inventado.
 */
export class JupiterQuoteException extends Error {
  public readonly status?: number;
  public readonly cause?: unknown;

  constructor(message: string, status?: number, cause?: unknown) {
    super(message);
    this.name = 'JupiterQuoteException';
    this.status = status;
    this.cause = cause;
  }
}

export class DexAggregatorService {
  private jupiterApiBaseUrl: string;
  private apiKey?: string;
  private rateLimitMs: number;
  private cacheTtlMs: number;
  private lastRequestStartedAt = 0;
  private requestQueue: Promise<void> = Promise.resolve();
  private quoteCache = new Map<string, { expiresAt: number; result: SwapQuoteResult }>();
  public static readonly MAX_ALLOWED_SLIPPAGE_BPS = HARD_CAP_SLIPPAGE_BPS; // 750 bps (7.5%)
  public static readonly MIN_SLIPPAGE_FLOOR_BPS = 250; // 250 bps (2.5%) - Piso para memecoins de alta velocidade

  constructor(
    jupiterApiBaseUrl = process.env.JUPITER_API_URL || 'https://api.jup.ag/swap/v1',
    config: DexAggregatorConfig = {}
  ) {
    this.jupiterApiBaseUrl = jupiterApiBaseUrl.replace(/\/$/, '');
    this.apiKey = config.apiKey ?? process.env.JUPITER_API_KEY;
    const isTestEndpoint = /fake\.invalid/i.test(this.jupiterApiBaseUrl);
    const configuredRateLimitMs = config.rateLimitMs ??
      (isTestEndpoint ? 0 : Number(process.env.JUPITER_RATE_LIMIT_MS || (this.apiKey ? 1050 : 2100)));
    // Keyless Jupiter opera em ~0,5 RPS. Mesmo que uma variável antiga tenha
    // 1050ms, nunca excedemos esse teto quando não há API key.
    this.rateLimitMs = isTestEndpoint
      ? configuredRateLimitMs
      : (this.apiKey ? configuredRateLimitMs : Math.max(configuredRateLimitMs, 2100));
    this.cacheTtlMs = config.cacheTtlMs ??
      (isTestEndpoint ? 0 : Number(process.env.JUPITER_QUOTE_CACHE_TTL_MS || 750));
  }

  public async waitForRateSlot(): Promise<void> {
    let release!: () => void;
    const previous = this.requestQueue;
    this.requestQueue = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try {
      const elapsed = Date.now() - this.lastRequestStartedAt;
      const waitMs = Math.max(0, this.rateLimitMs - elapsed);
      if (waitMs > 0) await new Promise(resolve => setTimeout(resolve, waitMs));
      this.lastRequestStartedAt = Date.now();
    } finally {
      release();
    }
  }

  public async getQuote(params: SwapQuoteParams): Promise<SwapQuoteResult> {
    const slippageBps = params.slippageBps ?? 50; // Padrão 0.5%
    const maxAutoSlippageBps = params.maxAutoSlippageBps ?? DexAggregatorService.MAX_ALLOWED_SLIPPAGE_BPS;

    // CORREÇÃO ERRO 6014: Piso de slippage para proteger contra oscilações de bloco
    // Em memecoins com alta velocidade (ex: 571 buys em 5min), o preço oscila 0,5-1,5%
    // por bloco. Slippage < 250 bps causa rejeição espúria (Custom: 6014).
    const slippageFloor = DexAggregatorService.MIN_SLIPPAGE_FLOOR_BPS;
    
    // Teto anti-MEV aplicado em AMBOS os modos. A validacao anterior apenas
    // cobria o caminho com slippage explícito, deixando as compras
    // (autoSlippage=true) sem nenhuma protecao.
    let effectiveSlippageBps = params.autoSlippage ? maxAutoSlippageBps : slippageBps;
    
    // Aplica o piso: nunca permite slippage abaixo de 250 bps
    if (effectiveSlippageBps < slippageFloor) {
      console.log(`⚠️ [Slippage Floor] Ajustando slippage de ${effectiveSlippageBps} bps para piso mínimo de ${slippageFloor} bps (proteção contra erro 6014)`);
      effectiveSlippageBps = slippageFloor;
    }
    
    if (effectiveSlippageBps > DexAggregatorService.MAX_ALLOWED_SLIPPAGE_BPS) {
      throw new JupiterQuoteException(
        `Slippage maximo excedido (${effectiveSlippageBps} bps). Teto seguro contra sandwich MEV e ${DexAggregatorService.MAX_ALLOWED_SLIPPAGE_BPS} bps.`
      );
    }

    const queryParams: Record<string, any> = {
      inputMint: params.inputMint,
      outputMint: params.outputMint,
      amount: params.amountLamports,
      instructionVersion: 'V2'
    };

    if (params.autoSlippage) {
      // Colisao dinamica. O valor fixo de 1000 USD dimensionava o slippage
      // como se fosse um negocio grande, o que em pool rasa (15k-100k) gerava
      // erro 6014 (SlippageExceeded) falso positivo em quase toda entrada.
      const collisionUsd =
        params.autoSlippageCollisionUsdValue ?? computeCollisionUsd(params.poolLiquidityUsd);
      queryParams.autoSlippage = true;
      queryParams.autoSlippageCollisionUsdValue = collisionUsd;
      queryParams.maxAutoSlippageBps = effectiveSlippageBps; // Usa o valor após aplicar piso
      console.log(
        describeSlippageParams({
          sizeSol: params.amountLamports / 1e9,
          collisionUsd,
          poolLiquidityUsd: params.poolLiquidityUsd,
          maxAutoSlippageBps: effectiveSlippageBps
        })
      );
    } else {
      queryParams.slippageBps = effectiveSlippageBps; // Usa o valor após aplicar piso
    }

    const cacheKey = JSON.stringify(queryParams);
    const cached = this.quoteCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.result;
    }
    if (cached) this.quoteCache.delete(cacheKey);

    let response;
    let lastError: any;
    for (let attempt = 0; attempt < 2; attempt++) {
      await this.waitForRateSlot();
      try {
        response = await axios.get(`${this.jupiterApiBaseUrl}/quote`, {
          params: queryParams,
          timeout: 5000,
          headers: this.apiKey ? { 'x-api-key': this.apiKey } : undefined
        });
        break;
      } catch (err: any) {
        lastError = err;
        const status = err?.response?.status;

        if (status === 429 && attempt === 0) {
          const retryAfterHeader = Number(err?.response?.headers?.['retry-after'] || 0);
          const configuredBackoff = /fake\.invalid/i.test(this.jupiterApiBaseUrl)
            ? 0
            : Number(process.env.JUPITER_429_BACKOFF_MS || 1200);
          const waitMs = retryAfterHeader > 0
            ? retryAfterHeader * 1000
            : configuredBackoff;
          console.warn(`[Jupiter 429] Rate limit atingido; retry único em ${waitMs}ms.`);
          if (waitMs > 0) await new Promise(resolve => setTimeout(resolve, waitMs));
          continue;
        }

        break;
      }
    }

    if (!response) {
      // Fail-Closed: após no máximo um retry em 429, a operação é abortada.
      const status = lastError?.response?.status;
      const detail = lastError?.response?.data?.error || lastError?.message || String(lastError);
      console.error(
        `[JupiterQuoteException] Falha ao cotar ${params.inputMint} -> ${params.outputMint} (${params.amountLamports} lamports): ${detail}`
      );
      throw new JupiterQuoteException(
        `Falha na cotação Jupiter (${status ?? 'sem status'}): ${typeof detail === 'object' ? JSON.stringify(detail) : String(detail)}`,
        status,
        lastError
      );
    }

    const data = response?.data;

    // Validacao de integridade: resposta sem par in/out e cotação inutilizavel.
    if (!data || data.inAmount === undefined || data.outAmount === undefined) {
      console.error('[JupiterQuoteException] Resposta da Jupiter sem inAmount/outAmount:', JSON.stringify(data));
      throw new JupiterQuoteException('Resposta inválida da Jupiter: inAmount/outAmount ausentes.');
    }

    const result = {
      inputMint: params.inputMint,
      outputMint: params.outputMint,
      inAmount: Number(data.inAmount),
      outAmount: Number(data.outAmount),
      // Jupiter documenta priceImpactPct como fração decimal (0.01 = 1%).
      priceImpactPct: Number(data.priceImpactPct || 0) * 100,
      slippageBps: params.autoSlippage ? effectiveSlippageBps : effectiveSlippageBps,
      routePlanSummary:
        data.routePlan?.map((r: { swapInfo: { label: string } }) => r.swapInfo?.label).join(' -> ') || 'Direct',
      rawQuote: data
    };

    // Log do slippage efetivo usado (diagnóstico de erro 6014)
    console.log(
      `📊 [JupiterQuote] Slippage configurado: ${result.slippageBps} bps | Price Impact: ${result.priceImpactPct.toFixed(3)}% | Rota: ${result.routePlanSummary}`
    );

    if (this.cacheTtlMs > 0) {
      this.quoteCache.set(cacheKey, {
        expiresAt: Date.now() + this.cacheTtlMs,
        result
      });
    }

    return result;
  }
}
