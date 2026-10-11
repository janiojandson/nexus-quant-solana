import { JupiterHubError, type JupiterOrgHub } from '../hubs/jupiterOrgHub.js';
import { hubWorkForPriority } from './jupiterPriorityPolicy.js';
import { getJupiterApiKeyPool, type JupiterApiKeyPool } from './jupiterApiKeyPool.js';
import axios from 'axios';
import {
  computeCollisionUsd,
  describeSlippageParams,
  HARD_CAP_SLIPPAGE_BPS
} from './slippageCalibration.js';
import {
  JupiterTrafficCoordinator,
  getGlobalJupiterTrafficCoordinator,
  type JupiterPriority
} from './jupiterTrafficCoordinator.js';

export interface SwapQuoteParams {
  /** Required for fee-bearing economics; omitting it is price/momentum only. */
  taker?: string;
  /** Bypass local cache for execution preflight samples. */
  freshQuote?: boolean;
  signal?: AbortSignal;
  inputMint: string;
  outputMint: string;
  amountLamports: number;
  slippageBps?: number;
  autoSlippage?: boolean;
  autoSlippageCollisionUsdValue?: number;
  maxAutoSlippageBps?: number;
  poolLiquidityUsd?: number | null;
  trafficPriority?: JupiterPriority;
}

export interface SwapQuoteResult {
  observedAtMs?: number;
  inputMint: string;
  outputMint: string;
  inAmount: number;
  outAmount: number;
  priceImpactPct: number;
  slippageBps: number;
  routePlanSummary: string;
  router?: string;
  mode?: string;
  requestId?: string;
  feeBps?: number;
  feeMint?: string;
  rawQuote?: any;
}

export interface DexAggregatorConfig {
  hub?: Pick<JupiterOrgHub,'request'>;
  apiKey?: string;
  rateLimitMs?: number;
  cacheTtlMs?: number;
  trafficCoordinator?: JupiterTrafficCoordinator;
}

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

/**
 * Cotação oficial Jupiter Swap API V2.
 *
 * /order sem taker funciona como price check: retorna preço/rota, mas não
 * retorna transação. Para autoSlippage=true não enviamos override de slippage,
 * deixando o RTSE V2 calcular a tolerância. O hard-cap de 750 bps continua
 * sendo validado na resposta.
 */
export class DexAggregatorService {
  private jupiterApiBaseUrl: string;
  private hub?: Pick<JupiterOrgHub,'request'>;
  private apiKey?: string;
  private apiKeys: JupiterApiKeyPool;
  private rateLimitMs: number;
  private cacheTtlMs: number;
  private trafficCoordinator: JupiterTrafficCoordinator;
  private quoteCache = new Map<string, { expiresAt: number; result: SwapQuoteResult }>();

  public static readonly MAX_ALLOWED_SLIPPAGE_BPS = HARD_CAP_SLIPPAGE_BPS;
  public static readonly MIN_SLIPPAGE_FLOOR_BPS = 250;

  constructor(
    jupiterApiBaseUrl = process.env.JUPITER_V2_BASE_URL || 'https://api.jup.ag/swap/v2',
    config: DexAggregatorConfig = {}
  ) {
    this.jupiterApiBaseUrl = jupiterApiBaseUrl.replace(/\/$/, '');
    this.hub = config.hub;
    this.apiKey = config.apiKey;
    this.apiKeys = getJupiterApiKeyPool(config.apiKey);
    const isTestEndpoint = /fake\.invalid/i.test(this.jupiterApiBaseUrl);
    const configuredRateLimitMs = config.rateLimitMs ??
      (isTestEndpoint ? 0 : Number(process.env.JUPITER_RATE_LIMIT_MS || (this.apiKeys.hasKeys() ? 1050 : 2100)));

    this.rateLimitMs = isTestEndpoint
      ? configuredRateLimitMs
      : (this.apiKeys.hasKeys() ? configuredRateLimitMs : Math.max(configuredRateLimitMs, 2100));
    this.trafficCoordinator = config.trafficCoordinator ??
      ((isTestEndpoint || config.rateLimitMs !== undefined)
        ? new JupiterTrafficCoordinator({ generalIntervalMs: this.rateLimitMs, executeIntervalMs: 0 })
        : getGlobalJupiterTrafficCoordinator());
    this.cacheTtlMs = config.cacheTtlMs ??
      (isTestEndpoint ? 0 : Number(process.env.JUPITER_QUOTE_CACHE_TTL_MS || 750));
  }

  public getBaseUrl(): string {
    return this.jupiterApiBaseUrl;
  }

  public getTrafficCoordinator(): JupiterTrafficCoordinator {
    return this.trafficCoordinator;
  }

  public async waitForRateSlot(priority: JupiterPriority = 5): Promise<void> {
    hubWorkForPriority(priority); // Hub admission occurs at request time.
  }

  private resolveRequestedSlippage(params: SwapQuoteParams): number {
    const maxAuto = params.maxAutoSlippageBps ?? DexAggregatorService.MAX_ALLOWED_SLIPPAGE_BPS;
    let effective = params.autoSlippage
      ? maxAuto
      : (params.slippageBps ?? 50);

    if (!params.autoSlippage && effective < DexAggregatorService.MIN_SLIPPAGE_FLOOR_BPS) {
      console.log(
        `⚠️ [Slippage Floor] Ajustando ${effective}bps para ` +
        `${DexAggregatorService.MIN_SLIPPAGE_FLOOR_BPS}bps.`
      );
      effective = DexAggregatorService.MIN_SLIPPAGE_FLOOR_BPS;
    }

    if (effective > DexAggregatorService.MAX_ALLOWED_SLIPPAGE_BPS) {
      throw new JupiterQuoteException(
        `Slippage maximo excedido (${effective} bps). Teto seguro: ` +
        `${DexAggregatorService.MAX_ALLOWED_SLIPPAGE_BPS} bps.`
      );
    }
    return effective;
  }

  public async getQuote(params: SwapQuoteParams): Promise<SwapQuoteResult> {
    const work = hubWorkForPriority(params.trafficPriority ?? 5);
    const requestedSlippageBps = this.resolveRequestedSlippage(params);

    const queryParams: Record<string, string | number> = {
      inputMint: params.inputMint,
      outputMint: params.outputMint,
      amount: String(params.amountLamports)
    };
    if (params.taker) queryParams.taker = params.taker;

    if (params.autoSlippage) {
      // Swap V2 /order aplica RTSE automaticamente quando não há override.
      const collisionUsd =
        params.autoSlippageCollisionUsdValue ?? computeCollisionUsd(params.poolLiquidityUsd);
      console.log(
        describeSlippageParams({
          sizeSol: params.amountLamports / 1e9,
          collisionUsd,
          poolLiquidityUsd: params.poolLiquidityUsd,
          maxAutoSlippageBps: requestedSlippageBps
        }) + ' | V2 RTSE'
      );
    } else {
      queryParams.slippageBps = requestedSlippageBps;
    }

    const cacheKey = JSON.stringify({work, queryParams, slippageCapBps: requestedSlippageBps});
    const cached = this.quoteCache.get(cacheKey);
    if (!params.freshQuote && cached && cached.expiresAt > Date.now()) return cached.result;
    if (cached) this.quoteCache.delete(cacheKey);

    let data: any;
    try {
      if (!this.hub) throw new Error('Jupiter hub required');
      data = (await this.hub.request(work, '/swap/v2/order', queryParams)).body;
    } catch (error) {
      throw new JupiterQuoteException('Falha na cotação Jupiter V2: hub request failed', error instanceof JupiterHubError ? error.status : undefined);
    }
    if (!data || data.inAmount === undefined || data.outAmount === undefined) {
      throw new JupiterQuoteException(
        'Resposta inválida da Jupiter V2 /order: inAmount/outAmount ausentes.'
      );
    }

    const returnedSlippageBps = data.slippageBps == null ? NaN : Number(data.slippageBps);
    if (!Number.isInteger(returnedSlippageBps) || returnedSlippageBps < 0) {
      throw new JupiterQuoteException('Jupiter V2: invalid quote slippage');
    }
    if (returnedSlippageBps > requestedSlippageBps && params.autoSlippage) {
      return this.getQuote({ ...params, autoSlippage: false, slippageBps: requestedSlippageBps });
    }
    if (returnedSlippageBps > requestedSlippageBps) {
      throw new JupiterQuoteException(
        `RTSE Jupiter V2 excedeu hard-cap: ${returnedSlippageBps}bps > ` +
        `${requestedSlippageBps}bps.`
      );
    }

    const priceImpactFromPercent = Number(data.priceImpactPct || 0) * 100;
    const priceImpactPct = data.priceImpact != null && Number.isFinite(Number(data.priceImpact))
      ? Number(data.priceImpact)
      : priceImpactFromPercent;

    const result: SwapQuoteResult = {
      observedAtMs: Date.now(),
      inputMint: params.inputMint,
      outputMint: params.outputMint,
      inAmount: Number(data.inAmount),
      outAmount: Number(data.outAmount),
      priceImpactPct: Number.isFinite(priceImpactPct) ? priceImpactPct : 0,
      slippageBps: returnedSlippageBps,
      routePlanSummary:
        data.routePlan?.map((r: any) => r?.swapInfo?.label).filter(Boolean).join(' -> ') ||
        data.router ||
        'Direct',
      router: data.router ? String(data.router) : undefined,
      mode: data.mode ? String(data.mode) : undefined,
      requestId: data.requestId ? String(data.requestId) : undefined,
      feeBps: Number.isFinite(Number(data.feeBps)) ? Number(data.feeBps) : undefined,
      feeMint: data.feeMint ? String(data.feeMint) : undefined,
      rawQuote: data
    };

    console.log(
      `📊 [Jupiter V2 Order] router=${result.router || 'unknown'} mode=${result.mode || 'unknown'} ` +
      `| RTSE/Slippage=${result.slippageBps}bps | Price Impact=${result.priceImpactPct.toFixed(3)}% ` +
      `| Rota=${result.routePlanSummary}`
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
