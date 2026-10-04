// ============================================================
// purgeOrphanToken.ts — Nexus Quant Solana
// Expurga tokens órfãos da carteira: tokens que NÃO são do agente, não têm
// rota de venda na Jupiter e travam ~0.002039 SOL de rent por conta.
//
// Sem rota de venda, a única forma de liberar a caução é zerar o saldo
// (burn) e fechar a ATA. Isso destrói o token — é intencional para resíduos
// irrisórios de dumps manuais.
//
// Uso:
//   railway run --service nexus-quant-solana npm run token:purge-ci
//   CANARY_MINT=<outro_mint> railway run ... npm run token:purge-orphan
// ============================================================

import dotenv from 'dotenv';
import {
  PublicKey,
  Transaction,
  SystemProgram,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL
} from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  createBurnCheckedInstruction,
  createCloseAccountInstruction,
  createAssociatedTokenAccountIdempotentInstruction
} from '@solana/spl-token';
import { SolanaWalletService } from '../src/blockchain/solanaWallet.js';
import { DexAggregatorService } from '../src/blockchain/dexAggregator.js';
import { assertCanonicalAtaCustody } from '../src/position/custody.js';
import { financialExitSafetyGuard, safeBigIntToNumber } from '../src/execution/financialExitSafetyGuard.js';
import { assertAtomicAmount } from '../src/execution/atomicAmount.js';

dotenv.config();

const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const RENT_EXEMPTION_SOL = 0.002039;
const SOLSCAN = 'https://solscan.io/tx/';

// Mint padrão: 'CI' (BAGS), órfão aprovado por engano e sem rota de saída.
const TARGET_MINT = process.env.CANARY_MINT || '8GVpskBJveXmJ4NRxcQrVAU6X3Hq7WYrUp4gq7q2BAGS';

function banner(t: string) {
  console.log('\n' + '='.repeat(66));
  console.log(`  ${t}`);
  console.log('='.repeat(66));
}

async function main() {
  banner('PURGA DE TOKEN ÓRFÃO — NEXUS QUANT SOLANA');

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
  const mint = new PublicKey(TARGET_MINT);
  const ata = await getAssociatedTokenAddress(mint, owner);
  assertCanonicalAtaCustody(owner.toBase58(), TARGET_MINT, ata.toBase58());

  console.log(`Conta : ${owner.toBase58()}`);
  console.log(`Mint  : ${TARGET_MINT}`);
  console.log(`ATA   : ${ata.toBase58()}`);

  const initialSol = await wallet.getBalanceSol();
  console.log(`\n💰 Saldo SOL inicial: ${initialSol.toFixed(6)}`);

  // ------------------------------------------------------------------
  // 1. Existe conta?
  // ------------------------------------------------------------------
  banner('1. VERIFICAÇÃO DA CONTA');

  const acct = await connection.getAccountInfo(ata);
  if (!acct) {
    console.log('✅ A ATA não existe on-chain. Nada a purgar.');
    process.exit(0);
  }

  const bal = await connection.getTokenAccountBalance(ata);
  const rawString = bal?.value?.amount || '0';
  assertAtomicAmount(rawString);
  const rawAmount = BigInt(rawString);
  const ui = Number(bal.value.uiAmountString);
  const decimals = bal.decimals;

  console.log(`Saldo bruto (atomic) : ${bal.value.amount}`);
  console.log(`Saldo legível (UI)  : ${ui}`);
  console.log(`Decimais            : ${decimals}`);

  if (rawAmount === 0n) {
    console.log('Saldo já é zero — apenas fechando a ATA.');
  }

  let lockAcquired = false;
  if (rawAmount > 0n) {
    const lock = financialExitSafetyGuard.acquireExitLock(TARGET_MINT, rawAmount);
    if (!lock.allowed) {
      console.error(`❌ Purga bloqueada pelo safety guard: ${lock.reason || lock.code}`);
      process.exit(1);
    }
    lockAcquired = true;
  }

  try {
    // ------------------------------------------------------------------
    // 2. Tentar vender na Jupiter
    // ------------------------------------------------------------------
    banner('2. TENTATIVA DE VENDA (JUPITER)');

    if (rawAmount > 0n) {
      const aggregator = new DexAggregatorService();
      try {
        const quote = await aggregator.getQuote({
          inputMint: TARGET_MINT,
          outputMint: SOL_MINT,
          amountLamports: safeBigIntToNumber(rawAmount, 'purgeOrphanToken_quote'),
          slippageBps: 500
        });
        const solOut = quote.outAmount / LAMPORTS_PER_SOL;
        console.log(`Rota        : ${quote.routePlanSummary}`);
        console.log(`SOL esperado: ${solOut.toFixed(9)}`);

        if (solOut > 0.000001) {
          console.log('✅ Rota de venda viável — use /api/wallet/liquidate-holding no painel.');
          console.log('   (A purga destrói o token; prefira vender se houver rota.)');
          process.exit(2);
        }
        console.log('Retorno irrisório — sem rota útil.');
      } catch (err: any) {
        console.log(`Sem rota de venda: ${err?.message || err}`);
      }
      console.log('➜ Prosseguindo para burn + fechamento da ATA.');
    }

    // ------------------------------------------------------------------
    // 3. Queimar o saldo e fechar a ATA
    // ------------------------------------------------------------------
    banner('3. BURN + FECHAMENTO DA ATA');

    const lamports = await connection.getLatestBlockhash('confirmed');
    const tx = new Transaction({ feePayer: owner, recentBlockhash: lamports.blockhash });

    // Garante que a ATA exista (idempotente) antes de operar nela.
    tx.add(
      createAssociatedTokenAccountIdempotentInstruction(
        owner,
        ata,
        mint,
        TOKEN_PROGRAM
      )
    );

    if (rawAmount > 0n) {
      tx.add(
        createBurnCheckedInstruction(
          ata,
          mint,
          owner,
          rawAmount,
          [],
          TOKEN_PROGRAM
        )
      );
      console.log(`🔥 Burn de ${bal.value.amount} unidades (${ui} tokens).`);
    }

    tx.add(
      createCloseAccountInstruction(
        ata,
        owner, // destino do rent
        owner, // autoridade
        [],
        TOKEN_PROGRAM
      )
    );
    console.log(`🔒 Fechamento da ATA → ${owner.toBase58()} (~${RENT_EXEMPTION_SOL} SOL).`);

    try {
      const sig = await sendAndConfirmTransaction(connection, tx, [keypair], {
        commitment: 'confirmed',
        preflightCommitment: 'confirmed'
      });
      const sigStatus = await connection.getSignatureStatus(sig);
      if (sigStatus?.value?.err) {
        throw new Error(`Transação de burn/close falhou on-chain: ${JSON.stringify(sigStatus.value.err)}`);
      }
      console.log(`\n✅ Transação confirmada`);
      console.log(`🔗 ${SOLSCAN}${sig}`);
    } catch (err: any) {
      console.error(`\n❌ Falha ao executar burn/close: ${err?.message || err}`);
      const logs = err?.transactionLogs;
      if (logs?.length) console.error('Logs on-chain:', logs.join(' | '));
      process.exit(1);
    }
  } finally {
    if (lockAcquired) {
      financialExitSafetyGuard.releaseExitLock(TARGET_MINT);
    }
  }

  // ------------------------------------------------------------------
  // 4. Verificação
  // ------------------------------------------------------------------
  banner('4. VERIFICAÇÃO');

  const stillThere = await connection.getAccountInfo(ata);
  console.log(`ATA ainda existe on-chain: ${stillThere !== null ? 'SIM (falha)' : 'NÃO (ok)'}`);

  if (stillThere !== null) {
    console.error('\n⚠️  A ATA não foi fechada. Token pode ter sido queimado sem o fechamento.');
    process.exit(1);
  }

  const finalSol = await wallet.getBalanceSol();
  const delta = finalSol - initialSol;
  console.log(`Saldo SOL final   : ${finalSol.toFixed(6)}`);
  console.log(`Delta             : ${delta >= 0 ? '+' : ''}${delta.toFixed(6)} SOL`);
  console.log(`Status            : PURGA_CONCLUIDA`);
  console.log('\n' + '='.repeat(66));
  process.exit(0);
}

main().catch((err) => {
  console.error('\n💥 FALHA CRÍTICA:', err);
  process.exit(1);
});
