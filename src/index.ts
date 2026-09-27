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
import { renderDashboardHtml, DashboardState } from './dashboard/dashboardRenderer.js';

dotenv.config();

const OFFICIAL_PHANTOM_WALLET = process.env.AGENT_SOLANA_PUBLIC_KEY || 'FBx2SKLDLsdeLM8owxU8MNVPKAfJpLpmpHHRgiZDqBoi';
const SECRET_KEY_RAW = process.env.AGENT_SOLANA_PRIVATE_KEY || '[]';
const IS_DRY_RUN = process.env.DRY_RUN_MODE !== 'false';
const SCAN_INTERVAL_MS = parseInt(process.env.SCAN_INTERVAL_MS || '30000', 10);
const PORT = process.env.PORT || 3009;
const MACRO_SENTINEL_URL = process.env.MACRO_SENTINEL_URL || 'http://nexus-macro-sentinel.railway.internal:4005';
const ACTIVE_SOLANA_RPC_URL = process.env.HELIUS_RPC_URL || process.env.QUICKNODE_RPC_URL || process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';

let isRunningCycle = false;
const antiSpamMemory = new AntiSpamMemory(60); // 60 minutos de quarentena sem incomodar
const positionEngine = new PositionExitEngine();

// Estado compartilhado em memória para o Dashboard
const latestState: DashboardState = {
  agent: 'NEXUS_QUANT_SOLANA_V1',
  wallet: OFFICIAL_PHANTOM_WALLET,
  balanceSol: 0,
  initialDepositSol: 0.3133,
  vitalityState: 'NORMAL',
  dryRun: IS_DRY_RUN,
  macroRegime: 'NEUTRAL_RANGING',
  circuitBreakerActive: false,
  activeRpcUrl: ACTIVE_SOLANA_RPC_URL.split('?')[0],
  totalRealizedPnlSol: 0,
  totalNetworkFeesSolEst: 0,
  positions: [],
  closedTrades: [],
  recentAudits: [],
  quarantineCount: 0,
  lastUpdated: new Date().toISOString()
};

// Inicia servidor HTTP para Healthcheck do Railway e Dashboard Visual
const server = http.createServer((req, res) => {
  const url = req.url || '/';

  // Rota Healthcheck padrão do Railway
  if (url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ONLINE',
      agent: latestState.agent,
      wallet: latestState.wallet,
      balanceSol: latestState.balanceSol,
      positionsCount: latestState.positions.length,
      timestamp: new Date().toISOString()
    }));
    return;
  }

  // Rota API JSON para integrações (ex: MarketFlow Pro)
  if (url === '/api/status') {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(JSON.stringify(latestState, null, 2));
    return;
  }

  // Rota Dashboard Web Visual
  if (url === '/' || url === '/dashboard') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderDashboardHtml(latestState));
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(PORT, () => {
  console.log(`🌐 [Railway Healthcheck & Dashboard] Servidor ativo na porta ${PORT}`);
});

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

    // Sincroniza estado para o Dashboard Web
    latestState.balanceSol = balanceSol;
    latestState.vitalityState = vitalityState;
    latestState.quarantineCount = memoryStats.vettedCount;
    latestState.lastUpdated = new Date().toISOString();

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
          const exitSwap = await jupiterEngine.executeSwap({
            inputMint: pos.mint,
            outputMint: 'So11111111111111111111111111111111111111112', // SOL
            amountLamports: Math.floor(pos.tokenAmount),
            userPublicKey: OFFICIAL_PHANTOM_WALLET,
            keypair: wallet.getKeypair()
          });

          // Registra Trade Fechado
          const pnlSol = (exitSignal.pnlPct * 0.015);
          positionEngine.recordClosedTrade({
            mint: pos.mint,
            symbol: pos.symbol,
            tokenAmount: pos.tokenAmount,
            entryPriceUsd: pos.entryPriceUsd,
            exitPriceUsd: exitSignal.currentPriceUsd,
            entryTimestamp: pos.entryTimestamp,
            exitTimestamp: Date.now(),
            pnlPct: exitSignal.pnlPct,
            pnlUsdEst: (exitSignal.currentPriceUsd - pos.entryPriceUsd) * pos.tokenAmount,
            exitReason: exitSignal.type,
            txSignature: exitSwap.txSignature
          });

          positionEngine.removePosition(pos.mint);
          console.log(`✅ Posição em ${pos.symbol} encerrada com sucesso.`);
        }
      }
    }

    // Atualiza lista de posições e histórico fechado no Dashboard
    latestState.positions = positionEngine.getAllPositions().map(p => {
      const exitSig = positionEngine.evaluateExit(p.mint, p.entryPriceUsd);
      return {
        mint: p.mint,
        symbol: p.symbol,
        tokenAmount: p.tokenAmount,
        entryPriceUsd: p.entryPriceUsd,
        currentPriceUsd: exitSig.currentPriceUsd,
        pnlPct: exitSig.pnlPct,
        stopLossPct: p.stopLossPct,
        takeProfitPct: p.takeProfitPct,
        entryTimestamp: p.entryTimestamp,
        dexScreenerUrl: `https://dexscreener.com/solana/${p.mint}`,
        solscanUrl: `https://solscan.io/token/${p.mint}`
      };
    });

    latestState.closedTrades = positionEngine.getClosedTrades().map(c => ({
      mint: c.mint,
      symbol: c.symbol,
      tokenAmount: c.tokenAmount,
      entryPriceUsd: c.entryPriceUsd,
      exitPriceUsd: c.exitPriceUsd,
      entryTimestamp: c.entryTimestamp,
      exitTimestamp: c.exitTimestamp,
      pnlPct: c.pnlPct,
      pnlSolEst: c.pnlPct * 0.015,
      exitReason: c.exitReason,
      txSignature: c.txSignature,
      dexScreenerUrl: `https://dexscreener.com/solana/${c.mint}`,
      solscanUrl: `https://solscan.io/token/${c.mint}`
    }));

    // Calcula PnL Realizado acumulado e Taxas de Rede Estimadas (criação de ATA ~0.002039 SOL + fees)
    latestState.totalRealizedPnlSol = latestState.closedTrades.reduce((acc, t) => acc + t.pnlSolEst, 0);
    const activePositionsCount = latestState.positions.length;
    const closedCount = latestState.closedTrades.length;
    // Cada token novo cria 1 ATA (aluguel de ~0.002039 SOL) + taxa de prioridade
    latestState.totalNetworkFeesSolEst = (activePositionsCount + closedCount) * 0.0025;

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

    latestState.macroRegime = macroRegime;
    latestState.circuitBreakerActive = isCircuitBreaker;

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
          slippageBps: 400, // 4.0% tolerância para memecoins de alta velocidade/pump.fun (evita 0x177e)
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

          // Sincroniza imediatamente com o Dashboard
          latestState.positions = positionEngine.getAllPositions().map(p => {
            const exitSig = positionEngine.evaluateExit(p.mint, p.entryPriceUsd);
            return {
              mint: p.mint,
              symbol: p.symbol,
              tokenAmount: p.tokenAmount,
              entryPriceUsd: p.entryPriceUsd,
              currentPriceUsd: exitSig.currentPriceUsd,
              pnlPct: exitSig.pnlPct,
              stopLossPct: p.stopLossPct,
              takeProfitPct: p.takeProfitPct,
              entryTimestamp: p.entryTimestamp,
              dexScreenerUrl: `https://dexscreener.com/solana/${p.mint}`,
              solscanUrl: `https://solscan.io/token/${p.mint}`
            };
          });
        } else {
          // Se o swap falhou (ex: pool sem liquidez no momento ou slippage), isola em quarentena temporária
          antiSpamMemory.recordVeto(topCandidate.mint, `Swap Jupiter falhou: ${swapSim.error || '0x177e'}`);
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

      // Registra no histórico do Dashboard
      latestState.recentAudits.unshift({
        mint: topCandidate.mint,
        symbol: topCandidate.symbol,
        isSafe: audit.safe,
        score: audit.score,
        reason: audit.reason,
        timestamp: Date.now()
      });
      if (latestState.recentAudits.length > 20) latestState.recentAudits.pop();
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
  console.log(`⚡ RPC Solana Ativa: ${ACTIVE_SOLANA_RPC_URL.split('?')[0]}`);
  console.log('====================================================');

  const wallet = new SolanaWalletService({
    secretKeyRaw: SECRET_KEY_RAW,
    rpcUrl: ACTIVE_SOLANA_RPC_URL
  });

  console.log(`🔑 Keypair Derivado On-Chain: ${wallet.getPublicKey()}`);
  if (wallet.getPublicKey() !== OFFICIAL_PHANTOM_WALLET) {
    console.warn(`⚠️ [ALERTA DE CHAVE] Chave pública derivada (${wallet.getPublicKey()}) diverge da carteira oficial configurada (${OFFICIAL_PHANTOM_WALLET})!`);
  }

  const scanner = new DexScreenerScanner();
  const gatekeeper = new MemeRiskGatekeeper({
    layaBaseUrl: process.env.LAYA_INTERNAL_URL || 'http://nexus-decisor-laya.railway.internal:8080',
    macroSentinelUrl: MACRO_SENTINEL_URL,
    timeoutMs: 4000
  });

  const jupiterEngine = new JupiterExecutionEngine({
    rpcUrl: ACTIVE_SOLANA_RPC_URL,
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
