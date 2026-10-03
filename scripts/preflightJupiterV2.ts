// Preflight Jupiter Swap V2 em mainnet SEM BROADCAST.
// Valida quote-only, /order com taker, assinatura local e simulação RPC.
// Nunca chama /execute.
import dotenv from 'dotenv';
import { SolanaWalletService } from '../src/blockchain/solanaWallet.js';
import { JupiterExecutionEngine } from '../src/blockchain/jupiterExecutionEngine.js';
import { DexAggregatorService } from '../src/blockchain/dexAggregator.js';

dotenv.config();

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const TEST_LAMPORTS = 1_000_000; // 0.001 SOL, somente simulação

async function main() {
  const rpcUrl =
    process.env.HELIUS_RPC_URL ||
    process.env.QUICKNODE_RPC_URL ||
    process.env.SOLANA_RPC_URL;
  if (!rpcUrl) throw new Error('RPC ausente.');
  if (!process.env.JUPITER_API_KEY) throw new Error('JUPITER_API_KEY ausente.');

  const wallet = new SolanaWalletService({
    secretKeyRaw: process.env.AGENT_SOLANA_PRIVATE_KEY || '[]',
    rpcUrl
  });
  const aggregator = new DexAggregatorService();
  const engine = new JupiterExecutionEngine({
    connection: wallet.getConnection(),
    isDryRun: false,
    dexAggregator: aggregator,
    apiKey: process.env.JUPITER_API_KEY
  });

  const quote = await aggregator.getQuote({
    inputMint: SOL_MINT,
    outputMint: USDC_MINT,
    amountLamports: TEST_LAMPORTS,
    autoSlippage: true,
    maxAutoSlippageBps: 750
  });

  const simulation = await engine.simulateSwap({
    inputMint: SOL_MINT,
    outputMint: USDC_MINT,
    amountLamports: TEST_LAMPORTS,
    userPublicKey: wallet.getPublicKey(),
    keypair: wallet.getKeypair(),
    autoSlippage: true,
    maxAutoSlippageBps: 750,
    skipPreflight: false
  });

  console.log(JSON.stringify({
    ok: simulation.success,
    noTransactionBroadcast: true,
    executor: engine.getExecutionInfo(),
    wallet: wallet.getPublicKey(),
    testAmountSol: TEST_LAMPORTS / 1e9,
    quote: {
      router: quote.router || null,
      mode: quote.mode || null,
      outAmount: quote.outAmount,
      priceImpactPct: quote.priceImpactPct,
      slippageBps: quote.slippageBps,
      feeBps: quote.feeBps ?? null
    },
    signedRpcSimulation: {
      success: simulation.success,
      unitsConsumed: simulation.unitsConsumed ?? null,
      error: simulation.error ?? null
    }
  }, null, 2));

  if (!simulation.success) process.exitCode = 2;
}

main().catch((err: any) => {
  console.error('JUPITER_V2_PREFLIGHT_ERROR=' + (err?.message || err));
  process.exit(1);
});
