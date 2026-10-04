// ============================================================
// rescueJup.ts — Nexus Quant Solana
// Resgate de tokens presos em ATA + recuperação do rent exemption.
//
// Contexto: o canário comprou 5.389317 JUP e, por um bug de conversão de
// unidades (uiAmount tratado como atomic), vendeu apenas 5 lamports.
// Este script lê o saldo BRUTO (value.amount), vende o total e fecha a ATA.
//
// Uso:  railway run --service nexus-quant-solana npm run trade:rescue
// ============================================================

import dotenv from 'dotenv';
import { PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { getAssociatedTokenAddress } from '@solana/spl-token';
import { SolanaWalletService } from '../src/blockchain/solanaWallet.js';
import { JupiterExecutionEngine } from '../src/blockchain/jupiterExecutionEngine.js';
import { DexAggregatorService } from '../src/blockchain/dexAggregator.js';
import { assertCanonicalAtaCustody } from '../src/position/custody.js';
import { financialExitSafetyGuard, safeBigIntToNumber } from '../src/execution/financialExitSafetyGuard.js';
import { atomicToUiAmount } from '../src/execution/atomicAmount.js';

dotenv.config();

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const JUP_MINT = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';
const RENT_EXEMPTION_SOL = 0.002039;
const SOLSCAN = 'https://solscan.io/tx/';

function banner(t: string) {
  console.log('\n' + '='.repeat(66));
  console.log(`  ${t}`);
  console.log('='.repeat(66));
}

async function main() {
  banner('RESGATE DE JUP — NEXUS QUANT SOLANA');

  const rpcUrl = process.env.HELIUS_RPC_URL || process.env.QUICKNODE_RPC_URL || process.env.SOLANA_RPC_URL;
  if (!rpcUrl) {
    console.error('RPC não configurado.');
    process.exit(1);
  }

  const wallet = new SolanaWalletService({
    secretKeyRaw: process.env.AGENT_SOLANA_PRIVATE_KEY || '[]',
    rpcUrl
  });
  const connection = wallet.getConnection();
  const keypair = wallet.getKeypair();
  const owner = keypair.publicKey;
  const jup = new PublicKey(JUP_MINT);
  const ata = await getAssociatedTokenAddress(jup, owner);
  assertCanonicalAtaCustody(owner.toBase58(), JUP_MINT, ata.toBase58());

  console.log(`Conta : ${owner.toBase58()}`);
  console.log(`RPC   : ${rpcUrl.split('?')[0]}`);
  console.log(`ATA   : ${ata.toBase58()}`);

  const initialSol = await wallet.getBalanceSol();
  console.log(`\n💰 Saldo SOL inicial: ${initialSol.toFixed(6)}`);

  // ------------------------------------------------------------------
  // 1. Saldo BRUTO (atomic units) — nunca uiAmount
  // ------------------------------------------------------------------
  banner('1. LEITURA DO SALDO BRUTO');

  const bal = await connection.getTokenAccountBalance(ata);
  const rawAmount = bal?.value?.amount;

  if (!rawAmount) {
    console.error('❌ Não foi possível ler o token account balance.');
    process.exit(1);
  }

  const raw = BigInt(rawAmount);
  const ui = Number(bal.value.uiAmountString);

  console.log(`Saldo bruto (atomic) : ${rawAmount}`);
  console.log(`Saldo legível (UI)  : ${ui} JUP`);

  if (raw === 0n) {
    console.log('\n✅ Saldo zero. Nada a resgatar.');
    const close = await wallet.closeTokenAccount(JUP_MINT);
    if (close.success) {
      console.log(`✅ ATA fechada. ~${RENT_EXEMPTION_SOL} SOL de rent recuperados.`);
    } else {
      console.log('⚠️  ATA não pôde ser fechada.');
    }
    const finalSol = await wallet.getBalanceSol();
    console.log(`Saldo SOL final: ${finalSol.toFixed(6)} (Δ ${(finalSol - initialSol).toFixed(6)})`);
    process.exit(0);
  }

  // ------------------------------------------------------------------
  // 2. Quote com amount bruto
  // ------------------------------------------------------------------
  banner('2. COTAÇÃO DE SAÍDA');

  const lock = financialExitSafetyGuard.acquireExitLock(JUP_MINT, raw);
  if (!lock.allowed) {
    console.error(`❌ Saída bloqueada pelo safety guard: ${lock.reason || lock.code}`);
    process.exit(1);
  }

  const aggregator = new DexAggregatorService();
  const engine = new JupiterExecutionEngine({
    connection,
    isDryRun: false,
    dexAggregator: aggregator
  });

  let sold = false;
  let exitSig = '';

  try {
    let quote;
    try {
      quote = await aggregator.getQuote({
        inputMint: JUP_MINT,
        outputMint: SOL_MINT,
        amountLamports: safeBigIntToNumber(raw, 'rescueJup_quote_amount'),
        slippageBps: 100
      });
    } catch (err: any) {
      console.error(`❌ Falha na cotação: ${err?.message || err}`);
      process.exit(1);
    }

    const expectedSol = quote.outAmount / LAMPORTS_PER_SOL;
    console.log(`Rota           : ${quote.routePlanSummary}`);
    console.log(`Price Impact   : ${(quote.priceImpactPct || 0).toFixed(4)}%`);
    console.log(`Amount bruto   : ${raw}`);
    console.log(`SOL esperado   : ${expectedSol.toFixed(6)}`);

    if (expectedSol <= 0.0001) {
      console.error('\n❌ Cotação devolve valor irrisório — abortando para não gastar taxa à toa.');
      process.exit(1);
    }

    // ------------------------------------------------------------------
    // 3. Swap de saída (com retentativa a 200 bps)
    // ------------------------------------------------------------------
    banner('3. VENDA');

    const blockhash = await connection.getLatestBlockhash('confirmed');

    for (const slippageBps of [100, 200]) {
      console.log(`\nTentando saída com slippage ${slippageBps} bps...`);
      const res = await engine.executeSwap({
        inputMint: JUP_MINT,
        outputMint: SOL_MINT,
        amountLamports: safeBigIntToNumber(raw, 'rescueJup_executeSwap_amount'),
        slippageBps,
        autoSlippage: false,
        skipPreflight: false,
        userPublicKey: owner.toBase58(),
        keypair,
        priorityLevel: 'veryHigh'
      });

      if (res.status === 'SUBMITTED_UNCONFIRMED') {
        console.error(`   🛑 [SUBMITTED_UNCONFIRMED] Transação pode estar viva on-chain! Registrando dívida e bloqueando nova tentativa.`);
        financialExitSafetyGuard.registerUnresolvedDebt(JUP_MINT);
        if (res.txSignature) {
          console.log(`   🔍 Tentando reconciliar assinatura ${res.txSignature}...`);
          const reconciled = await wallet.reconcileExactTransaction({
            signature: res.txSignature,
            mintAddress: JUP_MINT,
            expectedOwner: owner.toBase58(),
            direction: 'OUT'
          });
          if (reconciled && reconciled.success && BigInt(reconciled.deltaAtomic) < 0n) {
            console.log(`   ✅ Reconciliada com sucesso após timeout! Solscan: ${SOLSCAN}${res.txSignature}`);
            financialExitSafetyGuard.clearUnresolvedDebt(JUP_MINT);
            exitSig = res.txSignature;
            sold = true;
            break;
          }
        }
        // Inconclusiva: bloqueia segundo envio e aborta
        break;
      }

      if (res.status !== 'SUCCESS') {
        console.error(`   ❌ Falhou: ${res.error}`);
        continue;
      }

      console.log(`   ⏳ Assinatura: ${res.txSignature}`);
      console.log(`   CU: ${res.unitsConsumed ?? 'n/d'}`);
      try {
        await connection.confirmTransaction(
          { signature: res.txSignature, ...blockhash },
          'confirmed'
        );
        // Verificação econômica de landing por assinatura exata (Finding R-P0-03)
        const reconciled = await wallet.reconcileExactTransaction({
          signature: res.txSignature,
          mintAddress: JUP_MINT,
          expectedOwner: owner.toBase58(),
          direction: 'OUT'
        });
        if (reconciled && reconciled.error) {
          console.error(`   ❌ Reconciliação acusou erro on-chain: ${reconciled.error}`);
          continue;
        }
        console.log(`   ✅ Confirmada e reconciliada on-chain. Solscan: ${SOLSCAN}${res.txSignature}`);
        exitSig = res.txSignature;
        sold = true;
        break;
      } catch (err: any) {
        console.error(`   ❌ Timeout de confirmação/reconciliação: ${err?.message || err}`);
      }
    }
  } finally {
    financialExitSafetyGuard.releaseExitLock(JUP_MINT);
  }

  if (!sold) {
    console.error('\n❌ Não foi possível vender. Tokens permanecem na carteira.');
    console.error(`   Resgate manual: ${SOLSCAN} ou Jupiter UI.`);
    process.exit(1);
  }

  // ------------------------------------------------------------------
  // 4. Fechar a ATA
  // ------------------------------------------------------------------
  banner('4. FECHAMENTO DA ATA');

  const afterSwap = await connection.getTokenAccountBalance(ata);
  const remainingRaw = BigInt(afterSwap?.value?.amount || '0');
  console.log(`Saldo bruto restante: ${remainingRaw}`);

  let ataClosed = false;
  if (remainingRaw === 0n) {
    const close = await wallet.closeTokenAccount(JUP_MINT);
    ataClosed = close.success;
    if (close.success) {
      console.log(`✅ ATA fechada. ~${RENT_EXEMPTION_SOL} SOL de rent recuperados.`);
      if (close.txSignature) console.log(`   ${SOLSCAN}${close.txSignature}`);
    } else {
      console.log('⚠️  Falha ao fechar a ATA.');
    }
  } else {
    console.log(`🛡️  Restam ${atomicToUiAmount(remainingRaw.toString(), 6)} JUP — ATA mantida.`);
  }

  // ------------------------------------------------------------------
  // 5. Relatório
  // ------------------------------------------------------------------
  banner('RELATÓRIO');

  const finalSol = await wallet.getBalanceSol();
  const recovered = finalSol - initialSol;

  console.log(`Status              : ${sold && ataClosed ? 'RESGATE_COMPLETO' : 'PARCIAL'}`);
  console.log(`Saldo SOL inicial   : ${initialSol.toFixed(6)}`);
  console.log(`Saldo SOL final     : ${finalSol.toFixed(6)}`);
  console.log(`Recuperado         : ${recovered >= 0 ? '+' : ''}${recovered.toFixed(6)} SOL`);
  console.log(`Tx de venda         : ${exitSig || '(nenhuma)'}`);
  console.log(`Solscan             : ${exitSig ? SOLSCAN + exitSig : '-'}`);
  console.log('\n' + '='.repeat(66));

  process.exit(sold && ataClosed ? 0 : 1);
}

main().catch((err) => {
  console.error('\n💥 FALHA CRÍTICA:', err);
  process.exit(1);
});
