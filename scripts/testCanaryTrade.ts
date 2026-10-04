// ============================================================
// testCanaryTrade.ts — Nexus Quant Solana
// Teste on-chain controlado: compra e venda imediatas de um ativo líquido
// (JUP/USDC) para auditar TODO o pipeline de execução real.
//
// Blindagens (ver commit 53dbfdd e a correção de unidades):
//   1. Todo saldo de token é lido em unidades ATÔMICAS (value.amount).
//      Nunca uiAmount — Math.floor(5.389267) = 5 e a posição fica presa.
//   2. SUCESSO_TOTAL exige: saldo zero na ATA + ATA fechada + perda <= 0.0015 SOL.
//   3. A saída tenta 2x: 500 bps e, se falhar, 200 bps de slippage.
//
// NÃO grava nada no Decision Journal, na quarentena nem no positionEngine:
// este script é um probe de infraestrutura, não uma operação de estratégia.
//
// Uso (dentro do Railway, com as variáveis de produção injetadas):
//   railway run --service nexus-quant-solana npm run trade:canary
// ============================================================

import dotenv from 'dotenv';
import { PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { getAssociatedTokenAddress } from '@solana/spl-token';
import { SolanaWalletService } from '../src/blockchain/solanaWallet.js';
import { JupiterExecutionEngine } from '../src/blockchain/jupiterExecutionEngine.js';
import { DexAggregatorService } from '../src/blockchain/dexAggregator.js';
import { AdaptivePositionSizer, MIN_TRADE_AMOUNT_SOL } from '../src/blockchain/adaptivePositionSizer.js';
import {
  assertAtomicAmount,
  atomicToUiAmount,
  evaluateCapitalReturn
} from '../src/execution/atomicAmount.js';
import { assertCanonicalAtaCustody } from '../src/position/custody.js';
import { financialExitSafetyGuard, safeBigIntToNumber } from '../src/execution/financialExitSafetyGuard.js';

dotenv.config();

const SOL_MINT = 'So11111111111111111111111111111111111111112';

const TARGETS: Record<string, { mint: string; label: string; decimals: number }> = {
  JUP: { mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', label: 'Jupiter', decimals: 6 },
  USDC: { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', label: 'USD Coin', decimals: 6 }
};

const SOLSCAN = 'https://solscan.io/tx/';
const WAIT_SECONDS = 5;
const EXIT_SLIPPAGE_BPS = [500, 200];

// ============================================================
// Telemetria
// ============================================================

interface Phase {
  signature: string | null;
  unitsConsumed?: number;
  confirmMs?: number;
  atomicAmount?: string;
  uiAmount?: number;
}

type CanaryStatus =
  | 'SUCESSO_TOTAL'
  | 'FALHA_NA_ENTRADA'
  | 'FALHA_NA_SAIDA'
  | 'FALHA_RETORNO_CAPITAL'
  | 'FALHA_DE_INFRA';

interface Report {
  entry: Phase;
  exit: Phase;
  initialBalanceSol: number;
  finalBalanceSol: number;
  rentRecoveredSol: number;
  ataClosed: boolean;
  remainingAtomic: string;
  status: CanaryStatus;
  errors: string[];
}

const report: Report = {
  entry: { signature: null },
  exit: { signature: null },
  initialBalanceSol: 0,
  finalBalanceSol: 0,
  rentRecoveredSol: 0,
  ataClosed: false,
  remainingAtomic: '0',
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

/**
 * Lê o saldo SPL em unidades ATÔMICAS.
 * Retorna a string bruta de `value.amount` — nunca uiAmount.
 */
async function readAtomicBalance(connection: any, ata: PublicKey): Promise<string> {
  const res = await connection.getTokenAccountBalance(ata);
  const amount = res?.value?.amount;
  if (typeof amount !== 'string' || !/^\d+$/.test(amount)) {
    throw new Error(`Resposta de getTokenAccountBalance invalida: ${JSON.stringify(res?.value)}`);
  }
  return amount;
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
  console.log(`Ativo alvo      : ${targetKey} (${target.label}, ${target.decimals} decimais)`);
  console.log(`Mint             : ${target.mint}`);
  console.log(`RPC              : ${rpcUrl.split('?')[0]}`);
  console.log(`Lote             : ${MIN_TRADE_AMOUNT_SOL} SOL (piso do sizing adaptativo)`);
  console.log(`Teto de slippage : 750 bps (entrada) | ${EXIT_SLIPPAGE_BPS.join(' -> ')} bps (saída)`);

  const wallet = new SolanaWalletService({
    secretKeyRaw: process.env.AGENT_SOLANA_PRIVATE_KEY || '[]',
    rpcUrl
  });
  const connection = wallet.getConnection();
  const keypair = wallet.getKeypair();
  const owner = keypair.publicKey;
  const ata = await getAssociatedTokenAddress(new PublicKey(target.mint), owner);
  assertCanonicalAtaCustody(owner.toBase58(), target.mint, ata.toBase58());

  const initialBalance = await wallet.getBalanceSol();
  report.initialBalanceSol = initialBalance;
  console.log(`Conta            : ${owner.toBase58()}`);
  console.log(`ATA              : ${ata.toBase58()}`);
  console.log(`\n💰 Saldo inicial: ${initialBalance.toFixed(6)} SOL`);

  if (initialBalance <= MIN_TRADE_AMOUNT_SOL + 0.01) {
    console.error(`Saldo insuficiente para o canário (necessário ~${(MIN_TRADE_AMOUNT_SOL + 0.01).toFixed(4)} SOL).`);
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
  console.log(`   outAmount      : ${sizing.quote.outAmount} (atomic)`);

  // Blockhash capturado ANTES do envio — confirmar com blockhash posterior
  // pode referenciar outro slot e reprovar uma tx já incluída.
  const entryBlockhash = await connection.getLatestBlockhash('confirmed');
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

  console.log(`\n⏳ Assinatura: ${entryRes.txSignature}`);
  console.log(`   Compute Units: ${entryRes.unitsConsumed ?? 'n/d'}`);
  try {
    await connection.confirmTransaction(
      { signature: entryRes.txSignature, ...entryBlockhash },
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
  console.log(`🔗 Solscan: ${link(entryRes.txSignature)}`);

  // ------------------------------------------------------------------
  // FASE 2 — Confirmação em unidades atômicas
  // ------------------------------------------------------------------
  banner('FASE 2 — CONFIRMAÇÃO DE RECEBIMENTO E ESPERA');

  let receivedAtomic: string;
  try {
    receivedAtomic = await readAtomicBalance(connection, ata);
  } catch (err: any) {
    report.status = 'FALHA_NA_ENTRADA';
    report.errors.push(`Leitura de saldo falhou: ${err?.message || err}`);
    console.error(`❌ ${err?.message || err}`);
    return finalize();
  }

  const receivedUi = atomicToUiAmount(receivedAtomic, target.decimals);
  report.entry.atomicAmount = receivedAtomic;
  report.entry.uiAmount = receivedUi;
  console.log(`Saldo bruto (atomic): ${receivedAtomic}`);
  console.log(`Saldo legível (UI)  : ${receivedUi} ${targetKey}`);

  // Validação dura: o que entrou na carteira precisa estar em atomic.
  try {
    assertAtomicAmount(receivedAtomic);
  } catch (err: any) {
    report.status = 'FALHA_NA_ENTRADA';
    report.errors.push(err.message);
    console.error(`❌ ${err.message}`);
    return finalize();
  }

  if (BigInt(receivedAtomic) <= 0n) {
    report.status = 'FALHA_NA_ENTRADA';
    report.errors.push('Nenhum token recebido apesar da confirmação da transação.');
    console.error('❌ Nenhum token recebido.');
    return finalize();
  }

  console.log(`\nAguardando ${WAIT_SECONDS}s antes da saída...`);
  await sleepCountdown(WAIT_SECONDS);

  // ------------------------------------------------------------------
  // FASE 3 — Saída com retentativa
  // ------------------------------------------------------------------
  banner('FASE 3 — SAÍDA (VENDA REAL 100%)');

  // SALDO ATÔMICO, nunca uiAmount. Este é o ponto exato onde o canário
  // anterior vendia 5 lamports em vez de 5,4 milhões.
  const sellAtomic = await readAtomicBalance(connection, ata);
  const sellAtomicBig = assertAtomicAmount(sellAtomic);
  console.log(`Montante de venda (atomic): ${sellAtomic}`);
  console.log(`Montante de venda (UI)   : ${atomicToUiAmount(sellAtomic, target.decimals)} ${targetKey}`);

  const exitBlockhash = await connection.getLatestBlockhash('confirmed');
  const exitStart = Date.now();
  let sold = false;

  const lockResult = financialExitSafetyGuard.acquireExitLock(target.mint, sellAtomicBig);
  if (!lockResult.allowed) {
    report.status = 'FALHA_NA_SAIDA';
    report.errors.push(`Lock de saída rejeitado: ${lockResult.reason || lockResult.code}`);
    console.error(`❌ Lock de saída rejeitado: ${lockResult.reason || lockResult.code}`);
    return finalize();
  }

  try {
    for (let attempt = 0; attempt < EXIT_SLIPPAGE_BPS.length; attempt++) {
      const slippageBps = EXIT_SLIPPAGE_BPS[attempt];
      const label = attempt === 0 ? 'tentativa padrão' : `retentativa ${attempt + 1}`;
      console.log(`\n${label} — slippage ${slippageBps} bps...`);

      try {
        const res = await engine.executeSwap({
          inputMint: target.mint,
          outputMint: SOL_MINT,
          amountLamports: safeBigIntToNumber(sellAtomicBig, 'testCanaryTrade_sellAtomicBig'),
          slippageBps,
          autoSlippage: false,
          skipPreflight: false,
          userPublicKey: owner.toBase58(),
          keypair,
          priorityLevel: 'veryHigh'
        });

        if (res.status !== 'SUCCESS') {
          console.error(`   ❌ Falhou: ${res.error}`);
          report.errors.push(`Saída (${slippageBps} bps): ${res.error}`);
          continue;
        }

        console.log(`   ⏳ Assinatura: ${res.txSignature}`);
        console.log(`   CU: ${res.unitsConsumed ?? 'n/d'}`);
        await connection.confirmTransaction(
          { signature: res.txSignature, ...exitBlockhash },
          'confirmed'
        );

        // Verificação econômica de landing por assinatura exata (Finding R-P0-03)
        const reconciled = await wallet.reconcileExactTransaction({
          signature: res.txSignature,
          mintAddress: target.mint,
          expectedOwner: owner.toBase58(),
          direction: 'OUT'
        });
        if (reconciled && reconciled.error) {
          console.error(`   ❌ Reconciliação acusou erro on-chain: ${reconciled.error}`);
          report.errors.push(`Reconciliação da saída falhou: ${reconciled.error}`);
          continue;
        }

        report.exit.confirmMs = Date.now() - exitStart;
        report.exit.signature = res.txSignature;
        report.exit.unitsConsumed = res.unitsConsumed;
        report.exit.atomicAmount = String(res.outAmount);
        report.exit.uiAmount = res.outAmount / LAMPORTS_PER_SOL;
        console.log(`   ✅ Confirmada em ${report.exit.confirmMs} ms`);
        console.log(`   SOL recuperado: ${report.exit.uiAmount}`);
        console.log(`   Solscan: ${link(res.txSignature)}`);
        sold = true;
        break;
      } catch (err: any) {
        console.error(`   ❌ Erro: ${err?.message || err}`);
        report.errors.push(`Saída (${slippageBps} bps): ${err?.message || err}`);
      }
    }
  } finally {
    financialExitSafetyGuard.releaseExitLock(target.mint);
  }

  if (!sold) {
    report.status = 'FALHA_NA_SAIDA';
    console.log(`\n⚠️  ATENÇÃO: os tokens de ${targetKey} PERMANECEM na carteira.`);
    console.log(`   Resgate manual: ${link(ata.toBase58())} ou Jupiter UI.`);
    console.log(`   ATA: ${ata.toBase58()}`);
    return finalize();
  }

  // ------------------------------------------------------------------
  // FASE 4 — Limpeza e veredito de capital
  // ------------------------------------------------------------------
  banner('FASE 4 — LIMPEZA E VEREDITO DE CAPITAL');

  // Re-leitura ATÔMICA: o saldo zero real vem do RPC, não do outAmount da quote.
  let remainingAtomic = '0';
  try {
    remainingAtomic = await readAtomicBalance(connection, ata);
  } catch (err: any) {
    report.errors.push(`Falha ao re-ler saldo: ${err?.message || err}`);
  }
  report.remainingAtomic = remainingAtomic;
  console.log(`Saldo bruto remanescente: ${remainingAtomic}`);

  if (BigInt(remainingAtomic) === 0n) {
    const close = await wallet.closeTokenAccount(target.mint);
    report.ataClosed = close.success;
    if (close.success) {
      report.rentRecoveredSol = 0.002039;
      console.log(`✅ ATA fechada. ~${report.rentRecoveredSol} SOL de rent recuperados.`);
      if (close.txSignature) console.log(`🔗 ${link(close.txSignature)}`);
    } else {
      console.warn('⚠️  Falha ao fechar a ATA.');
    }
  } else {
    console.log(`🛡️  Restam ${atomicToUiAmount(remainingAtomic, target.decimals)} ${targetKey} — ATA mantida.`);
  }

  // Veredito final: a ATA só conta como fechada se sumiu do chain.
  let ataClosedOnChain = false;
  if (report.ataClosed) {
    const info = await connection.getAccountInfo(ata);
    ataClosedOnChain = info === null;
    console.log(`ATA ausente on-chain: ${ataClosedOnChain ? 'sim' : 'NAO'}`);
    if (!ataClosedOnChain) report.ataClosed = false;
  }

  report.finalBalanceSol = await wallet.getBalanceSol();

  const verdict = evaluateCapitalReturn({
    initialBalanceSol: report.initialBalanceSol,
    finalBalanceSol: report.finalBalanceSol,
    remainingAtomicAmount: remainingAtomic,
    ataClosed: report.ataClosed && ataClosedOnChain
  });

  report.status = verdict.ok ? 'SUCESSO_TOTAL' : 'FALHA_RETORNO_CAPITAL';
  if (!verdict.ok) report.errors.push(`Retorno de capital: ${verdict.reason}`);

  return finalize();
}

// ============================================================
// Relatório final
// ============================================================

function finalize() {
  banner('RELATÓRIO FINAL — CANARY TRADE');

  const delta = report.finalBalanceSol - report.initialBalanceSol;
  const lossSol = -delta;
  const netLoss = lossSol - report.rentRecoveredSol;

  console.log(`Status                    : ${report.status}`);
  console.log(`Saldo inicial             : ${report.initialBalanceSol.toFixed(6)} SOL`);
  console.log(`Saldo final               : ${report.finalBalanceSol.toFixed(6)} SOL`);
  console.log(`Variação                  : ${delta >= 0 ? '+' : ''}${delta.toFixed(6)} SOL`);
  console.log(`Perda bruta               : ${lossSol.toFixed(6)} SOL`);
  console.log(`Rent recuperado (ATA)     : ${report.rentRecoveredSol.toFixed(6)} SOL`);
  console.log(`Perda líquida             : ${netLoss.toFixed(6)} SOL`);
  console.log(`Saldo remanescente (atomic): ${report.remainingAtomic}`);
  console.log(`ATA fechada               : ${report.ataClosed}`);

  console.log(`\nEntrada: ${report.entry.signature || '(nenhuma)'}`);
  console.log(`  Solscan: ${link(report.entry.signature)}`);
  console.log(`  Atomic recebido: ${report.entry.atomicAmount ?? 'n/d'}`);
  console.log(`  CU: ${report.entry.unitsConsumed ?? 'n/d'} | Confirmação: ${report.entry.confirmMs ?? 'n/d'} ms`);

  console.log(`\nSaída: ${report.exit.signature || '(nenhuma)'}`);
  console.log(`  Solscan: ${link(report.exit.signature)}`);
  console.log(`  CU: ${report.exit.unitsConsumed ?? 'n/d'} | Confirmação: ${report.exit.confirmMs ?? 'n/d'} ms`);

  if (report.errors.length) {
    console.log('\nProblemas registrados:');
    report.errors.forEach((e, i) => console.log(`  ${i + 1}. ${e}`));
  }

  if (report.status !== 'SUCESSO_TOTAL') {
    console.log('\n⛔ Veredito NÃO é sucesso. Investigue antes de confiar no pipeline.');
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
