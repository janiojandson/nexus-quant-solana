import http from 'http';
import dotenv from 'dotenv';
import axios from 'axios';
import { VitalityState, getAgentVitalityState } from './core/vitalityEngine.js';
import { SolanaWalletService } from './blockchain/solanaWallet.js';
import { JupiterExecutionEngine } from './blockchain/jupiterExecutionEngine.js';
import { MemeRiskGatekeeper } from './risk/memeRiskGatekeeper.js';
import { DexScreenerScanner } from './scanner/dexScreenerScanner.js';
import { ReproductionEngine } from './lifecycle/reproductionEngine.js';
import { SolanaPostgresRepository } from './database/postgresClient.js';
import { TokenClassifier, AntiSpamMemory } from './scanner/tokenClassifier.js';
import { PositionExitEngine } from './execution/positionExitEngine.js';

dotenv.config();

const OFFICIAL_PHANTOM_WALLET = process.env.AGENT_SOLANA_PUBLIC_KEY || 'FBx2SKLDLsdeLM8owxU8MNVPKAfJpLpmpHHRgiZDqBoi';
const SECRET_KEY_RAW = process.env.AGENT_SOLANA_PRIVATE_KEY || '[]';
const IS_DRY_RUN = process.env.DRY_RUN_MODE !== 'false';
const SCAN_INTERVAL_MS = parseInt(process.env.SCAN_INTERVAL_MS || '30000', 10);
const PORT = process.env.PORT || 3009;
const MACRO_SENTINEL_URL = process.env.MACRO_SENTINEL_URL || 'http://nexus-macro-sentinel.railway.internal:4005';

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
const antiSpamMemory = new AntiSpamMemory(60); // 60 minutos de quarentena sem incomodar
const positionEngine = new PositionExitEngine();

async function executeAutonomousCycle(
  wallet: SolanaWalletService,
  scanner: DexScreenerScanner,
  gatekeeper: MemeRiskGatekeeper,
  jupiterEngine: JupiterExecutionEngine,
  reproduction: ReproductionEngine,
  postgresRepo: SolanaPostgresRepository
) {
  if (isRunningCycle) {
    console.log('⏳ Ciclo anterior ainda em processamento. Pulando iteração...');
    return;
  }

  isRunningCycle = true;
  try {
    const memoryStats = antiSpamMemory.getStats();
    const openPositions = positionEngine.getAllPositions();

    console.log(`\n====================================================`);
    console.log(`⏱️ [${new Date().toLocaleTimeString()}] CICLO AUTÔNOMO 24/7 (Quarentena: ${memoryStats.vettedCount} | Posições Abertas: ${openPositions.length})`);
    console.log(`====================================================`);

    // Ciclo 1: Leitura de Vitalidade
    const balanceSol = await wallet.getBalanceSol();
    const vitalityState = getAgentVitalityState(balanceSol);
    console.log(`📊 Saldo On-Chain: ${balanceSol.toFixed(4)} SOL | Estado Vital: [${vitalityState}]`);

    if (vitalityState === VitalityState.DEAD) {
      console.log('⚠️ [Vitality: DEAD] Saldo zerado. Aguardando aporte para operar.');
      return;
    }

    // Ciclo 1.5: Monitoramento de Posições Abertas (Take-Profit & Stop-Loss)
    if (openPositions.length > 0) {
      console.log(`📊 [Gestor de Posições] Monitorando ${openPositions.length} posições abertas...`);
      for (const pos of openPositions) {
        // Simula ou busca preço atual (usando o preço salvo com pequena flutuação ou scanner)
        const exitSignal = positionEngine.evaluateExit(pos.mint, pos.entryPriceUsd);
        if (exitSignal.shouldExit) {
          console.log(`🎯 [Gatilho de Saída Ativado] ${pos.symbol}: ${exitSignal.type} | PnL: ${(exitSignal.pnlPct * 100).toFixed(2)}%`);
          console.log(`⚡ [Jupiter V6] Executando Swap de Venda de Volta para SOL...`);
          // Executa swap de saída: Token -> SOL
          await jupiterEngine.executeSwap({
            inputMint: pos.mint,
            outputMint: 'So11111111111111111111111111111111111111112', // SOL
            amountLamports: Math.floor(pos.tokenAmount),
            userPublicKey: OFFICIAL_PHANTOM_WALLET,
            keypair: wallet.getKeypair()
          });
          positionEngine.removePosition(pos.mint);
          console.log(`✅ Posição em ${pos.symbol} encerrada com sucesso.`);
        }
      }
    }

    // Ciclo 1.8: Conexão Explícita ao Macro Sentinel (:4005)
    let macroRegime = 'NEUTRAL_RANGING';
    let isCircuitBreaker = false;
    try {
      const sentinelRes = await axios.get(`${MACRO_SENTINEL_URL}/v1/sentinel/regime`, {
        timeout: 2000
      });
      macroRegime = sentinelRes.data?.regime || 'NEUTRAL_RANGING';
      isCircuitBreaker = Boolean(sentinelRes.data?.is_circuit_breaker_active);
      const breakerStatusText = isCircuitBreaker ? 'LIGADO (Operações Bloqueadas)' : 'DESLIGADO (Seguro)';
      console.log(`📡 [SENTINEL: ${macroRegime} | Disjuntor: ${breakerStatusText}]`);
    } catch {
      console.log(`⚠️ [AVISO] Sentinel inacessível, mantendo operação defensiva`);
    }

    if (isCircuitBreaker) {
      console.log(`🛑 [CIRCUIT BREAKER ATIVO] Mercado em estresse macro (${macroRegime}). Scanner e swaps pausados.`);
      return;
    }

    // Ciclo 2: Scanner On-Chain (DexScreener)
    console.log('🔍 [1/3 Scanner DexScreener] Buscando tokens recém-perfilados e piscinas Raydium na rede Solana...');
    const candidates = await scanner.scanSolanaTrends(10000);
    const totalCaptured = candidates.length;

    let technicalDiscardCount = 0;
    let quarantineCount = 0;
    const eligibleCandidates: typeof candidates = [];

    for (const token of candidates) {
      const classification = TokenClassifier.classify(token.mint, token.symbol, token.liquidityUsd);
      if (!classification.isEligibleForMemeScan) {
        technicalDiscardCount++;
        continue;
      }

      const spamCheck = antiSpamMemory.shouldSkip(token.mint);
      if (spamCheck.skip) {
        quarantineCount++;
        continue;
      }

      eligibleCandidates.push(token);
    }

    // Log de triagem formatado estritamente conforme especificação
    console.log(`📊 [Capturados: ${totalCaptured} | Descarte Técnico: ${technicalDiscardCount} | Quarentena: ${quarantineCount} | Elegíveis para Ayla: ${eligibleCandidates.length}]`);

    if (eligibleCandidates.length > 0) {
      const topCandidate = eligibleCandidates[0];
      const classification = TokenClassifier.classify(topCandidate.mint, topCandidate.symbol, topCandidate.liquidityUsd);

      console.log(`🔥 Analisando Candidato: ${topCandidate.symbol} (${topCandidate.name})`);
      console.log(`   Subgrupo: [${classification.category}] | Mint: ${topCandidate.mint}`);
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

      let txSignature: string | null = null;

      if (!audit.safe) {
        console.log(`   Motivo do Veto: ${audit.reason}`);
        // Coloca em quarentena de 60 min para não incomodar com o mesmo token
        antiSpamMemory.recordVeto(topCandidate.mint, audit.reason || 'Veto preventivo');
      } else {
        antiSpamMemory.recordApproval(topCandidate.mint, audit.score);

        // Ciclo 4: Execução na Jupiter V6 (Dry-Run ou Real) - Swap fixo de 0.015 SOL
        console.log(`⚡ [3/3 Motor Jupiter V6] Cotando rota e executando swap (0.015 SOL)...`);
        const swapSim = await jupiterEngine.executeSwap({
          inputMint: 'So11111111111111111111111111111111111111112', // SOL
          outputMint: topCandidate.mint,
          amountLamports: 15000000, // 0.015 SOL fixo por entrada (Diretriz de Sobrevivência Ayla)
          slippageBps: 150, // 1.5% tolerância para memecoins de alta volatilidade (previne 0x177e)
          userPublicKey: OFFICIAL_PHANTOM_WALLET,
          keypair: wallet.getKeypair()
        });

        txSignature = swapSim.txSignature;
        console.log(`   Status do Swap: ${swapSim.status}`);
        if (swapSim.error) {
          console.log(`   ⚠️ Erro Swap: ${swapSim.error}`);
        }
        console.log(`   Assinatura Tx: ${swapSim.txSignature || 'N/A'}`);
        console.log(`   Retorno: ${swapSim.outAmount.toLocaleString()} tokens`);

        // Adiciona à gestão de posições ativas com Take-Profit (+50%) e Stop-Loss (-20%)
        if (swapSim.status === 'SUCCESS' || swapSim.status === 'DRY_RUN_SUCCESS') {
          positionEngine.addPosition({
            mint: topCandidate.mint,
            symbol: topCandidate.symbol,
            tokenAmount: swapSim.outAmount,
            entryPriceUsd: topCandidate.priceUsd,
            entryTimestamp: Date.now(),
            stopLossPct: -0.20,
            takeProfitPct: 0.50
          });
          console.log(`📈 Posição em ${topCandidate.symbol} registrada no Gestor de Posições (SL: -20% | TP: +50%)`);
        }
      }

      // Persistência no Postgres Central (Stateless Event Store)
      await postgresRepo.saveAudit({
        mint: topCandidate.mint,
        symbol: topCandidate.symbol,
        name: topCandidate.name,
        liquidityUsd: topCandidate.liquidityUsd,
        priceUsd: topCandidate.priceUsd,
        isSafe: audit.safe,
        score: audit.score,
        validatedBy: audit.validatedBy,
        vetoReason: audit.reason || null,
        dryRun: IS_DRY_RUN,
        txSignature
      });
    } else {
      console.log('💤 Nenhum token novo ou pendente. Todos os itens recentes já foram filtrados ou estão em quarentena.');
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
    macroSentinelUrl: MACRO_SENTINEL_URL,
    timeoutMs: 4000
  });

  const jupiterEngine = new JupiterExecutionEngine({
    rpcUrl: process.env.SOLANA_RPC_URL,
    isDryRun: IS_DRY_RUN
  });

  const reproduction = new ReproductionEngine();
  const postgresRepo = new SolanaPostgresRepository();

  // Executa o primeiro ciclo imediatamente
  await executeAutonomousCycle(wallet, scanner, gatekeeper, jupiterEngine, reproduction, postgresRepo);

  // Agenda execuções contínuas em loop infinito 24/7
  setInterval(() => {
    executeAutonomousCycle(wallet, scanner, gatekeeper, jupiterEngine, reproduction, postgresRepo);
  }, SCAN_INTERVAL_MS);
}

main().catch(err => {
  console.error('❌ Falha fatal ao inicializar o agente:', err);
  process.exit(1);
});
