// ============================================================
// testCanaryTrade.ts — Nexus Quant Solana
// Teste on-chain controlado: compra e venda imediatas de um ativo líquido
// (JUP/USDC) para auditar TODO o pipeline de execução real.
//
// Usa as mesmas classes de produção:
//   SolanaWalletService, JupiterExecutionEngine, AdaptivePositionSizer
//
// NÃO grava nada no Decision Journal, na quarentena nem no positionEngine:
// este script é um probe de infraestrutura, não uma operação de estratégia.
//
// Uso (dentro do Railway, com as variáveis de produção injetadas):
//   railway run npm run trade:canary
// ============================================================

import dotenv from 'dotenv';
import { PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { SolanaWalletService } from '../src/blockchain/solanaWallet.js';
import { JupiterExecutionEngine } from '../src/blockchain/jupiterExecutionEngine.js';
import { DexAggregatorService } from '../src/blockchain/dexAggregator.js';
import { AdaptivePositionSizer, MIN_TRADE_AMOUNT_SOL } from '../src/blockchain/adaptivePositionSizer.js';

dotenv.config();

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

const TARGETS: Record<string, { mint: string; label: string }> = {
  JUP: { mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', label: 'Jupiter' },
  USDC: { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', label: 'USD Coin' }
};

const SOLSCAN = 'https://solscan.io/tx/';
const WAIT_SECONDS = 5;

// ============================================================
// Telemetria
// ============================================================

interface Phase {
  signature: string | null;
  unitsConsumed?: number;
  confirmMs?: number;
  solReceived?: number;
  tokensReceived?: number;
}

interface Report {
  entry: Phase;
  exit: Phase;
  initialBalanceSol: number;
  finalBalanceSol: number;
  rentRecoveredSol: number;
  ataClosed: boolean;
  status: 'SUCESSO_TOTAL' | 'FALHA_NA_ENTRADA' | 'FALHA_NA_SAIDA' | 'FALHA_DE_INFRA';
  errors: string[];
}

const report: Report = {
  entry: { signature: null },
  exit: { signature: null },
  initialBalanceSol: 0,
  finalBalanceSol: 0,
  rentRecoveredSol: 0,
  ataClosed: false,
  status: 'FALHA_DE_INFRA',
  errors: []
};

function banner(title: string) {
  console.log('\n' + '='.repeat(70));
  console.log(`  ${title}`);
  console.log('='.repeat(70));
}

function link(sig: string | null): string {
  return sig ? `${SOLSCAN}${sig}` : '(sem assinatura)';
}

async function sleepCountdown(seconds: number) {
  for (let i = seconds; i > 0; i--) {
    console.log(`   ⏳ ${i}...`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/** Lê o saldo SPL (uiAmount) de um mint na carteira. Retorna 0 se não houver conta. */
async function readSplBalance(
  connection: any,
  owner: PublicKey,
  mint: string
): Promise<number> {
  const { getAssociatedTokenAddress } = await import('@solana/spl-token');
  const ata = await getAssociatedTokenAddress(new PublicKey(mint), owner);
  const info = await connection.getParsedAccountInfo(ata);
  if (!info?.value?.data) return 0;
  const parsed: any = info.value.data;
  if (parsed.program !== 'spl-token' || parsed.parsed?.type !== 'account') return 0;
  return Number(parsed.parsed.info.tokenAmount.uiAmount || 0);
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  const targetKey = (process.env.CANARY_TARGET || 'JUP').toUpperCase();
  const target = TARGETS[targetKey];
  if (!target) {
    console.error(`Alvo inválido: ${targetKey}. Use JUP ou USDC.`);
    process.exit(1);
  }

  const rpcUrl = process.env.HELIUS_RPC_URL || process.env.QUICKNODE_RPC_URL || process.env.SOLANA_RPC_URL;
  if (!rpcUrl) {
    console.error('Nenhuma URL de RPC encontrada (HELIUS_RPC_URL / QUICKNODE_RPC_URL / SOLANA_RPC_URL).');
    process.exit(1);
  }

  banner('CANARY TRADE — NEXUS QUANT SOLANA');
  console.log(`Ativo alvo      : ${targetKey} (${target.label})`);
  console.log(`Mint             : ${target.mint}`);
  console.log(`RPC              : ${rpcUrl.split('?')[0]}`);
  console.log(`Lote             : ${MIN_TRADE_AMOUNT_SOL} SOL (piso do sizing adaptativo)`);
  console.log(`Teto de slippage : 750 bps`);
  console.log(`Conta            : ${process.env.AGENT_SOLANA_PUBLIC_KEY || '(a definir)'}`);

  // ------------------------------------------------------------------
  // Carteira (produção)
  // ------------------------------------------------------------------
  const wallet = new SolanaWalletService({
    secretKeyRaw: process.env.AGENT_SOLANA_PRIVATE_KEY || '[]',
    rpcUrl
  });
  const connection = wallet.getConnection();
  const keypair = wallet.getKeypair();
  const owner = keypair.publicKey;

  const initialBalance = await wallet.getBalanceSol();
  report.initialBalanceSol = initialBalance;
  console.log(`\n💰 Saldo inicial: ${initialBalance.toFixed(6)} SOL`);

  if (initialBalance <= MIN_TRADE_AMOUNT_SOL + 0.01) {
    console.error(`Saldo insuficiente para o canário (necessário ~${MIN_TRADE_AMOUNT_SOL + 0.01} SOL).`);
    process.exit(1);
  }

  const aggregator = new DexAggregatorService();
  const engine = new JupiterExecutionEngine({
    connection,
    isDryRun: false, // canário é SEMPRE real; não consulta DRY_RUN_MODE
    dexAggregator: aggregator
  });
  const sizer = new AdaptivePositionSizer(aggregator, [MIN_TRADE_AMOUNT_SOL]);

  // ------------------------------------------------------------------
  // FASE 1 — Entrada
  // ------------------------------------------------------------------
  banner('FASE 1 — ENTRADA (COMPRA REAL)');

  const sizing = await sizer.findExecutableSize({
    inputMint: SOL_MINT,
    outputMint: target.mint,
    autoSlippage: true,
    autoSlippageCollisionUsdValue: 1000,
    maxAutoSlippageBps: 750
  });

  if (!sizing.success || !sizing.quote) {
    report.status = 'FALHA_NA_ENTRADA';
    report.errors.push(`Sizing abortado: ${sizing.error}`);
    console.error(`🚫 Dimensionamento abortado: ${sizing.error}`);
    return finalize();
  }

  const sizeSol = sizing.sizeSol;
  console.log(`✅ Lote autorizado: ${sizeSol} SOL`);
  console.log(`   Price Impact   : ${Math.abs(sizing.quote.priceImpactPct || 0).toFixed(3)}%`);
  console.log(`   Rota           : ${sizing.quote.routePlanSummary}`);
  console.log(`   outAmount prev.: ${sizing.quote.outAmount}`);

  const entryStart = Date.now();
  let entryRes;
  try {
    entryRes = await engine.executeSwap({
      inputMint: SOL_MINT,
      outputMint: target.mint,
      amountLamports: Math.floor(sizeSol * 1e9),
      autoSlippage: true,
      autoSlippageCollisionUsdValue: 1000,
      maxAutoSlippageBps: 750,
      skipPreflight: false,
      userPublicKey: owner.toBase58(),
      keypair,
      priorityLevel: 'high'
    });
  } catch (err: any) {
    report.status = 'FALHA_NA_ENTRADA';
    report.errors.push(`Exceção na entrada: ${err?.message || err}`);
    console.error(`❌ Exceção na entrada: ${err?.message || err}`);
    return finalize();
  }

  if (entryRes.status !== 'SUCCESS') {
    report.status = 'FALHA_NA_ENTRADA';
    report.errors.push(`Swap de entrada falhou: ${entryRes.error}`);
    console.error(`❌ Entrada falhou: ${entryRes.error}`);
    console.log(`   Nenhuma taxa foi gasta: a transação não foi transmitida.`);
    return finalize();
  }

  // Confirmação on-chain (o motor transmite com skipPreflight; confirmamos aqui)
  console.log(`\n⏳ Assinatura: ${entryRes.txSignature}`);
  console.log(`   Compute Units: ${entryRes.unitsConsumed ?? 'n/d'}`);
  try {
    const blockhash = await connection.getLatestBlockhash('confirmed');
    await connection.confirmTransaction(
      { signature: entryRes.txSignature, ...blockhash },
      'confirmed'
    );
    report.entry.confirmMs = Date.now() - entryStart;
    console.log(`   ✅ Confirmada em ${report.entry.confirmMs} ms`);
  } catch (err: any) {
    report.status = 'FALHA_NA_ENTRADA';
    report.errors.push(`Entrada não confirmou on-chain: ${err?.message || err}`);
    console.error(`❌ Timeout de confirmação: ${err?.message || err}`);
    return finalize();
  }

  report.entry.signature = entryRes.txSignature;
  report.entry.unitsConsumed = entryRes.unitsConsumed;
  report.entry.tokensReceived = entryRes.outAmount;
  console.log(`🔗 Solscan: ${link(entryRes.txSignature)}`);

  // ------------------------------------------------------------------
  // FASE 2 — Gestão e espera
  // ------------------------------------------------------------------
  banner('FASE 2 — CONFIRMAÇÃO DE RECEBIMENTO E ESPERA');

  const tokensBalance = await readSplBalance(connection, owner, target.mint);
  report.entry.tokensReceived = tokensBalance;
  console.log(`Saldo ${targetKey} na carteira: ${tokensBalance}`);

  if (tokensBalance <= 0) {
    report.status = 'FALHA_NA_ENTRADA';
    report.errors.push('Nenhum token recebido apesar da confirmação da transação.');
    console.error('❌ Nenhum token recebido.');
    return finalize();
  }

  console.log(`\nAguardando ${WAIT_SECONDS}s para confirmar liquididade da posição...`);
  await sleepCountdown(WAIT_SECONDS);

  // ------------------------------------------------------------------
  // FASE 3 — Saída (100%)
  // ------------------------------------------------------------------
  banner('FASE 3 — SAÍDA (VENDA REAL 100%)');

  const { getAssociatedTokenAddress } = await import('@solana/spl-token');
  const ataAddress = await getAssociatedTokenAddress(new PublicKey(target.mint), owner);

  // Snapshot do saldo para deprecar o SOL de fato recuperado na saída
  const balBeforeExit = await wallet.getBalanceSol();

  const exitStart = Date.now();
  const exitRes = await engine.executeSwap({
    inputMint: target.mint,
    outputMint: SOL_MINT,
    amountLamports: Math.floor(tokensBalance),
    slippageBps: 500,
    autoSlippage: false,
    skipPreflight: false,
    userPublicKey: owner.toBase58(),
    keypair,
    priorityLevel: 'veryHigh'
  });

  if (exitRes.status !== 'SUCCESS') {
    report.status = 'FALHA_NA_SAIDA';
    report.errors.push(`Swap de saída falhou: ${exitRes.error}`);
    console.error(`❌ Saída falhou: ${exitRes.error}`);
    console.log(`\n⚠️  ATENÇÃO: os tokens de ${targetKey} PERMANECEM na carteira.`);
    console.log(`   Resgate manual necessário via Jupiter UI ou repetindo a saída.`);
    console.log(`   ATA: ${ataAddress.toBase58()}`);
    return finalize();
  }

  console.log(`\n⏳ Assinatura de saída: ${exitRes.txSignature}`);
  console.log(`   Compute Units: ${exitRes.unitsConsumed ?? 'n/d'}`);
  try {
    const blockhash = await connection.getLatestBlockhash('confirmed');
    await connection.confirmTransaction(
      { signature: exitRes.txSignature, ...blockhash },
      'confirmed'
    );
    report.exit.confirmMs = Date.now() - exitStart;
    console.log(`   ✅ Confirmada em ${report.exit.confirmMs} ms`);
  } catch (err: any) {
    report.status = 'FALHA_NA_SAIDA';
    report.errors.push(`Saída não confirmou on-chain: ${err?.message || err}`);
    console.error(`❌ Timeout de confirmação da saída: ${err?.message || err}`);
    console.log(`\n⚠️  Tokens possivelmente vendidos, mas não confirmados. Verifique no Solscan.`);
    return finalize();
  }

  report.exit.signature = exitRes.txSignature;
  report.exit.unitsConsumed = exitRes.unitsConsumed;
  report.exit.solReceived = exitRes.outAmount / LAMPORTS_PER_SOL;
  console.log(`🔗 Solscan: ${link(exitRes.txSignature)}`);
  console.log(`SOL recuperado na venda: ${report.exit.solReceived}`);

  // ------------------------------------------------------------------
  // FASE 4 — Limpeza e telemetria
  // ------------------------------------------------------------------
  banner('FASE 4 — LIMPEZA (FECHAMENTO DA ATA)');

  const balAfterExit = await wallet.getBalanceSol();
  const remaining = await readSplBalance(connection, owner, target.mint);

  if (remaining <= 0) {
    const close = await wallet.closeTokenAccount(target.mint);
    report.ataClosed = close.success;
    if (close.success) {
      report.rentRecoveredSol = 0.002039;
      console.log(`✅ ATA fechada. ~${report.rentRecoveredSol} SOL de rent recuperados.`);
      if (close.txSignature) console.log(`🔗 ${link(close.txSignature)}`);
    } else {
      console.warn('⚠️  Não foi possível fechar a ATA. O rent fica preso.');
    }
  } else {
    console.log(`🛡️  Ainda restam ${remaining} ${targetKey} — ATA mantida.`);
  }

  report.finalBalanceSol = await wallet.getBalanceSol();
  void balBeforeExit;
  void balAfterExit;

  report.status = 'SUCESSO_TOTAL';
  return finalize();
}

// ============================================================
// Relatório final
// ============================================================

function finalize() {
  banner('RELATÓRIO FINAL — CANARY TRADE');

  const delta = report.finalBalanceSol - report.initialBalanceSol;
  const grossCost = -delta;
  const netCost = grossCost - report.rentRecoveredSol;

  console.log(`Status                    : ${report.status}`);
  console.log(`Saldo inicial             : ${report.initialBalanceSol.toFixed(6)} SOL`);
  console.log(`Saldo final               : ${report.finalBalanceSol.toFixed(6)} SOL`);
  console.log(`Variação                  : ${delta >= 0 ? '+' : ''}${delta.toFixed(6)} SOL`);
  console.log(`Custo bruto do teste      : ${grossCost.toFixed(6)} SOL (taxas + slippage de ida e volta)`);
  console.log(`Rent recuperado (ATA)     : ${report.rentRecoveredSol.toFixed(6)} SOL`);
  console.log(`Custo líquido             : ${netCost.toFixed(6)} SOL`);

  console.log(`\nEntrada: ${report.entry.signature || '(nenhuma)'}`);
  console.log(`  Solscan: ${link(report.entry.signature)}`);
  console.log(`  CU: ${report.entry.unitsConsumed ?? 'n/d'} | Confirmação: ${report.entry.confirmMs ?? 'n/d'} ms`);

  console.log(`\nSaída: ${report.exit.signature || '(nenhuma)'}`);
  console.log(`  Solscan: ${link(report.exit.signature)}`);
  console.log(`  CU: ${report.exit.unitsConsumed ?? 'n/d'} | Confirmação: ${report.exit.confirmMs ?? 'n/d'} ms`);

  if (report.errors.length) {
    console.log('\nErros registrados:');
    report.errors.forEach((e, i) => console.log(`  ${i + 1}. ${e}`));
  }

  console.log('\n' + '='.repeat(70));
  process.exit(report.status === 'SUCESSO_TOTAL' ? 0 : 1);
}

main().catch((err) => {
  console.error('\n💥 FALHA CRÍTICA NO CANÁRIO:', err);
  report.status = 'FALHA_DE_INFRA';
  report.errors.push(err?.message || String(err));
  finalize();
});
