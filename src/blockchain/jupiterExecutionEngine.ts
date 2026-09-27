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
  private static readonly JUPITER_SWAP_URL = 'https://quote-api.jup.ag/v6/swap';

  constructor(config?: JupiterEngineConfig) {
    this.connection = new Connection(config?.rpcUrl || 'https://api.mainnet-beta.solana.com', 'confirmed');
    this.isDryRun = config?.isDryRun !== undefined ? config.isDryRun : (process.env.DRY_RUN_MODE !== 'false');
    this.dexAggregator = config?.dexAggregator || new DexAggregatorService();
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
      const swapRes = await axios.post(JupiterExecutionEngine.JUPITER_SWAP_URL, {
        quoteResponse: quote,
        userPublicKey: req.userPublicKey,
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: 'auto'
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
      return {
        txSignature: '',
        status: 'FAILED',
        inAmount: req.amountLamports,
        outAmount: 0,
        isDryRun: this.isDryRun,
        error: err.message || String(err)
      };
    }
  }
}
