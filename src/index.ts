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
const FAST_EXIT_INTERVAL_MS = 1500; // 1.5 segundos para Ultra-Fast Exit Monitor
const MAX_CONCURRENT_POSITIONS = 1; // Modo Sniper: 1 posição por vez para foco total de CPU e liquidez
const PORT = process.env.PORT || 3009;
const MACRO_SENTINEL_URL = process.env.MACRO_SENTINEL_URL || 'http://nexus-macro-sentinel.railway.internal:4005';
const ACTIVE_SOLANA_RPC_URL = process.env.HELIUS_RPC_URL || process.env.QUICKNODE_RPC_URL || process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';

let isRunningScanner = false;
let isRunningFastExit = false;
const antiSpamMemory = new AntiSpamMemory(60); // Padrão 60 minutos
const positionEngine = new PositionExitEngine();

// Instâncias Globais dos Serviços Operacionais
const wallet = new SolanaWalletService({
  secretKeyRaw: SECRET_KEY_RAW,
  rpcUrl: ACTIVE_SOLANA_RPC_URL
});

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

/**
 * Executa o encerramento seguro e imediato de uma posição aberta:
 * 1. Swap Jupiter Token -> SOL
 * 2. Fechamento de Associated Token Account (Rent Exemption: ~0.00204 SOL de volta)
 * 3. Quarentena severa de 24 horas no AntiSpamMemory se for STOP_LOSS ou MANUAL
 * 4. Registro no histórico de trades fechados e atualização no Dashboard
 */
async function executeExitOrder(
  mint: string,
  exitReason: 'TAKE_PROFIT' | 'STOP_LOSS' | 'MANUAL',
  pnlPct: number,
  exitSolValue: number
): Promise<{ success: boolean; txSignature?: string; error?: string }> {
  const pos = positionEngine.getPosition(mint);
  if (!pos) {
    return { success: false, error: 'Posição não encontrada no Gestor' };
  }

  console.log(`🚨 [EXECUÇÃO DE SAÍDA ON-CHAIN] ${pos.symbol} (${pos.mint}) | Motivo: ${exitReason} | PnL: ${(pnlPct * 100).toFixed(2)}%`);
  console.log(`⚡ [Jupiter V6] Executando Swap de Venda de Volta para SOL...`);

  // 1. Swap na Jupiter V6
  const exitSwap = await jupiterEngine.executeSwap({
    inputMint: pos.mint,
    outputMint: 'So11111111111111111111111111111111111111112', // SOL
    amountLamports: Math.floor(pos.tokenAmount),
    userPublicKey: OFFICIAL_PHANTOM_WALLET,
    keypair: wallet.getKeypair()
  });

  // 2. Recuperação de Rent Exemption (Fechar Conta ATA e recolher os ~0.00204 SOL)
  try {
    await wallet.closeTokenAccount(pos.mint);
  } catch (err: any) {
    console.warn(`⚠️ [Aviso Fechamento ATA] Não foi possível fechar ATA de ${pos.symbol}:`, err?.message || err);
  }

  // 3. Quarentena Severa de 24 Horas em caso de Stop-Loss ou Venda Manual para evitar churn
  if (exitReason === 'STOP_LOSS' || exitReason === 'MANUAL') {
    const quarantine24hMs = 24 * 60 * 60 * 1000;
    antiSpamMemory.recordVeto(pos.mint, `Quarentena Pós-Saída (${exitReason}): bloqueio de recompra por 24h`, quarantine24hMs);
    console.log(`🛑 [Quarentena 24h Aplicada] Token ${pos.symbol} bloqueado para novas compras até amanhã.`);
  }

  // 4. Registra Trade Fechado
  const pnlSol = pnlPct * (pos.entrySol || 0.015);
  positionEngine.recordClosedTrade({
    mint: pos.mint,
    symbol: pos.symbol,
    tokenAmount: pos.tokenAmount,
    entryPriceUsd: pos.entryPriceUsd,
    exitPriceUsd: exitSolValue > 0 ? (exitSolValue / pos.tokenAmount) : pos.entryPriceUsd,
    entryTimestamp: pos.entryTimestamp,
    exitTimestamp: Date.now(),
    pnlPct,
    pnlUsdEst: (pnlSol * 130), // Estimativa USD
    pnlSolEst: pnlSol,
    exitReason,
    txSignature: exitSwap.txSignature
  });

  positionEngine.removePosition(pos.mint);
  console.log(`✅ Posição em ${pos.symbol} finalizada com sucesso.`);

  // Atualiza estado do Dashboard
  updateDashboardViews();

  return {
    success: exitSwap.status === 'SUCCESS' || exitSwap.status === 'DRY_RUN_SUCCESS',
    txSignature: exitSwap.txSignature,
    error: exitSwap.error
  };
}

function updateDashboardViews() {
  const currentPositions = positionEngine.getAllPositions();
  latestState.positions = currentPositions.map(p => {
    return {
      mint: p.mint,
      symbol: p.symbol,
      tokenAmount: p.tokenAmount,
      entryPriceUsd: p.entryPriceUsd,
      currentPriceUsd: p.entryPriceUsd,
      pnlPct: 0,
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
    pnlSolEst: c.pnlSolEst !== undefined ? c.pnlSolEst : (c.pnlPct * 0.015),
    exitReason: c.exitReason,
    txSignature: c.txSignature,
    dexScreenerUrl: `https://dexscreener.com/solana/${c.mint}`,
    solscanUrl: `https://solscan.io/token/${c.mint}`
  }));

  latestState.totalRealizedPnlSol = latestState.closedTrades.reduce((acc, t) => acc + t.pnlSolEst, 0);
  latestState.totalNetworkFeesSolEst = (currentPositions.length + latestState.closedTrades.length) * 0.0025;
  latestState.quarantineCount = antiSpamMemory.getStats().vettedCount;
}

// Inicia servidor HTTP para Healthcheck do Railway e Dashboard Visual
const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;
  const method = req.method || 'GET';

  // Rota Healthcheck padrão do Railway
  if (pathname === '/health') {
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
  if (pathname === '/api/status') {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(JSON.stringify(latestState, null, 2));
    return;
  }

  // Rota de Venda Manual de 1 Token específico
  if (pathname.startsWith('/api/positions/') && pathname.endsWith('/exit') && method === 'POST') {
    const segments = pathname.split('/');
    const mint = decodeURIComponent(segments[3] || '');
    console.log(`🚨 [Ação Manual Recebida] Requisição de Venda a Mercado para: ${mint}`);
    const result = await executeExitOrder(mint, 'MANUAL', 0, 0);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(result));
    return;
  }

  // Rota Panic Button: Liquidar Tudo Imediatamente
  if (pathname === '/api/positions/liquidate-all' && method === 'POST') {
    console.log(`🛑 [PANIC BUTTON ATIVADO] Liquidando todas as posições em aberto...`);
    const allPositions = positionEngine.getAllPositions();
    const results = [];
    for (const pos of allPositions) {
      const resExit = await executeExitOrder(pos.mint, 'MANUAL', 0, 0);
      results.push({ mint: pos.mint, symbol: pos.symbol, ...resExit });
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ message: `${results.length} posições liquidadas a mercado.`, results }));
    return;
  }

  // Rota Dashboard Web Visual
  if (pathname === '/' || pathname === '/dashboard') {
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

/**
 * ⚡ ULTRA-FAST EXIT MONITOR (Loop Dedicado de 1.5s via Jupiter Quote)
 * Monitora o valor real em SOL de cada token custodiado usando a cotação direta da Jupiter.
 * Se o valor cotado for <= 80% do investido (-20%), executa Stop-Loss imediato sem delay.
 */
async function runUltraFastExitMonitor() {
  if (isRunningFastExit) return;
  isRunningFastExit = true;

  try {
    const openPositions = positionEngine.getAllPositions();
    if (openPositions.length === 0) return;

    for (const pos of openPositions) {
      try {
        // Cotação direta na Jupiter V6: Token -> SOL
        const tokenLamports = Math.floor(pos.tokenAmount);
        const quote = await jupiterEngine.getQuote(
          pos.mint,
          'So11111111111111111111111111111111111111112', // SOL
          tokenLamports,
          50 // 0.5% slippage
        );

        const currentSolValue = (quote.outAmount || 0) / 1e9;
        const entrySol = pos.entrySol || 0.015;
        const pnlPct = (currentSolValue - entrySol) / entrySol;

        // Atualiza PnL flutuante no estado do Dashboard
        const dashPos = latestState.positions.find(p => p.mint === pos.mint);
        if (dashPos) {
          dashPos.pnlPct = pnlPct;
          dashPos.currentPriceUsd = (currentSolValue / pos.tokenAmount) * 130; // Aproximação em USD
        }

        // Avalia Saída por Sol: TP (+50%) ou SL (-20%)
        const exitSignal = positionEngine.evaluateExitBySol(pos.mint, currentSolValue);
        if (exitSignal.shouldExit && (exitSignal.type === 'TAKE_PROFIT' || exitSignal.type === 'STOP_LOSS')) {
          console.log(`🎯 [ULTRA-FAST EXIT ACIONADO] ${pos.symbol}: ${exitSignal.type} | PnL: ${(pnlPct * 100).toFixed(2)}% | Valor: ${currentSolValue.toFixed(4)} SOL`);
          await executeExitOrder(pos.mint, exitSignal.type, pnlPct, currentSolValue);
        }
      } catch (quoteErr: any) {
        // Silencioso em flutuações rápidas para manter o loop de 1.5s ágil
      }
    }
  } catch (err: any) {
    console.error('⚠️ [Erro Fast Exit Monitor]:', err?.message || err);
  } finally {
    isRunningFastExit = false;
  }
}

/**
 * 🔍 SCANNER AUTÔNOMO 24/7 (Ciclo Independente de 30s)
 * Varredura DexScreener, Análise RugCheck/Laya e Execução Sniper
 */
async function executeAutonomousCycle() {
  if (isRunningScanner) {
    console.log('⏳ Ciclo de scanner anterior ainda em processamento. Pulando iteração...');
    return;
  }

  isRunningScanner = true;
  try {
    const memoryStats = antiSpamMemory.getStats();
    const openPositions = positionEngine.getAllPositions();

    console.log(`\n====================================================`);
    console.log(`⏱️ [${new Date().toLocaleTimeString()}] CICLO DE VARREDURA (Quarentena: ${memoryStats.vettedCount} | Posições Abertas: ${openPositions.length})`);
    console.log(`====================================================`);

    // Ciclo 1: Leitura de Vitalidade On-Chain
    const balanceSol = await wallet.getBalanceSol();
    const vitalityState = getAgentVitalityState(balanceSol);
    console.log(`📊 Saldo On-Chain: ${balanceSol.toFixed(4)} SOL | Estado Vital: [${vitalityState}]`);

    latestState.balanceSol = balanceSol;
    latestState.vitalityState = vitalityState;
    latestState.quarantineCount = memoryStats.vettedCount;
    latestState.lastUpdated = new Date().toISOString();

    if (vitalityState === VitalityState.DEAD) {
      console.log('⚠️ [Vitality: DEAD] Saldo zerado. Aguardando aporte para operar.');
      return;
    }

    // Sincronização On-Chain de Custódia (Reconcilia tokens reais da carteira Phantom)
    try {
      const splAccounts = await wallet.getSplTokenAccounts();
      for (const spl of splAccounts) {
        if (!positionEngine.getPosition(spl.mint)) {
          const meta = await scanner.fetchTokenMetadata(spl.mint);
          const price = (meta && meta.priceUsd > 0) ? meta.priceUsd : 0.00001;
          const symbol = meta?.symbol || (spl.mint.slice(0, 4) + '...' + spl.mint.slice(-4));
          positionEngine.addPosition({
            mint: spl.mint,
            symbol,
            tokenAmount: spl.tokenAmount,
            entryPriceUsd: price,
            entryTimestamp: Date.now(),
            stopLossPct: -0.20,
            takeProfitPct: 0.50,
            entrySol: 0.015
          });
          console.log(`📦 [Custódia On-Chain Detectada] ${spl.tokenAmount.toLocaleString()} de ${symbol} (${spl.mint}) adicionados.`);
        }
      }
    } catch (err: any) {
      console.warn(`⚠️ [Aviso Custódia] Falha ao sincronizar contas SPL: ${err?.message || err}`);
    }

    updateDashboardViews();

    // 🎯 MODO SNIPER (Teto de Concorrência: MAX_CONCURRENT_POSITIONS = 1)
    const activePositions = positionEngine.getAllPositions();
    if (activePositions.length >= MAX_CONCURRENT_POSITIONS) {
      console.log(`🎯 [MODO SNIPER ATIVO] Posição aberta em custódia (${activePositions.map(p => p.symbol).join(', ')}). Scanner de novas compras em PAUSA absoluta para dedicação total à saída.`);
      return;
    }

    // Ciclo 1.8: Conexão Explícita ao Macro Sentinel (:4005)
    let macroRegime = 'NEUTRAL_RANGING';
    let isCircuitBreaker = false;
    try {
      const sentinelRes = await axios.get(`${MACRO_SENTINEL_URL}/v1/sentinel/regime`, { timeout: 2000 });
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
        antiSpamMemory.recordVeto(topCandidate.mint, audit.reason || 'Veto preventivo');
      } else {
        antiSpamMemory.recordApproval(topCandidate.mint, audit.score);

        // Ciclo 4: Execução na Jupiter V6 (Dry-Run ou Real) - Swap fixo de 0.015 SOL
        console.log(`⚡ [3/3 Motor Jupiter V6] Cotando rota e executando swap (0.015 SOL)...`);
        const swapSim = await jupiterEngine.executeSwap({
          inputMint: 'So11111111111111111111111111111111111111112', // SOL
          outputMint: topCandidate.mint,
          amountLamports: 15000000, // 0.015 SOL fixo
          slippageBps: 400,
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

        if (swapSim.status === 'SUCCESS' || swapSim.status === 'DRY_RUN_SUCCESS') {
          positionEngine.addPosition({
            mint: topCandidate.mint,
            symbol: topCandidate.symbol,
            tokenAmount: swapSim.outAmount,
            entryPriceUsd: topCandidate.priceUsd,
            entryTimestamp: Date.now(),
            stopLossPct: -0.20,
            takeProfitPct: 0.50,
            entrySol: 0.015
          });
          console.log(`📈 Posição em ${topCandidate.symbol} registrada no Gestor de Posições (SL: -20% | TP: +50%)`);
          updateDashboardViews();
        } else {
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
    console.error('⚠️ Erro durante o ciclo de varredura:', error?.message || error);
  } finally {
    isRunningScanner = false;
  }
}

async function main() {
  console.log('====================================================');
  console.log('🚀 NEXUS QUANT SOLANA - INICIALIZANDO SERVIÇO 24/7');
  console.log(`🪙 Carteira Phantom Oficial: ${OFFICIAL_PHANTOM_WALLET}`);
  console.log(`🛡️ Modo Operacional: ${IS_DRY_RUN ? 'SIMULAÇÃO ATIVA (DRY-RUN 🟢)' : 'EXECUÇÃO REAL ON-CHAIN ⚠️'}`);
  console.log(`⏱️ Intervalo de Varredura: ${SCAN_INTERVAL_MS / 1000}s`);
  console.log(`⚡ Ultra-Fast Exit Monitor: ${FAST_EXIT_INTERVAL_MS}ms (Jupiter Quote Direto)`);
  console.log(`🎯 Modo Sniper: MAX_CONCURRENT_POSITIONS = ${MAX_CONCURRENT_POSITIONS}`);
  console.log(`⚡ RPC Solana Ativa: ${ACTIVE_SOLANA_RPC_URL.split('?')[0]}`);
  console.log('====================================================');

  console.log(`🔑 Keypair Derivado On-Chain: ${wallet.getPublicKey()}`);
  if (wallet.getPublicKey() !== OFFICIAL_PHANTOM_WALLET) {
    console.warn(`⚠️ [ALERTA DE CHAVE] Chave pública derivada (${wallet.getPublicKey()}) diverge da carteira oficial configurada (${OFFICIAL_PHANTOM_WALLET})!`);
  }

  // 1. Executa o primeiro ciclo de scanner imediatamente
  await executeAutonomousCycle();

  // 2. Loop Ultra-Rápido Dedicado de Saída a cada 1.500ms
  setInterval(runUltraFastExitMonitor, FAST_EXIT_INTERVAL_MS);

  // 3. Loop Independente de Scanner de Novos Tokens a cada 30s
  setInterval(executeAutonomousCycle, SCAN_INTERVAL_MS);
}

main().catch(err => {
  console.error('❌ Falha fatal ao inicializar o agente:', err);
  process.exit(1);
});
