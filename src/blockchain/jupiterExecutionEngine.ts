import axios from 'axios';
import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';
import { DexAggregatorService, SwapQuoteResult } from './dexAggregator.js';

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
}

export interface JupiterEngineConfig {
  rpcUrl?: string;
  isDryRun?: boolean;
  dexAggregator?: DexAggregatorService;
  connection?: Connection;
  confirmationTimeoutMs?: number;
  apiKey?: string;
  v2BaseUrl?: string;
  // Mantidos apenas para compatibilidade com configuração antiga.
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

  constructor(config: JupiterEngineConfig = {}) {
    this.connection = config.connection ||
      new Connection(config.rpcUrl || 'https://api.mainnet-beta.solana.com', 'confirmed');
    this.isDryRun = config.isDryRun !== undefined
      ? config.isDryRun
      : (process.env.DRY_RUN_MODE !== 'false');
    this.dexAggregator = config.dexAggregator || new DexAggregatorService();
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
    slippageBps = 400
  ) {
    return this.dexAggregator.getQuote({
      inputMint,
      outputMint,
      amountLamports,
      slippageBps
    });
  }

  private orderSlippage(req: SwapExecutionRequest): number | undefined {
    if (req.autoSlippage) return undefined;

    const requested = Math.floor(req.slippageBps ?? 400);
    if (!Number.isFinite(requested) || requested <= 0 || requested > MAX_SLIPPAGE_BPS) {
      throw new Error(
        `Jupiter V2: slippage inválido ${requested}bps; hard-cap=${MAX_SLIPPAGE_BPS}bps.`
      );
    }
    return requested;
  }

  private async getOrder(req: SwapExecutionRequest): Promise<JupiterV2OrderResponse> {
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

    await this.dexAggregator.waitForRateSlot();

    let response: any;
    try {
      response = await axios.get(`${this.v2BaseUrl}/order`, {
        params,
        timeout: 10_000,
        headers: { 'x-api-key': this.apiKey }
      });
    } catch (err: any) {
      const detail =
        err?.response?.data?.error ??
        err?.response?.data?.message ??
        err?.message ??
        String(err);
      throw new Error(
        `Jupiter V2 /order falhou: ${typeof detail === 'object' ? JSON.stringify(detail) : String(detail)}`
      );
    }

    const order = response.data as JupiterV2OrderResponse;
    if (!order?.requestId || !order?.transaction) {
      throw new Error(
        `Jupiter V2 /order sem transação: router=${order?.router || 'unknown'} ` +
        `code=${order?.errorCode ?? 'n/a'} message=${order?.errorMessage || 'n/a'}`
      );
    }

    const rtseSlippage = Number(order.slippageBps || 0);
    if (rtseSlippage > MAX_SLIPPAGE_BPS) {
      throw new Error(
        `Jupiter V2 RTSE excedeu hard-cap: ${rtseSlippage}bps > ${MAX_SLIPPAGE_BPS}bps.`
      );
    }

    console.log(
      `🧭 [Jupiter V2 /order] router=${order.router || 'unknown'} mode=${order.mode || 'unknown'} ` +
      `| slippage=${rtseSlippage}bps | fee=${order.feeBps ?? 'n/d'}bps | out=${order.outAmount}`
    );
    return order;
  }

  private signOrder(
    order: JupiterV2OrderResponse,
    req: SwapExecutionRequest
  ): { transaction: VersionedTransaction; signedTransaction: string } {
    if (!req.keypair) throw new Error('Keypair ausente para assinatura Jupiter V2.');

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

    // VersionedTransaction.sign permite assinatura parcial. Isso é necessário
    // para JupiterZ, onde o market maker adiciona outro signer no /execute.
    transaction.sign([req.keypair]);

    return {
      transaction,
      signedTransaction: Buffer.from(transaction.serialize()).toString('base64')
    };
  }

  private async simulateSignedTransaction(
    transaction: VersionedTransaction
  ): Promise<{ success: boolean; error?: string; unitsConsumed?: number }> {
    try {
      const simRes = await this.connection.simulateTransaction(transaction);
      if (simRes.value.err) {
        return {
          success: false,
          unitsConsumed: simRes.value.unitsConsumed,
          error: `Simulação pré-voo rejeitada: ${JSON.stringify(simRes.value.err)}`
        };
      }
      return {
        success: true,
        unitsConsumed: simRes.value.unitsConsumed
      };
    } catch (err: any) {
      return {
        success: false,
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
      const order = await this.getOrder(req);
      const { transaction } = this.signOrder(order, req);
      return await this.simulateSignedTransaction(transaction);
    } catch (err: any) {
      return {
        success: false,
        error: err?.message || String(err)
      };
    }
  }

  private async postExecute(payload: {
    signedTransaction: string;
    requestId: string;
    lastValidBlockHeight?: string | number;
  }): Promise<{ response?: JupiterV2ExecuteResponse; uncertainError?: string }> {
    let lastError: any;

    // Retry somente do MESMO requestId + MESMA transação assinada.
    // Nunca cria uma segunda ordem em caso de timeout.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await axios.post(
          `${this.v2BaseUrl}/execute`,
          payload,
          {
            timeout: this.executeTimeoutMs,
            headers: {
              'Content-Type': 'application/json',
              ...(this.apiKey ? { 'x-api-key': this.apiKey } : {})
            }
          }
        );
        return { response: response.data as JupiterV2ExecuteResponse };
      } catch (err: any) {
        lastError = err;
        const status = Number(err?.response?.status || 0);
        const body = err?.response?.data;

        if (body && (body.status === 'Success' || body.status === 'Failed')) {
          return { response: body as JupiterV2ExecuteResponse };
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
        `${typeof detail === 'object' ? JSON.stringify(detail) : String(detail)}`
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
          poolLiquidityUsd: req.poolLiquidityUsd
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
          slippageBps: quote.slippageBps
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
      const order = await this.getOrder(req);
      const { transaction, signedTransaction } = this.signOrder(order, req);

      let unitsConsumed: number | undefined;
      if (!req.skipPreflight) {
        const simulation = await this.simulateSignedTransaction(transaction);
        unitsConsumed = simulation.unitsConsumed;
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
            error: simulation.error
          };
        }
      }

      const payload = {
        signedTransaction,
        requestId: order.requestId,
        ...(order.lastValidBlockHeight
          ? { lastValidBlockHeight: order.lastValidBlockHeight }
          : {})
      };

      const executed = await this.postExecute(payload);

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
          error:
            `Jupiter V2 /execute falhou code=${result.code}: ` +
            `${result.error || 'sem detalhe'}`
        };
      }

      const actualInput = Number(
        result.totalInputAmount || result.inputAmountResult || order.inAmount || req.amountLamports
      );
      const actualOutput = Number(
        result.totalOutputAmount || result.outputAmountResult || 0
      );

      if (!Number.isFinite(actualOutput) || actualOutput <= 0) {
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
          error: 'Jupiter V2 retornou Success sem totalOutputAmount válido.'
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
        slippageBps: Number(order.slippageBps || 0)
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
}
