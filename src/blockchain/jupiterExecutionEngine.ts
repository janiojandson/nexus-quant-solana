import type { JupiterOrgHub } from '../hubs/jupiterOrgHub.js';
import { hubWorkForPriority } from './jupiterPriorityPolicy.js';
import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';
import { DexAggregatorService, SwapQuoteResult } from './dexAggregator.js';
import { referencesProgram } from '../execution/entryRoutePolicy.js';
import { resolveExecutionMode, type ExecutionEnvironment } from '../execution/executionMode.js';
import {
  JupiterTrafficCoordinator,
  type JupiterPriority
} from './jupiterTrafficCoordinator.js';

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
  /** Entry-only venue restriction; exits remain unrestricted unless requested. */
  forbiddenProgramIds?: readonly string[];
  /** Audited entry pool; every final order must reference it before signing. */
  requiredPoolAddress?: string;
}

export interface SwapExecutionResponse {
  txSignature: string;
  status: 'SUCCESS' | 'DRY_RUN_SUCCESS' | 'FAILED' | 'SUBMITTED_UNCONFIRMED';
  inAmount: number;
  outAmount: number;
  isDryRun: boolean;
  hypothetical?: boolean;
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
  jupiterHub?: Pick<JupiterOrgHub,'request'>;
  rpcUrl?: string;
  isDryRun?: boolean;
  executionEnv?: ExecutionEnvironment;
  dexAggregator?: DexAggregatorService;
  connection?: Connection;
  confirmationTimeoutMs?: number;
  apiKey?: string;
  v2BaseUrl?: string;
  trafficCoordinator?: JupiterTrafficCoordinator;
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
  private executionEnv: ExecutionEnvironment;
  private dexAggregator: DexAggregatorService;
  private hub?: Pick<JupiterOrgHub,'request'>;
  private v2BaseUrl: string;
  private executeTimeoutMs: number;
  private trafficCoordinator: JupiterTrafficCoordinator;

  constructor(config: JupiterEngineConfig = {}) {
    this.executionEnv = config.executionEnv ?? process.env;
    if (!config.connection) throw new Error('Hub-backed connection required');
    this.connection = config.connection;
    this.isDryRun = config.isDryRun !== undefined
      ? config.isDryRun
      : resolveExecutionMode(this.executionEnv).shadow;
    this.hub = config.jupiterHub;
    this.dexAggregator = config.jupiterHub ? new DexAggregatorService(undefined, {hub:config.jupiterHub}) : config.dexAggregator || new DexAggregatorService();
    this.trafficCoordinator = config.trafficCoordinator || this.dexAggregator.getTrafficCoordinator();

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
    trafficPriority: JupiterPriority = 3
  ) {
    return this.dexAggregator.getQuote({
      inputMint,
      outputMint,
      amountLamports,
      slippageBps,
      trafficPriority
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

  private async getOrder(req: SwapExecutionRequest): Promise<JupiterV2OrderResponse> {
    if (!this.hub) throw new Error('Jupiter hub required');

    const params: Record<string, string | number> = {
      inputMint: req.inputMint,
      outputMint: req.outputMint,
      amount: String(req.amountLamports),
      taker: req.userPublicKey
    };

    const slippageBps = this.orderSlippage(req);
    if (slippageBps !== undefined) params.slippageBps = slippageBps;

    const order = (await this.hub.request(hubWorkForPriority(req.trafficPriority ?? 4), '/swap/v2/order', params)).body as JupiterV2OrderResponse;
    for (const program of req.forbiddenProgramIds || []) {
      if (referencesProgram(order.routePlan, program)) throw new Error(`Forbidden entry program: ${program}`);
    }
    if (!order?.requestId || !order?.transaction) {
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

    console.log(
      `🧭 [Jupiter V2 /order] router=${order.router || 'unknown'} mode=${order.mode || 'unknown'} ` +
      `| slippage=${rtseSlippage}bps | fee=${order.feeBps ?? 'n/d'}bps | out=${order.outAmount}`
    );
    this.assertOrderNotExpired(order);
    return order;
  }

  private assertOrderNotExpired(order: JupiterV2OrderResponse): void {
    if (order.expireAt == null) return;
    const expiresAt = Date.parse(order.expireAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      throw new Error('Jupiter V2: expired or invalid expireAt; obtain a fresh order before signing/submission.');
    }
  }

  private async assertEntryProgramsAllowed(order: JupiterV2OrderResponse, req: SwapExecutionRequest): Promise<void> {
    if (!req.forbiddenProgramIds?.length && !req.requiredPoolAddress) return;
    const transaction = VersionedTransaction.deserialize(Buffer.from(order.transaction!, 'base64'));
    const addresses = transaction.message.staticAccountKeys.map(key => key.toBase58());
    // CPI programs may be loaded through a v0 address lookup table.
    for (const lookup of transaction.message.addressTableLookups) {
      const table = (await this.connection.getAddressLookupTable(lookup.accountKey)).value;
      if (!table) throw new Error('Entry route lookup table unavailable');
      for (const index of [...lookup.writableIndexes, ...lookup.readonlyIndexes]) {
        const key = table.state.addresses[index];
        if (!key) throw new Error('Entry route lookup table index unavailable');
        addresses.push(key.toBase58());
      }
    }
    if (req.requiredPoolAddress && !addresses.includes(req.requiredPoolAddress)) {
      throw new Error(`Jupiter order does not reference audited pool: ${req.requiredPoolAddress}`);
    }
    for (const program of req.forbiddenProgramIds || []) {
      if (addresses.includes(program)) throw new Error(`Forbidden entry program: ${program}`);
    }
  }

  private signOrder(
    order: JupiterV2OrderResponse,
    req: SwapExecutionRequest
  ): { transaction: VersionedTransaction; signedTransaction: string } {
    if (!resolveExecutionMode(this.executionEnv).canSign) {
      throw new Error('Shadow mode blocks Jupiter signing.');
    }
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
      const unsigned = VersionedTransaction.deserialize(transaction.serialize());
      unsigned.signatures = unsigned.signatures.map(() => new Uint8Array(64));
      const simRes = await this.connection.simulateTransaction(unsigned, { sigVerify: false });
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
  ): Promise<{ success: boolean; hypothetical: true; error?: string; unitsConsumed?: number }> {
    try {
      const order = await this.getOrder(req);
      await this.assertEntryProgramsAllowed(order, req);
      const transaction = VersionedTransaction.deserialize(Buffer.from(order.transaction as string, 'base64'));
      return { ...(await this.simulateSignedTransaction(transaction)), hypothetical: true };
    } catch (err: any) {
      return {
        success: false,
        hypothetical: true,
        error: err?.message || String(err)
      };
    }
  }

  private async postExecute(payload: {
    signedTransaction: string;
    requestId: string;
    lastValidBlockHeight?: string | number;
  }, priority: JupiterPriority): Promise<{ response?: JupiterV2ExecuteResponse; uncertainError?: string }> {
    if (!resolveExecutionMode(this.executionEnv).canBroadcast) {
      throw new Error('Shadow mode blocks Jupiter broadcast.');
    }
    try {
      if (!this.hub) throw new Error('Jupiter hub required');
      const work=hubWorkForPriority(priority);
      const response=await this.hub.request(work==='ENTRY'?'ENTRY':'EXIT','/swap/v2/execute',payload,{deadlineMs:Date.now()+this.executeTimeoutMs});
      return {response:response.body as JupiterV2ExecuteResponse};
    } catch {
      return {uncertainError:'/execute status unknown; reconcile before any retry'};
    }
  }

  public async executeSwap(req: SwapExecutionRequest): Promise<SwapExecutionResponse> {
    if (this.isDryRun || !resolveExecutionMode(this.executionEnv).canBroadcast || !req.keypair) {
      try {
        const quote = await this.dexAggregator.getQuote({
          inputMint: req.inputMint,
          outputMint: req.outputMint,
          amountLamports: req.amountLamports,
          slippageBps: req.slippageBps ?? 400,
          autoSlippage: req.autoSlippage,
          maxAutoSlippageBps: req.maxAutoSlippageBps,
          poolLiquidityUsd: req.poolLiquidityUsd,
          trafficPriority: req.trafficPriority ?? 5
        });

        for (const program of req.forbiddenProgramIds || []) {
          if (referencesProgram(quote.rawQuote?.routePlan, program)) throw new Error(`Forbidden entry program: ${program}`);
        }

        return {
          txSignature: `dry_run_v2_${Date.now()}_${Math.random().toString(36).slice(2)}`,
          status: 'DRY_RUN_SUCCESS',
          inAmount: quote.inAmount,
          outAmount: quote.outAmount,
          isDryRun: true,
          hypothetical: true,
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
          hypothetical: true,
          executionPath: 'V2_META_AGGREGATOR',
          error: err?.message || String(err)
        };
      }
    }

    try {
      const order = await this.getOrder(req);
      await this.assertEntryProgramsAllowed(order, req);
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

      this.assertOrderNotExpired(order);
      const payload = {
        signedTransaction,
        requestId: order.requestId,
        ...(order.lastValidBlockHeight
          ? { lastValidBlockHeight: order.lastValidBlockHeight }
          : {})
      };

      const executed = await this.postExecute(payload, req.trafficPriority ?? 4);

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
        result.totalInputAmount ?? NaN
      );
      const actualOutput = Number(
        result.totalOutputAmount ?? NaN
      );

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
