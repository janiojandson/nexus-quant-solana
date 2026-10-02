// Validação de saída em mainnet SEM BROADCAST.
// Lê a custódia real, obtém quote Jupiter, monta/assina e simula no RPC.
// Não chama executeSwap() e não chama sendRawTransaction().
import dotenv from 'dotenv';
import { SolanaWalletService } from '../src/blockchain/solanaWallet.js';
import { JupiterExecutionEngine } from '../src/blockchain/jupiterExecutionEngine.js';
import { DexAggregatorService } from '../src/blockchain/dexAggregator.js';
import { assertAtomicAmountToNumber } from '../src/execution/atomicAmount.js';

dotenv.config();

const SOL_MINT = 'So11111111111111111111111111111111111111112';

async function main() {
  const mint = String(process.env.VALIDATE_EXIT_MINT || '').trim();
  if (!mint) throw new Error('VALIDATE_EXIT_MINT é obrigatório.');

  const entrySolRaw = process.env.VALIDATE_ENTRY_SOL;
  const entrySol = entrySolRaw ? Number(entrySolRaw) : null;
  if (entrySol !== null && (!Number.isFinite(entrySol) || entrySol <= 0)) {
    throw new Error('VALIDATE_ENTRY_SOL inválido.');
  }

  const rpcUrl =
    process.env.HELIUS_RPC_URL ||
    process.env.QUICKNODE_RPC_URL ||
    process.env.SOLANA_RPC_URL;
  if (!rpcUrl) throw new Error('RPC ausente.');

  const wallet = new SolanaWalletService({
    secretKeyRaw: process.env.AGENT_SOLANA_PRIVATE_KEY || '[]',
    rpcUrl
  });
  const accounts = await wallet.getSplTokenAccounts();
  const holding = accounts.find(a => a.mint === mint);
  if (!holding) throw new Error('Mint sem saldo custodiado na carteira.');

  const atomicAmount = assertAtomicAmountToNumber(holding.atomicAmount);
  const aggregator = new DexAggregatorService();
  const engine = new JupiterExecutionEngine({
    connection: wallet.getConnection(),
    isDryRun: false,
    dexAggregator: aggregator
  });

  const quote = await engine.getQuote(mint, SOL_MINT, atomicAmount, 500);
  const outSol = quote.outAmount / 1e9;
  const pnlPct = entrySol ? ((outSol - entrySol) / entrySol) * 100 : null;

  console.log(JSON.stringify({
    stage: 'QUOTE',
    mint,
    owner: wallet.getPublicKey(),
    atomicAmount: holding.atomicAmount,
    uiAmount: holding.tokenAmount,
    decimals: holding.decimals,
    ata: holding.ataAddress,
    outSol,
    pnlPct,
    priceImpactPct: quote.priceImpactPct,
    route: quote.routePlanSummary,
    broadcast: false
  }));

  const sim = await engine.simulateSwap({
    inputMint: mint,
    outputMint: SOL_MINT,
    amountLamports: atomicAmount,
    userPublicKey: wallet.getPublicKey(),
    keypair: wallet.getKeypair(),
    slippageBps: 500,
    autoSlippage: false,
    skipPreflight: false,
    priorityLevel: 'high'
  }, quote);

  console.log(JSON.stringify({
    stage: 'SIGNED_RPC_SIMULATION_NO_BROADCAST',
    success: sim.success,
    unitsConsumed: sim.unitsConsumed ?? null,
    error: sim.error ?? null,
    broadcast: false
  }));

  if (!sim.success) process.exitCode = 2;
}

main().catch(err => {
  console.error('VALIDATION_ERROR=' + (err?.message || err));
  process.exit(1);
});
