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
import {
  nowMonotonicNs,
  diffMonotonicMs,
  nowWallMs,
  type TelemetrySpan
} from '../types/telemetry.js';
import { globalTelemetryBuffer } from '../telemetry/telemetryBuffer.js';

export interface SwapQuoteParams {
  inputMint: string;
  outputMint: string;
  amountLamports: number;
  slippageBps?: number;
  autoSlippage?: boolean;
  autoSlippageCollisionUsdValue?: number;
  maxAutoSlippageBps?: number;
  poolLiquidityUsd?: number | null;
  trafficPriority?: JupiterPriority;
  traceId?: string;
  operationType?: string;
}

export interface SwapQuoteResult {
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
  quoteSource?: 'CACHE' | 'NETWORK';
  timingProfile?: {
    quoteHttpMs: number;
    quoteParseMs: number;
    quoteTotalMs: number;
    quoteSource: 'CACHE' | 'NETWORK';
  };
}

export interface DexAggregatorConfig {
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
 * Cotação oficial Jupiter Swap API V2 instrumentada para V2.0.
 *
 * /order sem taker funciona como price check: retorna preço/rota, mas não
 * retorna transação. Para autoSlippage=true não enviamos override de slippage,
 * deixando o RTSE V2 calcular a tolerância. O hard-cap de 750 bps continua
 * sendo validado na resposta.
 */
export class DexAggregatorService {
  private jupiterApiBaseUrl: string;
  private apiKey?: string;
  private rateLimitMs: number;
  private cacheTtlMs: number;
  private trafficCoordinator: JupiterTrafficCoordinator;
  private quoteCache = new Map<string, { cachedAt: number; expiresAt: number; result: SwapQuoteResult }>();

  public static readonly MAX_ALLOWED_SLIPPAGE_BPS = HARD_CAP_SLIPPAGE_BPS;
  public static readonly MIN_SLIPPAGE_FLOOR_BPS = 250;

  constructor(
    jupiterApiBaseUrl = process.env.JUPITER_V2_BASE_URL || 'https://api.jup.ag/swap/v2',
    config: DexAggregatorConfig = {}
  ) {
    this.jupiterApiBaseUrl = jupiterApiBaseUrl.replace(/\/$/, '');
    this.apiKey = config.apiKey ?? process.env.JUPITER_API_KEY;
    const isTestEndpoint = /fake\.invalid/i.test(this.jupiterApiBaseUrl);
    const configuredRateLimitMs = config.rateLimitMs ??
      (isTestEndpoint ? 0 : Number(process.env.JUPITER_RATE_LIMIT_MS || (this.apiKey ? 250 : 2100)));

    this.rateLimitMs = isTestEndpoint
      ? configuredRateLimitMs
      : (this.apiKey ? configuredRateLimitMs : Math.max(configuredRateLimitMs, 2100));
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
    await this.trafficCoordinator.schedule(priority, async () => undefined, 'general');
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
    const requestedSlippageBps = this.resolveRequestedSlippage(params);

    const queryParams: Record<string, string | number> = {
      inputMint: params.inputMint,
      outputMint: params.outputMint,
      amount: String(params.amountLamports)
    };

    if (params.autoSlippage) {
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

    const cacheKey = JSON.stringify({ queryParams, slippageCapBps: requestedSlippageBps });
    const cached = this.quoteCache.get(cacheKey);

    // 1. Distinguir CACHE HIT de NETWORK REQUEST
    if (cached && cached.expiresAt > Date.now()) {
      const cacheAgeMs = Date.now() - cached.cachedAt;
      this.emitQuoteTelemetry({
        traceId: params.traceId,
        operationType: params.operationType || 'quote',
        quoteSource: 'CACHE',
        cacheHit: true,
        cacheAgeMs,
        durationMs: 0,
        status: 'SUCCESS',
        attemptNumber: 1
      });
      return {
        ...cached.result,
        quoteSource: 'CACHE',
        timingProfile: {
          quoteHttpMs: 0,
          quoteParseMs: 0,
          quoteTotalMs: 0,
          quoteSource: 'CACHE'
        }
      };
    }
    if (cached) this.quoteCache.delete(cacheKey);

    let response: any;
    let lastError: any;
    let successfulAttempt = 1;
    let successfulHttpMs = 0;
    let successfulParseMs = 0;

    for (let attempt = 0; attempt < 2; attempt++) {
      const requestStartedMonoNs = nowMonotonicNs();
      try {
        response = await this.trafficCoordinator.schedule(
          params.trafficPriority ?? 5,
          () => axios.get(`${this.jupiterApiBaseUrl}/order`, {
            params: queryParams,
            timeout: 8000,
            headers: this.apiKey ? { 'x-api-key': this.apiKey } : undefined
          }),
          'general',
          { traceId: params.traceId, operationType: params.operationType || 'quote' }
        );

        const responseReceivedMonoNs = nowMonotonicNs();
        successfulAttempt = attempt + 1;
        successfulHttpMs = diffMonotonicMs(requestStartedMonoNs, responseReceivedMonoNs);
        break;
      } catch (err: any) {
        lastError = err;
        const responseReceivedMonoNs = nowMonotonicNs();
        const attemptHttpMs = diffMonotonicMs(requestStartedMonoNs, responseReceivedMonoNs);
        const status = err?.response?.status;
        const isTimeout = Boolean(err?.code === 'ECONNABORTED' || String(err?.message || '').toLowerCase().includes('timeout'));

        this.emitQuoteTelemetry({
          traceId: params.traceId,
          operationType: params.operationType || 'quote',
          quoteSource: 'NETWORK',
          cacheHit: false,
          durationMs: attemptHttpMs,
          status: 'ERROR',
          httpStatus: status,
          attemptNumber: attempt + 1,
          timedOut: isTimeout,
          errorClass: err?.name || 'AxiosError'
        });

        if (status === 429 && attempt === 0) {
          const retryAfterHeader = Number(err?.response?.headers?.['retry-after'] || 0);
          const configuredBackoff = /fake\.invalid/i.test(this.jupiterApiBaseUrl)
            ? 0
            : Number(process.env.JUPITER_429_BACKOFF_MS || 1200);
          const waitMs = retryAfterHeader > 0
            ? retryAfterHeader * 1000
            : configuredBackoff;
          console.warn(`[Jupiter V2 429] retry único em ${waitMs}ms.`);
          if (waitMs > 0) await new Promise(resolve => setTimeout(resolve, waitMs));
          continue;
        }
        break;
      }
    }

    if (!response) {
      const status = lastError?.response?.status;
      const detail =
        lastError?.response?.data?.error ??
        lastError?.response?.data?.message ??
        lastError?.message ??
        String(lastError);

      throw new JupiterQuoteException(
        `Falha na cotação Jupiter V2 (${status ?? 'sem status'}): ` +
        `${typeof detail === 'object' ? JSON.stringify(detail) : String(detail)}`,
        status,
        lastError
      );
    }

    const parseStartMonoNs = nowMonotonicNs();
    const data = response.data;
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

    const parseEndMonoNs = nowMonotonicNs();
    successfulParseMs = diffMonotonicMs(parseStartMonoNs, parseEndMonoNs);
    const quoteTotalMs = successfulHttpMs + successfulParseMs;

    const result: SwapQuoteResult = {
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
      rawQuote: data,
      quoteSource: 'NETWORK',
      timingProfile: {
        quoteHttpMs: successfulHttpMs,
        quoteParseMs: successfulParseMs,
        quoteTotalMs,
        quoteSource: 'NETWORK'
      }
    };

    console.log(
      `📊 [Jupiter V2 Order] router=${result.router || 'unknown'} mode=${result.mode || 'unknown'} ` +
      `| RTSE/Slippage=${result.slippageBps}bps | Price Impact=${result.priceImpactPct.toFixed(3)}% ` +
      `| Rota=${result.routePlanSummary}`
    );

    this.emitQuoteTelemetry({
      traceId: params.traceId,
      operationType: params.operationType || 'quote',
      quoteSource: 'NETWORK',
      cacheHit: false,
      durationMs: quoteTotalMs,
      status: 'SUCCESS',
      httpStatus: 200,
      attemptNumber: successfulAttempt,
      quoteHttpMs: successfulHttpMs,
      quoteParseMs: successfulParseMs,
      quoteTotalMs,
      slippageBps: returnedSlippageBps,
      requestId: result.requestId,
      router: result.router,
      mode: result.mode
    });

    if (this.cacheTtlMs > 0) {
      this.quoteCache.set(cacheKey, {
        cachedAt: Date.now(),
        expiresAt: Date.now() + this.cacheTtlMs,
        result
      });
    }

    return result;
  }

  private emitQuoteTelemetry(metadata: {
    traceId?: string;
    operationType: string;
    quoteSource: 'CACHE' | 'NETWORK';
    cacheHit: boolean;
    cacheAgeMs?: number;
    durationMs: number;
    status: 'SUCCESS' | 'ERROR';
    httpStatus?: number;
    attemptNumber: number;
    timedOut?: boolean;
    errorClass?: string;
    quoteHttpMs?: number;
    quoteParseMs?: number;
    quoteTotalMs?: number;
    slippageBps?: number;
    requestId?: string;
    router?: string;
    mode?: string;
  }): void {
    try {
      const traceId = metadata.traceId || `quote_${Date.now()}`;
      const span: TelemetrySpan = {
        id: `span_quote_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        traceId,
        spanName: 'jupiter_quote',
        providerAlias: 'JUPITER',
        durationMs: metadata.durationMs,
        status: metadata.status,
        createdAtWallMs: nowWallMs(),
        metadata: {
          operationType: metadata.operationType,
          quoteSource: metadata.quoteSource,
          cacheHit: metadata.cacheHit,
          cacheAgeMs: metadata.cacheAgeMs,
          httpStatus: metadata.httpStatus,
          attemptNumber: metadata.attemptNumber,
          timedOut: metadata.timedOut,
          errorClass: metadata.errorClass,
          quoteHttpMs: metadata.quoteHttpMs,
          quoteParseMs: metadata.quoteParseMs,
          quoteTotalMs: metadata.quoteTotalMs,
          slippageBps: metadata.slippageBps,
          requestId: metadata.requestId,
          router: metadata.router,
          mode: metadata.mode
        }
      };
      globalTelemetryBuffer.push(span);
    } catch {
      // Non-blocking: never allow telemetry to fail quotes
    }
  }
}
