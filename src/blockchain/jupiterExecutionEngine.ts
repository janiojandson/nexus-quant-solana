import axios from 'axios';
import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';
import { DexAggregatorService, SwapQuoteResult } from './dexAggregator.js';
import {
  JupiterTrafficCoordinator,
  type JupiterPriority
} from './jupiterTrafficCoordinator.js';
import {
  nowMonotonicNs,
  diffMonotonicMs,
  nowWallMs,
  type TelemetrySpan
} from '../types/telemetry.js';
import { globalTelemetryBuffer } from '../telemetry/telemetryBuffer.js';

const MAX_SLIPPAGE_BPS = 750;

export interface SwapExecutionRequest {
  inputMint: string;
  outputMint: string;
  amountLamports: number;
  userPublicKey: string;
  keypair?: Keypair;
  /** Compra: RTSE V2 quando autoSlippage=true. Saída: 500/750bps explícitos. */
  slippageBps?: number;
  priorityLevel?: 'low' | 'medium' | 'high' | 'veryHigh';
  autoSlippage?: boolean;
  autoSlippageCollisionUsdValue?: number;
  maxAutoSlippageBps?: number;
  poolLiquidityUsd?: number | null;
  /** Mantido por compatibilidade. V2 /execute gerencia o landing. */
  skipPreflight?: boolean;
  maxPriorityFeeLamports?: number;
  trafficPriority?: JupiterPriority;
  traceId?: string;
  tradeId?: string;
  positionId?: string;
  decisionId?: string;
}

export interface SwapExecutionResponse {
  txSignature: string;
  status: 'SUCCESS' | 'DRY_RUN_SUCCESS' | 'FAILED' | 'SUBMITTED_UNCONFIRMED';
  inAmount: number;
  outAmount: number;
  isDryRun: boolean;
  error?: string;
  unitsConsumed?: number;
  executionPath: 'V2_META_AGGREGATOR';
  router?: string;
  requestId?: string;
  feeBps?: number;
  feeMint?: string;
  slippageBps?: number;
  timingProfile?: {
    orderHttpMs?: number;
    localSignMs?: number;
    simulationMs?: number;
    executeHttpMs?: number;
  };
}

export interface JupiterEngineConfig {
  rpcUrl?: string;
  isDryRun?: boolean;
  dexAggregator?: DexAggregatorService;
  connection?: Connection;
  confirmationTimeoutMs?: number;
  apiKey?: string;
  v2BaseUrl?: string;
  trafficCoordinator?: JupiterTrafficCoordinator;
  buyMaxPriorityFeeLamports?: number;
  sellMaxPriorityFeeLamports?: number;
}

interface JupiterV2OrderResponse {
  transaction: string | null;
  requestId: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold?: string;
  slippageBps?: number;
  priceImpactPct?: string;
  priceImpact?: number;
  routePlan?: any[];
  router: string;
  mode: string;
  feeBps?: number;
  feeMint?: string;
  errorCode?: number;
  errorMessage?: string;
  lastValidBlockHeight?: string | number;
  expireAt?: string;
}

interface JupiterV2ExecuteResponse {
  status: 'Success' | 'Failed';
  signature?: string;
  code: number;
  totalInputAmount?: string;
  totalOutputAmount?: string;
  inputAmountResult?: string;
  outputAmountResult?: string;
  error?: string;
}

export class JupiterExecutionEngine {
  private connection: Connection;
  private isDryRun: boolean;
  private dexAggregator: DexAggregatorService;
  private apiKey?: string;
  private v2BaseUrl: string;
  private executeTimeoutMs: number;
  private trafficCoordinator: JupiterTrafficCoordinator;

  constructor(config: JupiterEngineConfig = {}) {
    this.connection = config.connection ||
      new Connection(config.rpcUrl || 'https://api.mainnet-beta.solana.com', 'confirmed');
    this.isDryRun = config.isDryRun !== undefined
      ? config.isDryRun
      : (process.env.DRY_RUN_MODE !== 'false');
    this.dexAggregator = config.dexAggregator || new DexAggregatorService();
    this.trafficCoordinator = config.trafficCoordinator || this.dexAggregator.getTrafficCoordinator();
    this.apiKey = config.apiKey ?? process.env.JUPITER_API_KEY;
    this.v2BaseUrl = (
      config.v2BaseUrl ||
      process.env.JUPITER_V2_BASE_URL ||
      'https://api.jup.ag/swap/v2'
    ).replace(/\/$/, '');
    this.executeTimeoutMs = Math.max(
      20_000,
      config.confirmationTimeoutMs ?? Number(process.env.JUPITER_V2_EXECUTE_TIMEOUT_MS || 30_000)
    );
  }

  public getAggregator(): DexAggregatorService {
    return this.dexAggregator;
  }

  public getExecutionInfo() {
    return { version: 'V2' as const, baseUrl: this.v2BaseUrl, managedLanding: true, rtse: true };
  }

  public async getQuote(
    inputMint: string,
    outputMint: string,
    amountLamports: number,
    slippageBps = 400,
    trafficPriority: JupiterPriority = 3,
    traceId?: string
  ) {
    return this.dexAggregator.getQuote({
      inputMint,
      outputMint,
      amountLamports,
      slippageBps,
      trafficPriority,
      traceId
    });
  }

  private orderSlippage(req: SwapExecutionRequest): number | undefined {
    if (req.autoSlippage) {
      const cap = req.maxAutoSlippageBps ?? MAX_SLIPPAGE_BPS;
      if (!Number.isInteger(cap) || cap <= 0 || cap > MAX_SLIPPAGE_BPS) {
        throw new Error(`Jupiter V2: slippage cap invalid; hard-cap=${MAX_SLIPPAGE_BPS}bps.`);
      }
      return undefined;
    }

    const requested = Math.floor(req.slippageBps ?? 400);
    if (!Number.isFinite(requested) || requested <= 0 || requested > MAX_SLIPPAGE_BPS) {
      throw new Error(
        `Jupiter V2: slippage inválido ${requested}bps; hard-cap=${MAX_SLIPPAGE_BPS}bps.`
      );
    }
    return requested;
  }

  private async getOrder(req: SwapExecutionRequest): Promise<{ order: JupiterV2OrderResponse; orderHttpMs: number }> {
    if (!this.apiKey) {
      throw new Error('JUPITER_API_KEY ausente para Jupiter Swap API V2.');
    }

    const params: Record<string, string | number> = {
      inputMint: req.inputMint,
      outputMint: req.outputMint,
      amount: String(req.amountLamports),
      taker: req.userPublicKey
    };

    const slippageBps = this.orderSlippage(req);
    if (slippageBps !== undefined) params.slippageBps = slippageBps;

    let response: any;
    const orderStartMonoNs = nowMonotonicNs();

    try {
      response = await this.trafficCoordinator.schedule(
        req.trafficPriority ?? 4,
        () => axios.get(`${this.v2BaseUrl}/order`, {
          params,
          timeout: 10_000,
          headers: { 'x-api-key': this.apiKey }
        }),
        'general',
        { traceId: req.traceId, operationType: 'order' }
      );
    } catch (err: any) {
      const orderEndMonoNs = nowMonotonicNs();
      const orderElapsedMs = diffMonotonicMs(orderStartMonoNs, orderEndMonoNs);
      this.emitSpan({
        traceId: req.traceId,
        spanName: 'jupiter_order',
        durationMs: orderElapsedMs,
        status: 'ERROR',
        metadata: {
          requestedAmountAtomic: String(req.amountLamports),
          errorClass: err?.name || 'Error'
        }
      });

      const detail =
        err?.response?.data?.error ??
        err?.response?.data?.message ??
        err?.message ??
        String(err);
      throw new Error(
        `Jupiter V2 /order falhou: ${typeof detail === 'object' ? JSON.stringify(detail) : String(detail)}`
      );
    }

    const orderEndMonoNs = nowMonotonicNs();
    const orderHttpMs = diffMonotonicMs(orderStartMonoNs, orderEndMonoNs);

    const order = response.data as JupiterV2OrderResponse;
    if (!order?.requestId || !order?.transaction) {
      this.emitSpan({
        traceId: req.traceId,
        spanName: 'jupiter_order',
        durationMs: orderHttpMs,
        status: 'ERROR',
        metadata: {
          errorCode: order?.errorCode,
          errorMessage: order?.errorMessage
        }
      });
      throw new Error(
        `Jupiter V2 /order sem transação: router=${order?.router || 'unknown'} ` +
        `code=${order?.errorCode ?? 'n/a'} message=${order?.errorMessage || 'n/a'}`
      );
    }

    const rtseSlippage = order.slippageBps == null ? NaN : Number(order.slippageBps);
    const allowedSlippage = req.autoSlippage ? (req.maxAutoSlippageBps ?? MAX_SLIPPAGE_BPS) : slippageBps!;
    if (!Number.isInteger(rtseSlippage) || rtseSlippage < 0) throw new Error('Jupiter V2: invalid order slippage');
    if (rtseSlippage > allowedSlippage && req.autoSlippage) {
      console.warn(`[JUPITER_SLIPPAGE_REQUOTE] RTSE=${rtseSlippage}bps cap=${allowedSlippage}bps; requesting a new fixed-cap order`);
      return this.getOrder({ ...req, autoSlippage: false, slippageBps: allowedSlippage });
    }
    if (rtseSlippage > allowedSlippage) {
      throw new Error(
        `Jupiter V2 RTSE excedeu hard-cap: ${rtseSlippage}bps > ${allowedSlippage}bps.`
      );
    }

    // Telemetria da ordem sem expor a transação base64
    this.emitSpan({
      traceId: req.traceId,
      spanName: 'jupiter_order',
      durationMs: orderHttpMs,
      status: 'SUCCESS',
      metadata: {
        requestedAmountAtomic: String(req.amountLamports),
        expectedOutAtomic: order.outAmount,
        minimumOutAtomic: order.otherAmountThreshold,
        slippageBps: rtseSlippage,
        router: order.router,
        mode: order.mode,
        requestId: order.requestId
      }
    });

    console.log(
      `🧭 [Jupiter V2 /order] router=${order.router || 'unknown'} mode=${order.mode || 'unknown'} ` +
      `| slippage=${rtseSlippage}bps | fee=${order.feeBps ?? 'n/d'}bps | out=${order.outAmount}`
    );
    this.assertOrderNotExpired(order);
    return { order, orderHttpMs };
  }

  private assertOrderNotExpired(order: JupiterV2OrderResponse): void {
    if (order.expireAt == null) return;
    const expiresAt = Date.parse(order.expireAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      throw new Error('Jupiter V2: expired or invalid expireAt; obtain a fresh order before signing/submission.');
    }
  }

  private signOrder(
    order: JupiterV2OrderResponse,
    req: SwapExecutionRequest
  ): { transaction: VersionedTransaction; signedTransaction: string; localSignMs: number } {
    if (!req.keypair) throw new Error('Keypair ausente para assinatura Jupiter V2.');

    const signStartMonoNs = nowMonotonicNs();

    const transaction = VersionedTransaction.deserialize(
      Buffer.from(order.transaction as string, 'base64')
    );

    const requiredSigners = transaction.message.staticAccountKeys.slice(
      0,
      transaction.message.header.numRequiredSignatures
    );
    const walletSignerIndex = requiredSigners.findIndex(
      key => key.equals(req.keypair!.publicKey)
    );

    if (walletSignerIndex < 0) {
      throw new Error(
        `Assinatura rejeitada: wallet ${req.userPublicKey} não é signer da ordem Jupiter V2.`
      );
    }

    transaction.sign([req.keypair]);

    const signEndMonoNs = nowMonotonicNs();
    const localSignMs = diffMonotonicMs(signStartMonoNs, signEndMonoNs);

    // Medição local de assinatura (sem expor chave privada nem bytes assinados)
    this.emitSpan({
      traceId: req.traceId,
      spanName: 'local_sign',
      durationMs: localSignMs,
      status: 'SUCCESS',
      metadata: {
        wallet: req.userPublicKey
      }
    });

    return {
      transaction,
      signedTransaction: Buffer.from(transaction.serialize()).toString('base64'),
      localSignMs
    };
  }

  private async simulateSignedTransaction(
    transaction: VersionedTransaction,
    traceId?: string
  ): Promise<{ success: boolean; error?: string; unitsConsumed?: number; simulationMs: number }> {
    const simStartMonoNs = nowMonotonicNs();
    try {
      const simRes = await this.connection.simulateTransaction(transaction);
      const simEndMonoNs = nowMonotonicNs();
      const simulationMs = diffMonotonicMs(simStartMonoNs, simEndMonoNs);

      if (simRes.value.err) {
        this.emitSpan({
          traceId,
          spanName: 'solana_simulation',
          providerAlias: 'SOLANA_PUBLIC',
          durationMs: simulationMs,
          status: 'ERROR',
          metadata: {
            method: 'simulateTransaction',
            success: false,
            unitsConsumed: simRes.value.unitsConsumed,
            errorDetails: JSON.stringify(simRes.value.err)
          }
        });
        return {
          success: false,
          unitsConsumed: simRes.value.unitsConsumed,
          simulationMs,
          error: `Simulação pré-voo rejeitada: ${JSON.stringify(simRes.value.err)}`
        };
      }

      this.emitSpan({
        traceId,
        spanName: 'solana_simulation',
        providerAlias: 'SOLANA_PUBLIC',
        durationMs: simulationMs,
        status: 'SUCCESS',
        metadata: {
          method: 'simulateTransaction',
          success: true,
          unitsConsumed: simRes.value.unitsConsumed
        }
      });

      return {
        success: true,
        unitsConsumed: simRes.value.unitsConsumed,
        simulationMs
      };
    } catch (err: any) {
      const simEndMonoNs = nowMonotonicNs();
      const simulationMs = diffMonotonicMs(simStartMonoNs, simEndMonoNs);
      this.emitSpan({
        traceId,
        spanName: 'solana_simulation',
        providerAlias: 'SOLANA_PUBLIC',
        durationMs: simulationMs,
        status: 'ERROR',
        metadata: {
          method: 'simulateTransaction',
          success: false,
          errorDetails: err?.message || String(err)
        }
      });
      return {
        success: false,
        simulationMs,
        error: `Falha RPC na simulação V2: ${err?.message || err}`
      };
    }
  }

  public async simulateSwap(
    req: SwapExecutionRequest,
    _quoteOverride?: SwapQuoteResult
  ): Promise<{ success: boolean; error?: string; unitsConsumed?: number }> {
    try {
      if (!req.keypair) {
        return { success: false, error: 'Keypair ausente para simulação V2.' };
      }
      const { order } = await this.getOrder(req);
      const { transaction } = this.signOrder(order, req);
      const res = await this.simulateSignedTransaction(transaction, req.traceId);
      return { success: res.success, error: res.error, unitsConsumed: res.unitsConsumed };
    } catch (err: any) {
      return {
        success: false,
        error: err?.message || String(err)
      };
    }
  }

  private async postExecute(
    payload: {
      signedTransaction: string;
      requestId: string;
      lastValidBlockHeight?: string | number;
    },
    priority: JupiterPriority,
    traceId?: string
  ): Promise<{ response?: JupiterV2ExecuteResponse; uncertainError?: string; executeHttpMs: number }> {
    let lastError: any;
    let totalExecuteHttpMs = 0;

    for (let attempt = 0; attempt < 2; attempt++) {
      const execStartMonoNs = nowMonotonicNs();
      try {
        const response = await this.trafficCoordinator.schedule(
          priority,
          () => axios.post(
            `${this.v2BaseUrl}/execute`,
            payload,
            {
              timeout: this.executeTimeoutMs,
              headers: {
                'Content-Type': 'application/json',
                ...(this.apiKey ? { 'x-api-key': this.apiKey } : {})
              }
            }
          ),
          'execute',
          { traceId, operationType: 'execute' }
        );

        const execEndMonoNs = nowMonotonicNs();
        const executeHttpMs = diffMonotonicMs(execStartMonoNs, execEndMonoNs);
        totalExecuteHttpMs += executeHttpMs;

        const executeData = response.data as JupiterV2ExecuteResponse;

        this.emitSpan({
          traceId,
          spanName: 'jupiter_execute',
          providerAlias: 'JUPITER',
          durationMs: executeHttpMs,
          status: executeData.status === 'Success' ? 'SUCCESS' : 'ERROR',
          metadata: {
            stage: executeData.status === 'Success' ? 'PROVIDER_SUCCESS_RECEIPT' : 'EXECUTE_HTTP_RESPONSE',
            attemptNumber: attempt + 1,
            requestId: payload.requestId,
            code: executeData.code,
            signature: executeData.signature
          }
        });

        return { response: executeData, executeHttpMs: totalExecuteHttpMs };
      } catch (err: any) {
        lastError = err;
        const execEndMonoNs = nowMonotonicNs();
        const executeHttpMs = diffMonotonicMs(execStartMonoNs, execEndMonoNs);
        totalExecuteHttpMs += executeHttpMs;

        const status = Number(err?.response?.status || 0);
        const body = err?.response?.data;

        this.emitSpan({
          traceId,
          spanName: 'jupiter_execute',
          providerAlias: 'JUPITER',
          durationMs: executeHttpMs,
          status: 'ERROR',
          metadata: {
            stage: 'EXECUTE_HTTP_RESPONSE',
            attemptNumber: attempt + 1,
            requestId: payload.requestId,
            httpStatus: status,
            errorClass: err?.name || 'AxiosError'
          }
        });

        if (body && (body.status === 'Success' || body.status === 'Failed')) {
          return { response: body as JupiterV2ExecuteResponse, executeHttpMs: totalExecuteHttpMs };
        }

        const retryable = !status || status === 429 || status >= 500;
        if (!retryable || attempt === 1) break;

        const delayMs = status === 429 ? 1200 : 500;
        console.warn(
          `⚠️ [Jupiter V2 /execute] resposta incerta; repetindo MESMO requestId em ${delayMs}ms.`
        );
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }

    const detail =
      lastError?.response?.data?.error ??
      lastError?.response?.data?.message ??
      lastError?.message ??
      String(lastError);

    return {
      uncertainError:
        `/execute sem resposta conclusiva após retry idempotente: ` +
        `${typeof detail === 'object' ? JSON.stringify(detail) : String(detail)}`,
      executeHttpMs: totalExecuteHttpMs
    };
  }

  public async executeSwap(req: SwapExecutionRequest): Promise<SwapExecutionResponse> {
    if (this.isDryRun || !req.keypair) {
      try {
        const quote = await this.dexAggregator.getQuote({
          inputMint: req.inputMint,
          outputMint: req.outputMint,
          amountLamports: req.amountLamports,
          slippageBps: req.slippageBps ?? 400,
          autoSlippage: req.autoSlippage,
          maxAutoSlippageBps: req.maxAutoSlippageBps,
          poolLiquidityUsd: req.poolLiquidityUsd,
          trafficPriority: req.trafficPriority ?? 5,
          traceId: req.traceId
        });

        return {
          txSignature: `dry_run_v2_${Date.now()}_${Math.random().toString(36).slice(2)}`,
          status: 'DRY_RUN_SUCCESS',
          inAmount: quote.inAmount,
          outAmount: quote.outAmount,
          isDryRun: true,
          executionPath: 'V2_META_AGGREGATOR',
          router: quote.router,
          requestId: quote.requestId,
          feeBps: quote.feeBps,
          feeMint: quote.feeMint,
          slippageBps: quote.slippageBps,
          timingProfile: {
            quoteHttpMs: quote.timingProfile?.quoteHttpMs,
            quoteParseMs: quote.timingProfile?.quoteParseMs,
            quoteTotalMs: quote.timingProfile?.quoteTotalMs
          } as any
        };
      } catch (err: any) {
        return {
          txSignature: '',
          status: 'FAILED',
          inAmount: req.amountLamports,
          outAmount: 0,
          isDryRun: true,
          executionPath: 'V2_META_AGGREGATOR',
          error: err?.message || String(err)
        };
      }
    }

    try {
      const { order, orderHttpMs } = await this.getOrder(req);
      const { transaction, signedTransaction, localSignMs } = this.signOrder(order, req);

      let unitsConsumed: number | undefined;
      let simulationMs: number | undefined;

      if (!req.skipPreflight) {
        const simulation = await this.simulateSignedTransaction(transaction, req.traceId);
        unitsConsumed = simulation.unitsConsumed;
        simulationMs = simulation.simulationMs;

        if (!simulation.success) {
          console.warn(
            `🛑 [Jupiter V2:Preflight] transmissão cancelada: ${simulation.error}`
          );
          return {
            txSignature: '',
            status: 'FAILED',
            inAmount: req.amountLamports,
            outAmount: 0,
            isDryRun: false,
            unitsConsumed,
            executionPath: 'V2_META_AGGREGATOR',
            router: order.router,
            requestId: order.requestId,
            feeBps: order.feeBps,
            feeMint: order.feeMint,
            slippageBps: Number(order.slippageBps || 0),
            error: simulation.error,
            timingProfile: {
              orderHttpMs,
              localSignMs,
              simulationMs
            }
          };
        }
      }

      this.assertOrderNotExpired(order);
      const payload = {
        signedTransaction,
        requestId: order.requestId,
        ...(order.lastValidBlockHeight
          ? { lastValidBlockHeight: order.lastValidBlockHeight }
          : {})
      };

      const executed = await this.postExecute(payload, req.trafficPriority ?? 4, req.traceId);

      if (!executed.response) {
        return {
          txSignature: '',
          status: 'SUBMITTED_UNCONFIRMED',
          inAmount: req.amountLamports,
          outAmount: 0,
          isDryRun: false,
          unitsConsumed,
          executionPath: 'V2_META_AGGREGATOR',
          router: order.router,
          requestId: order.requestId,
          feeBps: order.feeBps,
          feeMint: order.feeMint,
          slippageBps: Number(order.slippageBps || 0),
          timingProfile: {
            orderHttpMs,
            localSignMs,
            simulationMs,
            executeHttpMs: executed.executeHttpMs
          },
          error:
            `${executed.uncertainError || 'Execução V2 inconclusiva'}. ` +
            'Não criar nova ordem até reconciliar o requestId/on-chain.'
        };
      }

      const result = executed.response;
      const signature = String(result.signature || '');

      if (result.status !== 'Success' || Number(result.code) !== 0) {
        return {
          txSignature: signature,
          status: 'FAILED',
          inAmount: Number(result.totalInputAmount || req.amountLamports),
          outAmount: 0,
          isDryRun: false,
          unitsConsumed,
          executionPath: 'V2_META_AGGREGATOR',
          router: order.router,
          requestId: order.requestId,
          feeBps: order.feeBps,
          feeMint: order.feeMint,
          slippageBps: Number(order.slippageBps || 0),
          timingProfile: {
            orderHttpMs,
            localSignMs,
            simulationMs,
            executeHttpMs: executed.executeHttpMs
          },
          error:
            `Jupiter V2 /execute falhou code=${result.code}: ` +
            `${result.error || 'sem detalhe'}`
        };
      }

      const actualInput = Number(result.totalInputAmount ?? NaN);
      const actualOutput = Number(result.totalOutputAmount ?? NaN);

      if (!signature || !Number.isSafeInteger(actualInput) || actualInput <= 0 || !Number.isSafeInteger(actualOutput) || actualOutput <= 0) {
        return {
          txSignature: signature,
          status: 'SUBMITTED_UNCONFIRMED',
          inAmount: Number.isFinite(actualInput) ? actualInput : req.amountLamports,
          outAmount: 0,
          isDryRun: false,
          unitsConsumed,
          executionPath: 'V2_META_AGGREGATOR',
          router: order.router,
          requestId: order.requestId,
          feeBps: order.feeBps,
          feeMint: order.feeMint,
          slippageBps: Number(order.slippageBps || 0),
          timingProfile: {
            orderHttpMs,
            localSignMs,
            simulationMs,
            executeHttpMs: executed.executeHttpMs
          },
          error: 'Jupiter V2 Success missing a valid signature or final wallet totals; reconcile before another order.'
        };
      }

      console.log(
        `✅ [Jupiter V2 /execute] router=${order.router} | tx=${signature} ` +
        `| inputReal=${actualInput} | outputReal=${actualOutput}`
      );

      return {
        txSignature: signature,
        status: 'SUCCESS',
        inAmount: Number.isFinite(actualInput) ? actualInput : req.amountLamports,
        outAmount: actualOutput,
        isDryRun: false,
        unitsConsumed,
        executionPath: 'V2_META_AGGREGATOR',
        router: order.router,
        requestId: order.requestId,
        feeBps: order.feeBps,
        feeMint: order.feeMint,
        slippageBps: Number(order.slippageBps || 0),
        timingProfile: {
          orderHttpMs,
          localSignMs,
          simulationMs,
          executeHttpMs: executed.executeHttpMs
        }
      };
    } catch (err: any) {
      console.error('❌ [JUPITER V2 ERROR]:', err?.message || err);
      return {
        txSignature: '',
        status: 'FAILED',
        inAmount: req.amountLamports,
        outAmount: 0,
        isDryRun: false,
        executionPath: 'V2_META_AGGREGATOR',
        error: err?.message || String(err)
      };
    }
  }

  private emitSpan(spanData: {
    traceId?: string;
    spanName: string;
    providerAlias?: 'JUPITER' | 'SOLANA_PUBLIC';
    durationMs: number;
    status: 'SUCCESS' | 'ERROR';
    metadata?: Record<string, unknown>;
  }): void {
    try {
      const traceId = spanData.traceId || `jup_${Date.now()}`;
      const span: TelemetrySpan = {
        id: `span_${spanData.spanName}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        traceId,
        spanName: spanData.spanName,
        providerAlias: spanData.providerAlias || 'JUPITER',
        durationMs: spanData.durationMs,
        status: spanData.status,
        createdAtWallMs: nowWallMs(),
        metadata: spanData.metadata
      };
      globalTelemetryBuffer.push(span);
    } catch {
      // Non-blocking: never allow telemetry to fail execution
    }
  }
}
