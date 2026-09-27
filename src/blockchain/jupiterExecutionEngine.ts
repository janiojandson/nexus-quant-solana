import axios from 'axios';
import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';
import { DexAggregatorService } from './dexAggregator.js';

export interface SwapExecutionRequest {
  inputMint: string;
  outputMint: string;
  amountLamports: number;
  userPublicKey: string;
  keypair?: Keypair;
  slippageBps?: number;
}

export interface SwapExecutionResponse {
  txSignature: string;
  status: 'SUCCESS' | 'DRY_RUN_SUCCESS' | 'FAILED';
  inAmount: number;
  outAmount: number;
  isDryRun: boolean;
  error?: string;
}

export interface JupiterEngineConfig {
  rpcUrl?: string;
  isDryRun?: boolean;
  dexAggregator?: DexAggregatorService;
}

export class JupiterExecutionEngine {
  private connection: Connection;
  private isDryRun: boolean;
  private dexAggregator: DexAggregatorService;
  private swapUrl: string;

  constructor(config?: JupiterEngineConfig) {
    this.connection = new Connection(config?.rpcUrl || 'https://api.mainnet-beta.solana.com', 'confirmed');
    this.isDryRun = config?.isDryRun !== undefined ? config.isDryRun : (process.env.DRY_RUN_MODE !== 'false');
    this.dexAggregator = config?.dexAggregator || new DexAggregatorService();
    this.swapUrl = process.env.JUPITER_SWAP_URL || 'https://public.jupiterapi.com/swap';
  }

  public async executeSwap(req: SwapExecutionRequest): Promise<SwapExecutionResponse> {
    try {
      // 1. Obter Cotação Oficial da Jupiter
      const quote = await this.dexAggregator.getQuote({
        inputMint: req.inputMint,
        outputMint: req.outputMint,
        amountLamports: req.amountLamports,
        slippageBps: req.slippageBps || 50
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

      const swapRes = await axios.post(this.swapUrl, {
        quoteResponse: payloadQuote,
        userPublicKey: req.userPublicKey,
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: {
          priorityLevelWithMaxLamports: {
            maxLamports: 2000000,
            priorityLevel: 'medium'
          }
        }
      }, { timeout: 8000 });

      const swapTransactionBuf = Buffer.from(swapRes.data.swapTransaction, 'base64');
      const transaction = VersionedTransaction.deserialize(swapTransactionBuf);

      // 4. Assinar com a Chave Phantom do Agente
      transaction.sign([req.keypair]);

      // 5. Transmitir para a Blockchain Solana
      const txid = await this.connection.sendRawTransaction(transaction.serialize(), {
        skipPreflight: false,
        maxRetries: 3
      });

      return {
        txSignature: txid,
        status: 'SUCCESS',
        inAmount: quote.inAmount,
        outAmount: quote.outAmount,
        isDryRun: false
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
