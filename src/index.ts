import http from 'http';
import dotenv from 'dotenv';
import { VitalityState, getAgentVitalityState } from './core/vitalityEngine.js';
import { SolanaWalletService } from './blockchain/solanaWallet.js';
import { JupiterExecutionEngine } from './blockchain/jupiterExecutionEngine.js';
import { MemeRiskGatekeeper } from './risk/memeRiskGatekeeper.js';
import { DexScreenerScanner } from './scanner/dexScreenerScanner.js';
import { ReproductionEngine } from './lifecycle/reproductionEngine.js';

dotenv.config();

const OFFICIAL_PHANTOM_WALLET = process.env.AGENT_SOLANA_PUBLIC_KEY || 'FBx2SKLDLsdeLM8owxU8MNVPKAfJpLpmpHHRgiZDqBoi';
const SECRET_KEY_RAW = process.env.AGENT_SOLANA_PRIVATE_KEY || '[]';
const IS_DRY_RUN = process.env.DRY_RUN_MODE !== 'false';
const SCAN_INTERVAL_MS = parseInt(process.env.SCAN_INTERVAL_MS || '30000', 10);
const PORT = process.env.PORT || 3009;

// Inicia servidor HTTP para Healthcheck do Railway
const server = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ONLINE',
      agent: 'NEXUS_QUANT_SOLANA_V1',
      wallet: OFFICIAL_PHANTOM_WALLET,
      dryRun: IS_DRY_RUN,
      timestamp: new Date().toISOString()
    }));
  } else {
    res.writeHead(404);
    res.end();
  }
});

server.listen(PORT, () => {
  console.log(`🌐 [Railway Healthcheck] Servidor ativo na porta ${PORT}`);
});

let isRunningCycle = false;

async function executeAutonomousCycle(
  wallet: SolanaWalletService,
  scanner: DexScreenerScanner,
  gatekeeper: MemeRiskGatekeeper,
  jupiterEngine: JupiterExecutionEngine,
  reproduction: ReproductionEngine
) {
  if (isRunningCycle) {
    console.log('⏳ Ciclo anterior ainda em processamento. Pulando iteração...');
    return;
  }

  isRunningCycle = true;
  try {
    console.log(`\n====================================================`);
    console.log(`⏱️ [${new Date().toLocaleTimeString()}] INICIANDO NOVO CICLO AUTÔNOMO 24/7`);
    console.log(`====================================================`);

    // Ciclo 1: Leitura de Vitalidade
    const balanceSol = await wallet.getBalanceSol();
    const vitalityState = getAgentVitalityState(balanceSol);
    console.log(`📊 Saldo On-Chain: ${balanceSol.toFixed(4)} SOL | Estado Vital: [${vitalityState}]`);

    if (vitalityState === VitalityState.DEAD) {
      console.log('⚠️ [Vitality: DEAD] Saldo zerado. Aguardando aporte para operar.');
      return;
    }

    // Ciclo 2: Scanner On-Chain (DexScreener)
    console.log('🔍 [1/3 Scanner DexScreener] Buscando tokens em tendência na rede Solana...');
    const candidates = await scanner.scanSolanaTrends(5000);
    console.log(`📡 Tokens qualificados encontrados na varredura: ${candidates.length}`);

    if (candidates.length > 0) {
      const topCandidate = candidates[0];
      console.log(`🎯 Candidato em Destaque: ${topCandidate.symbol} (${topCandidate.name})`);
      console.log(`   Mint: ${topCandidate.mint}`);
      console.log(`   Liquidez: $${topCandidate.liquidityUsd.toLocaleString()} | Preço: $${topCandidate.priceUsd}`);

      // Ciclo 3: Sentinela de Risco (RugCheck + Laya)
      console.log('🛡️ [2/3 Sentinela Anti-Rug] Auditando contrato e liquidez...');
      const audit = await gatekeeper.auditToken({
        mint: topCandidate.mint,
        liquidityUsd: topCandidate.liquidityUsd,
        mintAuthority: null,
        freezeAuthority: null,
        holdersCount: 250
      });

      console.log(`   Veredito de Segurança: ${audit.safe ? 'APROVADO ✅' : 'VETADO ⛔'}`);
      console.log(`   Score: ${audit.score}/100 | Validador: ${audit.validatedBy}`);

      if (!audit.safe) {
        console.log(`   Motivo do Veto: ${audit.reason}`);
      } else {
        // Ciclo 4: Execução na Jupiter V6 (Dry-Run ou Real)
        console.log(`⚡ [3/3 Motor Jupiter V6] Cotando rota e executando swap (0.01 SOL)...`);
        const swapSim = await jupiterEngine.executeSwap({
          inputMint: 'So11111111111111111111111111111111111111112', // SOL
          outputMint: topCandidate.mint,
          amountLamports: 10000000, // 0.01 SOL
          userPublicKey: OFFICIAL_PHANTOM_WALLET,
          keypair: wallet.getKeypair()
        });

        console.log(`   Status do Swap: ${swapSim.status}`);
        console.log(`   Assinatura Tx: ${swapSim.txSignature}`);
        console.log(`   Retorno: ${swapSim.outAmount.toLocaleString()} tokens`);
      }
    }

    // Ciclo 5: Verificação de Reprodução Darwinista
    if (reproduction.canReproduce(balanceSol)) {
      const split = reproduction.calculateSurplusSplit({
        currentBalanceSol: balanceSol,
        reserveOperatingBalanceSol: 0.20
      });
      console.log(`🎉 PROSPERIDADE! Saque Janio: ${split.profitShareJanioSol} SOL | Alocação Filho: ${split.childInitialStakeSol} SOL`);
      const child = await reproduction.spawnChildAgent('MEME_HUNTER');
      console.log(`👶 Subagente Filho Parido: ${child.childPublicKey} (${child.specialty})`);
    }

    console.log(`✅ [${new Date().toLocaleTimeString()}] Ciclo finalizado com proteção integral.`);
  } catch (error: any) {
    console.error('⚠️ Erro durante o ciclo operacional:', error?.message || error);
  } finally {
    isRunningCycle = false;
  }
}

async function main() {
  console.log('====================================================');
  console.log('🚀 NEXUS QUANT SOLANA - INICIALIZANDO SERVIÇO 24/7');
  console.log(`🪙 Carteira Phantom Oficial: ${OFFICIAL_PHANTOM_WALLET}`);
  console.log(`🛡️ Modo Operacional: ${IS_DRY_RUN ? 'SIMULAÇÃO ATIVA (DRY-RUN 🟢)' : 'EXECUÇÃO REAL ON-CHAIN ⚠️'}`);
  console.log(`⏱️ Intervalo de Varredura: ${SCAN_INTERVAL_MS / 1000}s`);
  console.log('====================================================');

  const wallet = new SolanaWalletService({
    secretKeyRaw: SECRET_KEY_RAW,
    rpcUrl: process.env.SOLANA_RPC_URL
  });

  const scanner = new DexScreenerScanner();
  const gatekeeper = new MemeRiskGatekeeper({
    layaBaseUrl: process.env.LAYA_INTERNAL_URL || 'http://nexus-decisor-laya.railway.internal:8080',
    timeoutMs: 4000
  });

  const jupiterEngine = new JupiterExecutionEngine({
    rpcUrl: process.env.SOLANA_RPC_URL,
    isDryRun: IS_DRY_RUN
  });

  const reproduction = new ReproductionEngine();

  // Executa o primeiro ciclo imediatamente
  await executeAutonomousCycle(wallet, scanner, gatekeeper, jupiterEngine, reproduction);

  // Agenda execuções contínuas em loop infinito 24/7
  setInterval(() => {
    executeAutonomousCycle(wallet, scanner, gatekeeper, jupiterEngine, reproduction);
  }, SCAN_INTERVAL_MS);
}

main().catch(err => {
  console.error('❌ Falha fatal ao inicializar o agente:', err);
  process.exit(1);
});
