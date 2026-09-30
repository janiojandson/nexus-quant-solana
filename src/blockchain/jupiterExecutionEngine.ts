import axios from 'axios';
import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';
import { DexAggregatorService, SwapQuoteResult } from './dexAggregator.js';

export interface SwapExecutionRequest {
  inputMint: string;
  outputMint: string;
  amountLamports: number;
  userPublicKey: string;
  keypair?: Keypair;
  /** Tolerância de slippage em basis points.
   *  Compra padrão: autoSlippage dinâmico com max 600 bps para zerar 0x177e.
   *  Saída de emergência: 500bps (5.0%) via parâmetro explícito. */
  slippageBps?: number;
  /** Nível de prioridade para a taxa de gas: 'medium' (compra), 'high' (saída de emergência) */
  priorityLevel?: 'low' | 'medium' | 'high' | 'veryHigh';
  /** Se true, ativa o autoSlippage oficial da Jupiter V6 */
  autoSlippage?: boolean;
  autoSlippageCollisionUsdValue?: number;
  maxAutoSlippageBps?: number;
  /** Se true, pula simulação local prévia da compra para envio ultra-rápido aos validadores */
  skipPreflight?: boolean;
}

export interface SwapExecutionResponse {
  txSignature: string;
  status: 'SUCCESS' | 'DRY_RUN_SUCCESS' | 'FAILED';
  inAmount: number;
  outAmount: number;
  isDryRun: boolean;
  error?: string;
  /** Compute Units consumidas na simulação pré-voo (telemetria de custo de execução). */
  unitsConsumed?: number;
}

export interface JupiterEngineConfig {
  rpcUrl?: string;
  isDryRun?: boolean;
  dexAggregator?: DexAggregatorService;
  /** Conexão injetável (testes). Em produção, derivada de rpcUrl. */
  connection?: Connection;
}

export class JupiterExecutionEngine {
  private connection: Connection;
  private isDryRun: boolean;
  private dexAggregator: DexAggregatorService;
  private swapUrl: string;

  constructor(config?: JupiterEngineConfig) {
    this.connection = config?.connection || new Connection(config?.rpcUrl || 'https://api.mainnet-beta.solana.com', 'confirmed');
    this.isDryRun = config?.isDryRun !== undefined ? config.isDryRun : (process.env.DRY_RUN_MODE !== 'false');
    this.dexAggregator = config?.dexAggregator || new DexAggregatorService();
    this.swapUrl = process.env.JUPITER_SWAP_URL || 'https://public.jupiterapi.com/swap';
  }

  public getAggregator(): DexAggregatorService {
    return this.dexAggregator;
  }

  public async getQuote(inputMint: string, outputMint: string, amountLamports: number, slippageBps = 400) {
    return this.dexAggregator.getQuote({
      inputMint,
      outputMint,
      amountLamports,
      slippageBps
    });
  }

  /**
   * Simulação pré-voo pura: monta a transação via Jupiter e a executa no RPC
   * SEM assinar e SEM transmitir. Usada pelo sizer adaptativo para testar um
   * lote antes de comprometer capital.
   *
   * Retorna `error` preenchido (string) quando o lote é inviável — 6014
   * SlippageExceeded, 0x1789, profundidade insuficiente, etc.
   */
  public async simulateSwap(req: SwapExecutionRequest): Promise<{ success: boolean; error?: string; unitsConsumed?: number }> {
    try {
      const isBuy = req.inputMint === 'So11111111111111111111111111111111111111112';
      const useAutoSlippage = req.autoSlippage !== undefined ? req.autoSlippage : isBuy;

      const quote = await this.dexAggregator.getQuote({
        inputMint: req.inputMint,
        outputMint: req.outputMint,
        amountLamports: req.amountLamports,
        slippageBps: req.slippageBps ?? 400,
        autoSlippage: useAutoSlippage,
        autoSlippageCollisionUsdValue: req.autoSlippageCollisionUsdValue ?? 1000,
        maxAutoSlippageBps: req.maxAutoSlippageBps ?? 750
      });

      const transaction = await this.buildSwapTransaction(quote, req, isBuy);

      // Assina com a wallet quando ela é signer requerido, para que a
      // simulação reflita a mesma falha de authority que ocorreria no envio.
      if (req.keypair) {
        try {
          transaction.sign([req.keypair]);
        } catch (signErr: any) {
          if (!/non signer key/.test(signErr?.message || '')) throw signErr;
        }
      }

      const simRes = await this.connection.simulateTransaction(transaction);
      if (simRes.value.err) {
        return {
          success: false,
          unitsConsumed: simRes.value.unitsConsumed,
          error: `Simulação pré-voo rejeitada: ${JSON.stringify(simRes.value.err)}`
        };
      }
      return { success: true, unitsConsumed: simRes.value.unitsConsumed };
    } catch (err: any) {
      const detail = err?.response?.data?.error || err?.message || String(err);
      return {
        success: false,
        error: typeof detail === 'object' ? JSON.stringify(detail) : String(detail)
      };
    }
  }

  /** Monta (mas não assina) a transação de swap devolvida pela Jupiter. */
  private async buildSwapTransaction(
    quote: SwapQuoteResult,
    req: SwapExecutionRequest,
    isBuy: boolean
  ): Promise<VersionedTransaction> {
    const payloadQuote = quote.rawQuote || {
      inputMint: quote.inputMint,
      outputMint: quote.outputMint,
      inAmount: String(quote.inAmount),
      outAmount: String(quote.outAmount),
      otherAmountThreshold: String(quote.outAmount),
      swapMode: 'ExactIn',
      slippageBps: quote.slippageBps,
      priceImpactPct: String(quote.priceImpactPct)
    };

    const priorityLevel = req.priorityLevel || (isBuy ? 'medium' : 'high');
    const swapRes = await axios.post(this.swapUrl, {
      quoteResponse: payloadQuote,
      userPublicKey: req.userPublicKey,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: {
        priorityLevelWithMaxLamports: {
          maxLamports: priorityLevel === 'high' || priorityLevel === 'veryHigh' ? 5000000 : 2000000,
          priorityLevel
        }
      }
    }, { timeout: 8000 });

    return VersionedTransaction.deserialize(Buffer.from(swapRes.data.swapTransaction, 'base64'));
  }

  public async executeSwap(req: SwapExecutionRequest): Promise<SwapExecutionResponse> {
    try {
      // 1. Obter Cotação Oficial da Jupiter
      // Para compras: utiliza autoSlippage caso explicitado ou caso input seja SOL (compra)
      const isBuy = req.inputMint === 'So11111111111111111111111111111111111111112';
      const useAutoSlippage = req.autoSlippage !== undefined ? req.autoSlippage : isBuy;

      const quote = await this.dexAggregator.getQuote({
        inputMint: req.inputMint,
        outputMint: req.outputMint,
        amountLamports: req.amountLamports,
        slippageBps: req.slippageBps ?? 400,
        autoSlippage: useAutoSlippage,
        autoSlippageCollisionUsdValue: req.autoSlippageCollisionUsdValue ?? 1000,
        maxAutoSlippageBps: req.maxAutoSlippageBps ?? 750
      });

      // 2. Se for Modo Simulação (DRY RUN): Retorna sucesso teórico sem gastar SOL
      if (this.isDryRun || !req.keypair) {
        return {
          txSignature: `dry_run_tx_${Date.now()}_${Math.random().toString(36).substring(7)}`,
          status: 'DRY_RUN_SUCCESS',
          inAmount: quote.inAmount,
          outAmount: quote.outAmount,
          isDryRun: true
        };
      }

      // 3. Montar a Transação Serializada V6 na Jupiter
      const transaction = await this.buildSwapTransaction(quote, req, isBuy);

      // 4. Assinar com a Chave do Agente. `VersionedTransaction.sign` lança
      // "Cannot sign with non signer key" quando a carteira não é um signer
      // requerido pela transação. Nesse caso abortamos com diagnóstico claro,
      // em vez de deixar a falha chegar ao catch genérico como erro de swap.
      try {
        transaction.sign([req.keypair]);
      } catch (signErr: any) {
        throw new Error(`Assinatura rejeitada: a carteira ${req.userPublicKey} nao e signer requerido desta transacao Jupiter. ${signErr?.message || signErr}`);
      }

      // 4.1 Simulação Pré-Voo Fail-Closed:
      // Se a simulação indicar que a transação falharia on-chain (ex.: Custom 6014
      // SlippageExceeded), a tx NÃO é transmitida — preserva taxa de rede.
      // Falha do próprio RPC de simulação também aborta: enviar sem validação é
      // exatamente o comportamento fail-open que gerava compras na escuridão.
      let unitsConsumed: number | undefined;
      if (!req.skipPreflight) {
        let simErr: unknown = null;
        try {
          const simRes = await this.connection.simulateTransaction(transaction);
          if (simRes.value.err) simErr = simRes.value.err;
          else unitsConsumed = simRes.value.unitsConsumed;
        } catch (e: any) {
          simErr = e;
        }

        if (simErr !== null) {
          const errStr = typeof simErr === 'string' ? simErr : JSON.stringify(simErr);
          console.warn(`🛑 [SIMULAÇÃO PRÉ-VOO BARRADA]: Swap falharia on-chain (${errStr}). Transmissão cancelada.`);
          return {
            txSignature: '',
            status: 'FAILED',
            inAmount: req.amountLamports,
            outAmount: 0,
            isDryRun: false,
            unitsConsumed,
            error: `Simulação pré-voo rejeitada pelo nó RPC: ${errStr}`
          };
        }
      }

      // 5. Transmitir para a Blockchain Solana apenas se a simulação foi aprovada
      const txid = await this.connection.sendRawTransaction(transaction.serialize(), {
        skipPreflight: true, // Já validado com segurança na simulação acima
        maxRetries: 3
      });

      return {
        txSignature: txid,
        status: 'SUCCESS',
        inAmount: quote.inAmount,
        outAmount: quote.outAmount,
        isDryRun: false,
        unitsConsumed
      };
    } catch (err: any) {
      console.error('❌ [JUPITER SWAP ERROR DETALHADO]:', err.response?.data || err.message || err);
      const errorMsg = err.response?.data?.error || err.response?.data?.message || err.response?.data || err.message || String(err);
      return {
        txSignature: '',
        status: 'FAILED',
        inAmount: req.amountLamports,
        outAmount: 0,
        isDryRun: this.isDryRun,
        error: typeof errorMsg === 'object' ? JSON.stringify(errorMsg) : String(errorMsg)
      };
    }
  }
}
