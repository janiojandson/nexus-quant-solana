const readline = require('readline');
const bip39 = require('bip39');
const { derivePath } = require('ed25519-hd-key');
const { Keypair } = require('@solana/web3.js');
const fs = require('fs');
const path = require('path');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

console.log('===========================================================');
console.log('🔐 DERIVADOR SEGURO LOCAL DE CHAVE SOLANA (PHANTOM)');
console.log('Executado 100% offline na sua máquina - sem envio para rede.');
console.log('===========================================================');

rl.question('\nDigite ou cole suas 12 ou 24 palavras (separadas por espaço):\n> ', async (mnemonic) => {
  mnemonic = mnemonic.trim();
  
  if (!bip39.validateMnemonic(mnemonic)) {
    console.error('\n❌ Frase mnemônica inválida! Verifique a ortografia das palavras.');
    rl.close();
    process.exit(1);
  }

  // Caminho de derivação padrão da Phantom Wallet: m/44'/501'/0'/0'
  const seed = await bip39.mnemonicToSeed(mnemonic);
  const derivedSeed = derivePath("m/44'/501'/0'/0'", seed.toString('hex')).key;
  const keypair = Keypair.fromSeed(derivedSeed);

  const publicKey = keypair.publicKey.toBase58();
  const secretKeyArray = JSON.stringify(Array.from(keypair.secretKey));

  console.log('\n✅ CARTEIRA DERIVADA COM SUCESSO:');
  console.log(`🪙 Endereço Público: ${publicKey}`);

  const envPath = path.join(__dirname, '..', '.env');
  const envContent = `# Configurações do Agente Soberano (Nexus Quant Solana)
PORT=5000
NODE_ENV=development

# Carteira Phantom
AGENT_SOLANA_PUBLIC_KEY=${publicKey}
AGENT_SOLANA_PRIVATE_KEY=${secretKeyArray}

# RPC Solana (Mainnet)
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com

# Malha Interna Railway
LAYA_INTERNAL_URL=http://nexus-decisor-laya.railway.internal:8080
LAYA_PUBLIC_FALLBACK_URL=https://nexus-decisor-laya-production.up.railway.app
MERCADO_FINANCEIRO_INTERNAL_URL=http://operacional.railway.internal:4000
MERCADO_FINANCEIRO_PUBLIC_FALLBACK_URL=https://operacional-production-57d9.up.railway.app
NEXUS_CEREBRO_INTERNAL_URL=http://nexus-cerebro.railway.internal:3000
`;

  fs.writeFileSync(envPath, envContent, 'utf-8');
  console.log(`\n🎉 Arquivo .env criado e preenchido automaticamente com sucesso!`);
  console.log(`Arquivo: ${envPath}`);
  console.log('Agora o seu projeto nexus-quant-solana está 100% pronto para rodar.');

  rl.close();
});
