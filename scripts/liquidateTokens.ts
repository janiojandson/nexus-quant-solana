import { Connection, Keypair, VersionedTransaction, PublicKey, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import { createCloseAccountInstruction, getAssociatedTokenAddress } from '@solana/spl-token';
import axios from 'axios';
import dotenv from 'dotenv';
dotenv.config();

const SECRET_KEY_RAW = process.env.AGENT_SOLANA_PRIVATE_KEY || '[]';
const keypair = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(SECRET_KEY_RAW)));
const owner = keypair.publicKey;
const connection = new Connection(process.env.HELIUS_RPC_URL || 'https://api.mainnet-beta.solana.com', 'confirmed');

console.log('Iniciando liquidação total para a carteira:', owner.toBase58());

async function sellToken(symbol: string, mintStr: string) {
  try {
    const mint = new PublicKey(mintStr);
    const ata = await getAssociatedTokenAddress(mint, owner);
    const accountInfo = await connection.getParsedAccountInfo(ata);
    if (!accountInfo.value) {
      console.log('Conta ATA para ' + symbol + ' não encontrada ou vazia.');
      return;
    }
    const tokenData = (accountInfo.value.data as any).parsed.info.tokenAmount;
    const amount = tokenData.amount;
    const uiAmount = tokenData.uiAmount;

    if (uiAmount <= 0) {
      console.log('Saldo zerado para ' + symbol + '.');
      return;
    }

    console.log('\n=========================================');
    console.log('🔥 Liquidando ' + Number(uiAmount).toLocaleString() + ' de ' + symbol + ' (' + mintStr + ')...');

    // 1. Cotação na Jupiter
    const quoteRes = await axios.get('https://public.jupiterapi.com/quote', {
      params: {
        inputMint: mintStr,
        outputMint: 'So11111111111111111111111111111111111111112',
        amount: amount,
        slippageBps: 200 // 2.0% slippage
      },
      timeout: 8000
    });

    const quote = quoteRes.data;
    console.log('   Retorno Estimado: ' + (quote.outAmount / 1e9).toFixed(5) + ' SOL');

    // 2. Montar transação de swap
    const swapRes = await axios.post('https://public.jupiterapi.com/swap', {
      quoteResponse: quote,
      userPublicKey: owner.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: {
        priorityLevelWithMaxLamports: {
          maxLamports: 2000000,
          priorityLevel: 'medium'
        }
      }
    }, { timeout: 8000 });

    const swapBuf = Buffer.from(swapRes.data.swapTransaction, 'base64');
    const transaction = VersionedTransaction.deserialize(swapBuf);
    transaction.sign([keypair]);

    console.log('   Transmitindo Swap na Solana...');
    const txid = await connection.sendRawTransaction(transaction.serialize(), {
      skipPreflight: false,
      maxRetries: 3
    });
    console.log('   ✅ Swap Concluído! Tx: ' + txid);

    // Aguarda confirmação antes de fechar conta
    await new Promise(r => setTimeout(r, 4500));

    // 3. Fechar conta ATA para recolher caução
    console.log('   Fechando conta ATA para resgatar ~0.00204 SOL de aluguel...');
    try {
      const closeIx = createCloseAccountInstruction(ata, owner, owner);
      const closeTx = new Transaction().add(closeIx);
      const { blockhash } = await connection.getLatestBlockhash('confirmed');
      closeTx.recentBlockhash = blockhash;
      closeTx.feePayer = owner;

      const closeTxid = await sendAndConfirmTransaction(connection, closeTx, [keypair]);
      console.log('   💰 ATA Fechada! Caução de aluguel resgatada. Tx: ' + closeTxid);
    } catch (e: any) {
      console.log('   ⚠️ Não foi possível fechar ATA (pode requerer mais alguns segundos): ' + (e.message || e));
    }
  } catch (err: any) {
    console.error('   ❌ Erro ao liquidar ' + symbol + ':', err.response?.data || err.message || err);
  }
}

async function main() {
  const tokens = [
    { symbol: 'PKMN50', mint: '3RNy7erxjwGRRYvM6KzVKVtuFnNSpkQFwwiHhUH26xoa' },
    { symbol: 'PSA10', mint: '2F1mZ9znwpC3NZRsXKSnq4ejgBiL9sRboZRUuN94wLWM' },
    { symbol: 'SPOT', mint: 'Ct1tR17mRtpdf3WsMqSeFEVmw6ThdyoBtLPiW5Hqspot' }
  ];

  for (const t of tokens) {
    await sellToken(t.symbol, t.mint);
  }

  const finalBalanceLamports = await connection.getBalance(owner);
  console.log('\n=========================================');
  console.log('🎉 Liquidação Finalizada! Saldo Total Atual: ' + (finalBalanceLamports / 1e9).toFixed(4) + ' SOL');
  console.log('=========================================');
}

main();
