import http from 'http';
import dotenv from 'dotenv';
import axios from 'axios';
import { VitalityState, getAgentVitalityState } from './core/vitalityEngine.js';
import { SolanaWalletService } from './blockchain/solanaWallet.js';
import { JupiterExecutionEngine } from './blockchain/jupiterExecutionEngine.js';
import {
  AdaptivePositionSizer,
  MAX_TRADE_AMOUNT_SOL,
  MIN_TRADE_AMOUNT_SOL
} from './blockchain/adaptivePositionSizer.js';
import { MemeRiskGatekeeper } from './risk/memeRiskGatekeeper.js';
import { DexScreenerScanner } from './scanner/dexScreenerScanner.js';
import { ReproductionEngine } from './lifecycle/reproductionEngine.js';
import { SolanaPostgresRepository } from './database/postgresClient.js';
import { TokenClassifier, AntiSpamMemory } from './scanner/tokenClassifier.js';
import { CerebroIntegrationService } from './core/cerebroIntegration.js';
import { PositionExitEngine } from './execution/positionExitEngine.js';
import { renderDashboardHtml, DashboardState } from './dashboard/dashboardRenderer.js';
import { handleApiRoutes } from './server/routes.js';
import { RentRecoveryService } from './services/rentRecoveryService.js';
import { randomUUID } from 'crypto';
import { DecisionLogger, DecisionType, GateEvaluation } from './database/decisionJournal.js';
import { startCalibrationCron, runCalibrationNow } from './calibration/calibrationCron.js';
import { runMaintenance } from './database/maintenanceJob.js';
import { DrawdownBreaker } from './risk/drawdownBreaker.js';
import { assertAtomicAmountToNumber } from './execution/atomicAmount.js';
import { observeEntryMomentum, DEFAULT_ENTRY_MOMENTUM_CONFIG } from './execution/entryMomentumGate.js';


dotenv.config();

const OFFICIAL_PHANTOM_WALLET = process.env.AGENT_SOLANA_PUBLIC_KEY || 'FBx2SKLDLsdeLM8owxU8MNVPKAfJpLpmpHHRgiZDqBoi';
const SECRET_KEY_RAW = process.env.AGENT_SOLANA_PRIVATE_KEY || '[]';
const IS_DRY_RUN = process.env.DRY_RUN_MODE === 'false' ? false : true; // SIMULADOR POR PADRÃO (DRY-RUN 🟢)
const SCAN_INTERVAL_MS = parseInt(process.env.SCAN_INTERVAL_MS || '30000', 10);
const FAST_EXIT_INTERVAL_MS = 1500; // 1.5 segundos para Ultra-Fast Exit Monitor
const MAX_CONCURRENT_POSITIONS = 2; // Permite operar até 2 posições simultâneas
const TRADE_AMOUNT_SOL = MAX_TRADE_AMOUNT_SOL; // Teto do lote por trade (o lote real é dimensionado adaptativamente)
const GAS_RESERVE_SOL = 0.05;       // Reserva mínima intocável em 0.05 SOL (gás de saída)
const MAX_TOTAL_ALLOCATION_SOL = 0.10; // Alocação máxima total de capital em 0.10 SOL (> 0.19 SOL livres)
const PORT = Number(process.env.PORT) || 3009;
const MACRO_SENTINEL_URL = process.env.MACRO_SENTINEL_URL || process.env.MACRO_SENTINEL_PUBLIC_URL || 'http://nexus-macro-sentinel.railway.internal:4005';
const LAYA_URL = process.env.LAYA_INTERNAL_URL || 'http://nexus-decisor-laya.railway.internal:8000';
const ACTIVE_SOLANA_RPC_URL = process.env.HELIUS_RPC_URL || process.env.QUICKNODE_RPC_URL || process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const ENTRY_MOMENTUM_GATE_ENABLED = process.env.ENTRY_MOMENTUM_GATE_ENABLED === 'true';
const ENTRY_MOMENTUM_SAMPLES = Math.max(3, Number(process.env.ENTRY_MOMENTUM_SAMPLES || DEFAULT_ENTRY_MOMENTUM_CONFIG.samples));
const ENTRY_MOMENTUM_INTERVAL_MS = Math.max(250, Number(process.env.ENTRY_MOMENTUM_INTERVAL_MS || DEFAULT_ENTRY_MOMENTUM_CONFIG.intervalMs));
const ENTRY_MOMENTUM_MIN_RISE_PCT = Number(process.env.ENTRY_MOMENTUM_MIN_RISE_PCT || DEFAULT_ENTRY_MOMENTUM_CONFIG.minRisePct);
const ENTRY_MOMENTUM_MAX_RISE_PCT = Number(process.env.ENTRY_MOMENTUM_MAX_RISE_PCT || DEFAULT_ENTRY_MOMENTUM_CONFIG.maxRisePct);
const ENTRY_MOMENTUM_MAX_PULLBACK_PCT = Number(process.env.ENTRY_MOMENTUM_MAX_PULLBACK_PCT || DEFAULT_ENTRY_MOMENTUM_CONFIG.maxPullbackPct);

let isRunningScanner = false;
let isRunningFastExit = false;
const antiSpamMemory = new AntiSpamMemory(60); // Padrão 60 minutos
const positionEngine = new PositionExitEngine();

// Instâncias Globais dos Serviços Operacionais
const wallet = new SolanaWalletService({
  secretKeyRaw: SECRET_KEY_RAW,
  rpcUrl: ACTIVE_SOLANA_RPC_URL
});

const rentRecovery = new RentRecoveryService(wallet.getConnection(), wallet.getKeypair());

const scanner = new DexScreenerScanner();
const gatekeeper = new MemeRiskGatekeeper({
  layaBaseUrl: LAYA_URL,
  macroSentinelUrl: MACRO_SENTINEL_URL,
  timeoutMs: 4000
});

const jupiterEngine = new JupiterExecutionEngine({
  rpcUrl: ACTIVE_SOLANA_RPC_URL,
  isDryRun: IS_DRY_RUN
});

const reproduction = new ReproductionEngine();
const adaptiveSizer = new AdaptivePositionSizer(jupiterEngine.getAggregator());
const postgresRepo = new SolanaPostgresRepository();
const pgPool = postgresRepo.getPool();
const journal = new DecisionLogger(pgPool, {
  flushIntervalMs: 5000,
  maxBufferSize: 100
});
const cerebroService = new CerebroIntegrationService();
const drawdownBreaker = new DrawdownBreaker();

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
  walletHoldings: [],
  closedTrades: [],
  recentAudits: [],
  quarantineCount: 0,
  incubator: { waiting: 0, mature: 0, technicalDiscards: 0, aylaEligible: 0 },
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
  exitReason: 'TAKE_PROFIT' | 'PARTIAL_TAKE_PROFIT_50' | 'STOP_LOSS' | 'TRAILING_STOP' | 'TIME_STOP' | 'MANUAL',
  pnlPct: number,
  exitSolValue: number,
  options?: { exitTokenAmount?: number; shouldCloseAta?: boolean }
): Promise<{ success: boolean; txSignature?: string; error?: string }> {
  const pos = positionEngine.getPosition(mint);
  if (!pos) {
    return { success: false, error: 'Posição não encontrada no Gestor' };
  }

  const tokenAmountToSell = options?.exitTokenAmount || pos.tokenAmount;
  const isPartial = exitReason === 'PARTIAL_TAKE_PROFIT_50';
  const shouldCloseAta = options?.shouldCloseAta ?? !isPartial;

  // Validação atômica ANTES de qualquer cotação. `tokenAmount` vem de
  // `swapSim.outAmount` (inteiro do Jupiter), mas um refactor futuro poderia
  // trocar a origem por uiAmount sem quebrar nenhum teste — e o swap passaria
  // a vender 5 lamports em vez de milhões, deixando a posição presa na carteira.
  let exitAmountAtomic: number;
  try {
    exitAmountAtomic = assertAtomicAmountToNumber(tokenAmountToSell);
  } catch (err: any) {
    console.error(`🛑 [PositionExit] ${pos.symbol}: ${err.message}`);
    latestState.recentAudits[0] = {
      ...latestState.recentAudits[0],
      swapFailReason: `Montante de saida invalido: ${err.message}`
    } as any;
    return { success: false, error: err.message };
  }

  console.log(`🚨 [EXECUÇÃO DE SAÍDA ON-CHAIN] ${pos.symbol} (${pos.mint}) | Motivo: ${exitReason} | Lote: ${exitAmountAtomic} (atomic) | PnL: ${(pnlPct * 100).toFixed(2)}%`);
  console.log(`⚡ [Jupiter V6] Saída com slippage 500bps (5.0%) e priority HIGH...`);

  // 1. Swap na Jupiter V6 — Blindagem de saída: 500bps slippage + priority HIGH
  let exitSwap = await jupiterEngine.executeSwap({
    inputMint: pos.mint,
    outputMint: 'So11111111111111111111111111111111111111112', // SOL
    amountLamports: exitAmountAtomic,
    userPublicKey: OFFICIAL_PHANTOM_WALLET,
    keypair: wallet.getKeypair(),
    slippageBps: 500,       // 5.0% — Saídas/Stops
    priorityLevel: 'high'   // Fura fila e liquida no primeiro bloco disponível
  });

  // Segunda tentativa ainda fail-closed: amplia até o hard-cap de 7,5%,
  // mas continua simulando antes de transmitir. Não existe mais envio cego com
  // skipPreflight, evitando pagar taxa por uma falha que a simulação detectaria.
  if (exitSwap.status !== 'SUCCESS' && exitSwap.status !== 'DRY_RUN_SUCCESS') {
    console.warn(`⚠️ [TENTATIVA 1 FALHOU] ${pos.symbol}: ${exitSwap.error} | Tentando slippage 750bps...`);

    exitSwap = await jupiterEngine.executeSwap({
      inputMint: pos.mint,
      outputMint: 'So11111111111111111111111111111111111111112',
      amountLamports: exitAmountAtomic,
      userPublicKey: OFFICIAL_PHANTOM_WALLET,
      keypair: wallet.getKeypair(),
      slippageBps: 750,
      priorityLevel: 'veryHigh',
      skipPreflight: false
    });

    if (exitSwap.status === 'SUCCESS' || exitSwap.status === 'DRY_RUN_SUCCESS') {
      console.log(`✅ [TENTATIVA 2 SUCESSO] ${pos.symbol}: Liquidação confirmada com slippage 750bps`);
    }
  }

  // 2. Fail-Closed na Saída: só prossegue com higiene on-chain e books se o swap
  // foi de fato confirmado. Sem esta trava, uma saída falha fechava a ATA
  // (prendendo os tokens), gravava PnLperformed fictício e notificava "Saída Executada".
  const exitConfirmed = exitSwap.status === 'SUCCESS' || exitSwap.status === 'DRY_RUN_SUCCESS';

  if (!exitConfirmed) {
    const failReason = exitSwap.error || `Swap de saída não confirmado (status: ${exitSwap.status})`;
    console.error(`🚫 [SAÍDA NÃO CONFIRMADA] ${pos.symbol}: ${failReason} | Posição mantida, ATA preservada, nenhum PnL gravado.`);

    // Registra a falha para telemetria/diagnóstico, sem alterar estado da posição.
    latestState.recentAudits[0] = {
      ...latestState.recentAudits[0],
      swapFailReason: failReason
    } as any;

    journal.logDecision({
      traceId: pos.traceId || randomUUID(),
      decision: 'ABORTED_LATENCY',
      token: {
        mint: pos.mint,
        tokenSymbol: pos.symbol,
        priceUsd: pos.entryPriceUsd
      },
      market: { sentinelRegime: (latestState.macroRegime as any) || 'NEUTRAL_RANGING' },
      execution: { sizeSol: exitSolValue },
      gateEvaluations: [],
      rejectionReason: `EXIT_SWAP_FAILED: ${failReason}`,
      metadata: { phase: 'EXIT', exitReason, tokenAmountToSell }
    });

    updateDashboardViews();
    return { success: false, txSignature: '', error: failReason };
  }

  if (isPartial) {
    const committed = positionEngine.commitPartialExit(pos.mint, exitAmountAtomic, exitSolValue);
    if (!committed) {
      console.error(`❌ [CONSISTÊNCIA] Swap parcial confirmou, mas o estado local não conseguiu aplicar a redução de ${exitAmountAtomic} unidades em ${pos.symbol}.`);
    }
  }

  // 3. Recuperação de Rent Exemption: fecha ATA ESTRITAMENTE em liquidações totais (100% vendido)
  if (shouldCloseAta) {
    try {
      await wallet.closeTokenAccount(pos.mint);
      console.log(`🧹 [Higiene On-Chain] Conta ATA de ${pos.symbol} encerrada. ~0.00204 SOL de caução recuperados!`);
    } catch (err: any) {
      console.warn(`⚠️ [Aviso Fechamento ATA] Não foi possível fechar ATA de ${pos.symbol}:`, err?.message || err);
    }
  } else {
    console.log(`🛡️ [Custódia Parcial] Conta ATA de ${pos.symbol} mantida aberta para os 50% restantes (Super Runner Mode).`);
  }

  // 4. Quarentena Inteligente por Motivo de Saída
  if (!isPartial) {
    const QUARANTINE_MS: Record<string, number> = {
      STOP_LOSS:     3 * 60 * 60 * 1000,  // 3 horas
      TIME_STOP:     30 * 60 * 1000,       // 30 minutos
      MANUAL:        24 * 60 * 60 * 1000,  // 24 horas
      TRAILING_STOP: 0,
      TAKE_PROFIT:   0
    };
    const quarantineMs = QUARANTINE_MS[exitReason] ?? 0;
    if (quarantineMs > 0) {
      const labels: Record<string, string> = { STOP_LOSS: '3h', TIME_STOP: '30min', MANUAL: '24h' };
      const label = labels[exitReason] || '?h';
      const reasonText = `Quarentena Pós-${exitReason}: cooldown de ${label}`;
      antiSpamMemory.recordVeto(pos.mint, reasonText, quarantineMs);
      console.log(`🛑 [Quarentena ${label}] ${pos.symbol} bloqueado para recompra (${exitReason}).`);

      // Persistência ativa no PostgreSQL (Fim da amnésia pós-deploy)
      postgresRepo.saveQuarantine({
        mint: pos.mint,
        symbol: pos.symbol,
        reason: reasonText,
        expiresAt: new Date(Date.now() + quarantineMs)
      }).catch(() => {});
    }
  }

  // 5. Registra Trade Fechado
  const pnlSol = pnlPct * (pos.entrySol || 0.015);

  // Registro do resultado no Drawdown Breaker para proteção de capital diária
  drawdownBreaker.recordTradeResult(pnlSol);

  positionEngine.recordClosedTrade({
    mint: pos.mint,
    symbol: pos.symbol,
    tokenAmount: tokenAmountToSell,
    entryPriceUsd: pos.entryPriceUsd,
    exitPriceUsd: exitSolValue > 0 ? (exitSolValue / tokenAmountToSell) : pos.entryPriceUsd,
    entryTimestamp: pos.entryTimestamp,
    exitTimestamp: Date.now(),
    pnlPct,
    pnlUsdEst: (pnlSol * 130), // Estimativa USD
    pnlSolEst: pnlSol,
    exitReason,
    txSignature: exitSwap.txSignature
  });

  // 5.1 Registro assíncrono no Decision Journal (trade_outcomes) — ZERO bloqueio do loop de 1.5s
  const exitTypeMap: Record<string, DecisionType> = {
    STOP_LOSS: 'EXIT_SL',
    PARTIAL_TAKE_PROFIT_50: 'EXIT_PARTIAL',
    TRAILING_STOP: 'EXIT_TRAILING',
    TIME_STOP: 'EXIT_TIME_STOP',
    MANUAL: 'EXIT_PANIC',
    TAKE_PROFIT: 'EXIT_PARTIAL',
  };

  const rentRecovered = shouldCloseAta ? 0.00204 : 0;
  const feesSol = 0.00005;
  const netPnlSol = pnlSol - feesSol + rentRecovered;
  const tradeDurationS = Math.floor((Date.now() - pos.entryTimestamp) / 1000);

  journal.logOutcome({
    traceId: pos.traceId || randomUUID(),
    mint: pos.mint,
    entryPriceUsd: pos.entryPriceUsd,
    entrySizeSol: pos.entrySol || 0.05,
    entryTimestamp: new Date(pos.entryTimestamp),
    exitPriceUsd: exitSolValue > 0 ? (exitSolValue / tokenAmountToSell) : pos.entryPriceUsd,
    exitSizeSol: exitSolValue,
    exitTimestamp: new Date(),
    exitReason: exitTypeMap[exitReason] || 'EXIT_WATCHDOG',
    pnlSol,
    pnlPct: pnlPct * 100,
    feesTotalSol: feesSol,
    rentRecoveredSol: rentRecovered,
    netPnlSol,
    totalTradeDurationS: tradeDurationS,
    status: shouldCloseAta ? (exitReason === 'MANUAL' ? 'PANIC_CLOSED' : 'FULLY_CLOSED') : 'PARTIAL_CLOSED'
  });

  // Se for liquidação total, remove do Gestor de Posições
  if (shouldCloseAta) {
    positionEngine.removePosition(pos.mint);
  }

  // CORREÇÃO: Atualiza saldo imediatamente após venda
  try {
    const newBalance = await wallet.getBalanceSol();
    latestState.balanceSol = newBalance;
    console.log(`💰 [SALDO ATUALIZADO] Novo saldo após venda: ${newBalance.toFixed(4)} SOL`);
  } catch (balanceErr: any) {
    console.warn(`⚠️ [SALDO] Falha ao atualizar saldo após venda: ${balanceErr?.message || balanceErr}`);
  }

  // Notificação assíncrona ao Cérebro & Telegram (não bloqueante)
  cerebroService.notifyTradeEvent({
    title: isPartial ? 'Colheita Parcial (+100%)' : `Saída Executada (${exitReason})`,
    symbol: pos.symbol,
    mint: pos.mint,
    action: isPartial ? 'Venda de 50% / Breakeven ativado' : 'Liquidação Total / ATA encerrada',
    pnlPct,
    solValue: exitSolValue,
    txSignature: exitSwap.txSignature
  }).catch(() => {});

  updateDashboardViews();
  return { success: true, txSignature: exitSwap.txSignature };
}

function updateDashboardViews() {
  const currentPositions = positionEngine.getAllPositions();
  latestState.positions = currentPositions.map(p => {
    const existing = latestState.positions.find(prev => prev.mint === p.mint);
    return {
      mint: p.mint,
      symbol: p.symbol,
      tokenAmount: p.tokenAmount,
      entryPriceUsd: p.entryPriceUsd,
      currentPriceUsd: existing && existing.currentPriceUsd > 0 ? existing.currentPriceUsd : p.entryPriceUsd,
      pnlPct: existing ? existing.pnlPct : 0,
      stopLossPct: p.stopLossPct,
      takeProfitPct: p.takeProfitPct,
      entryTimestamp: p.entryTimestamp,
      // O painel exibia "INATIVO" permanente porque estes campos nunca eram
      // mapeados. O monitor calcula trailingActive/stopStatusText; aqui só
      // propagamos o último valor conhecido.
      trailingActive: p.trailingActive ?? false,
      trailingStopSolValue: p.trailingStopSolValue,
      stopStatusText: p.stopStatusText,
      peakSolValue: p.peakSolValue,
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

// Inicia servidor HTTP modular para Healthcheck, API REST e Dashboard Web
const server = http.createServer(async (req, res) => {
  const handled = await handleApiRoutes(req, res, {
    latestState,
    drawdownState: drawdownBreaker.getState(),
    executeExitOrder: (mint, reason, pnlPct, exitSolValue) =>
      executeExitOrder(mint, reason as any, pnlPct, exitSolValue),
    liquidateHolding: async (payload: { mint: string; symbol: string; amount: number; decimals: number }) => {
      const { mint, symbol } = payload;
      console.log(`🚨 [AÇÃO ON-CHAIN MANUAL] Liquidando token avulso ${symbol} (${mint})`);

      // Nunca confiar no amount/decimals enviados pelo browser para construir a ordem.
      const splAccounts = await wallet.getSplTokenAccounts();
      const holding = splAccounts.find(t => t.mint === mint);
      if (!holding) {
        return { success: false, error: 'Holding SPL positivo não encontrado na carteira.' };
      }
      const rawLamports = assertAtomicAmountToNumber(holding.atomicAmount);

      const exitSwap = await jupiterEngine.executeSwap({
        inputMint: mint,
        outputMint: 'So11111111111111111111111111111111111111112',
        amountLamports: rawLamports,
        userPublicKey: OFFICIAL_PHANTOM_WALLET,
        keypair: wallet.getKeypair(),
        slippageBps: 500,
        priorityLevel: 'high'
      });

      if (exitSwap.status !== 'SUCCESS' && exitSwap.status !== 'DRY_RUN_SUCCESS') {
        return {
          success: false,
          error: exitSwap.error || 'Swap de liquidação falhou; posição e ATA foram preservadas.'
        };
      }

      if (exitSwap.status === 'DRY_RUN_SUCCESS') {
        return { success: true, simulated: true, txSignature: exitSwap.txSignature };
      }

      positionEngine.removePosition(mint);
      antiSpamMemory.recordVeto(mint, 'Quarentena Pós-Liquidação Manual On-Chain', 24 * 60 * 60 * 1000);

      await new Promise(r => setTimeout(r, 2000));
      const closeResult = await wallet.closeTokenAccount(mint);

      return {
        success: true,
        txSignature: exitSwap.txSignature,
        rentRecovered: closeResult.success,
        warning: closeResult.success ? undefined : 'Swap concluído, mas a ATA não pôde ser fechada.'
      };
    },
    getAllOpenPositions: () => positionEngine.getAllPositions(),
    sweepRent: () => rentRecovery.sweepOrphanAccounts(),
    panicToken: async (mint: string) => {
      console.log(`🚨 [API PANIC TOKEN] Liquidando moeda ${mint} a mercado via Jupiter V6...`);
      positionEngine.removePosition(mint);

      const splAccounts = await wallet.getSplTokenAccounts();
      const holding = splAccounts.find(t => t.mint === mint);
      const amount = holding ? holding.tokenAmount : 0;
      const decimals = holding ? holding.decimals : 9;
      const rawLamports = Math.floor(amount * Math.pow(10, decimals));

      let txSignature: string | null = null;
      if (rawLamports > 0) {
        const swapRes = await jupiterEngine.executeSwap({
          inputMint: mint,
          outputMint: 'So11111111111111111111111111111111111111112',
          amountLamports: rawLamports,
          userPublicKey: OFFICIAL_PHANTOM_WALLET,
          keypair: wallet.getKeypair(),
          slippageBps: 500,
          priorityLevel: 'high'
        });
        txSignature = swapRes.txSignature;
      }

      await rentRecovery.closeTokenAccount(mint);
      antiSpamMemory.recordVeto(mint, 'Pânico Manual Individual On-Chain', 24 * 60 * 60 * 1000);
      updateDashboardViews();

      return {
        success: true,
        txid: txSignature || 'PANIC_SUCCESS',
        message: 'Moeda liquidada e aluguel de ~0.00204 SOL recuperado.'
      };
    },
    panicAll: async () => {
      console.log('🚨 [API PANIC ALL] Desarmando Sentinel, liquidando todos os tokens e fechando ATAs...');
      latestState.circuitBreakerActive = true;
      axios.post(`${MACRO_SENTINEL_URL}/v1/sentinel/breaker/trip`, {}).catch(() => {});

      positionEngine.clearPositions();

      const splAccounts = await wallet.getSplTokenAccounts();
      const BASE_MINTS = new Set([
        'So11111111111111111111111111111111111111112',
        'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'
      ]);

      let liquidationsCount = 0;
      for (const spl of splAccounts) {
        if (BASE_MINTS.has(spl.mint) || spl.tokenAmount <= 0) continue;
        try {
          const rawLamports = Math.floor(spl.tokenAmount * Math.pow(10, spl.decimals));
          await jupiterEngine.executeSwap({
            inputMint: spl.mint,
            outputMint: 'So11111111111111111111111111111111111111112',
            amountLamports: rawLamports,
            userPublicKey: OFFICIAL_PHANTOM_WALLET,
            keypair: wallet.getKeypair(),
            slippageBps: 500,
            priorityLevel: 'high'
          });
          await rentRecovery.closeTokenAccount(spl.mint);
          liquidationsCount++;
        } catch (err: any) {
          console.warn(`⚠️ [PANIC ALL] Falha ao liquidar ${spl.mint}:`, err?.message || err);
        }
      }

      await rentRecovery.sweepOrphanAccounts();
      updateDashboardViews();

      return {
        success: true,
        liquidationsCount,
        message: 'Pânico geral executado com sucesso.'
      };
    },
    runCalibration: async () => {
      return runCalibrationNow(pgPool);
    },
    getSnapshots: async (limit: number) => {
      if (!pgPool) return [];
      const res = await pgPool.query(
        `SELECT * FROM calibration_snapshots ORDER BY computed_at DESC LIMIT $1`,
        [limit]
      );
      return res.rows;
    },
    pgPool,
    journal
  });

  if (!handled) {
    res.writeHead(404);
    res.end();
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 Servidor ativo em http://0.0.0.0:${PORT}`);
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
    
    // CORREÇÃO: Log de debug mesmo sem posições (para diagnóstico)
    if (openPositions.length === 0) {
      return;
    }

    for (const pos of openPositions) {
      try {
        // Sensor econômico primário: DexScreener. Se indisponível, entra em
        // modo degradado usando Jupiter como sensor temporário. Só consideramos
        // perda real de sinal se as duas fontes falharem.
        const entrySol = pos.entrySol || 0.015;
        if (!pos.entryPriceUsd || pos.entryPriceUsd <= 0) {
          throw new Error('Posição sem preço USD de entrada para monitor de saída');
        }

        let sensorPriceUsd = await scanner.fetchCurrentTokenPriceUsd(pos.mint);
        let currentSolValue: number;
        let pnlPct: number;
        let sensorSource = 'DEXSCREENER';

        if (sensorPriceUsd && Number.isFinite(sensorPriceUsd) && sensorPriceUsd > 0) {
          pnlPct = (sensorPriceUsd / pos.entryPriceUsd) - 1;
          currentSolValue = entrySol * (1 + pnlPct);
        } else {
          sensorSource = 'JUPITER_DEGRADED';
          const tokenAtomicAmount = assertAtomicAmountToNumber(pos.tokenAmount);
          const fallbackQuote = await jupiterEngine.getQuote(
            pos.mint,
            'So11111111111111111111111111111111111111112',
            tokenAtomicAmount,
            500
          );
          currentSolValue = (fallbackQuote.outAmount || 0) / 1e9;
          if (!Number.isFinite(currentSolValue) || currentSolValue <= 0) {
            throw new Error('DexScreener e Jupiter sem preço válido para monitor de saída');
          }
          pnlPct = (currentSolValue - entrySol) / entrySol;
          sensorPriceUsd = pos.entryPriceUsd * (1 + pnlPct);
          console.warn(
            `⚠️ [ExitSensor Degradado] DexScreener indisponível para ${pos.symbol}; ` +
            'Jupiter assumiu temporariamente o monitoramento.'
          );
        }
        
        // Atualiza pico local antes de exibir proteção. O evaluateExitBySol persiste
        // o mesmo pico logo abaixo; aqui evitamos uma defasagem visual de um ciclo.
        const peakSolValue = Math.max(positionEngine.getPeakSolValue(pos.mint), currentSolValue, entrySol);
        const peakPnlPct = (peakSolValue - entrySol) / entrySol;
        const earlyTrailingActive = !pos.partialTaken &&
          peakPnlPct >= PositionExitEngine.EARLY_TRAILING_TRIGGER_PCT;
        const activeTrailingDistance = pos.partialTaken
          ? PositionExitEngine.TRAILING_DISTANCE
          : PositionExitEngine.EARLY_TRAILING_DISTANCE;
        const trailingStopSolValue = peakSolValue * (1 - activeTrailingDistance);
        const trailPnlPct = (trailingStopSolValue - entrySol) / entrySol;
        const trailingStatus = (pos.partialTaken || earlyTrailingActive) ? 'ATIVO' : 'INATIVO';
        console.log(
          `[ExitSensor] Token: ${pos.symbol} | Fonte: ${sensorSource} | PnL: ${(pnlPct * 100).toFixed(2)}% | ` +
          `SL: ${((pos.stopLossPct || -0.06) * 100).toFixed(0)}% | Trailing: ${trailingStatus}`
        );

        const elapsedMin = Math.floor((Date.now() - pos.entryTimestamp) / 60000);
        const dashPos = latestState.positions.find(p => p.mint === pos.mint);
        if (dashPos) {
          dashPos.pnlPct = pnlPct;
          dashPos.currentPriceUsd = sensorPriceUsd;
        }

        // 📊 Log Sintético de Monitor de Posição (a cada ciclo de 1.5s)
        const pnlSign = pnlPct >= 0 ? '+' : '';
        const peakSign = peakPnlPct >= 0 ? '+' : '';
        const partialLabel = pos.partialTaken ? ' [SUPER RUNNER / 50%]' : '';

        // Exibição clara e não ambígua do status de proteção.
        const stopStatusText = pos.partialTaken
          ? `Stop Ativo: Trailing Dinâmico (-10% do Topo: ${trailPnlPct >= 0 ? '+' : ''}${(trailPnlPct * 100).toFixed(2)}%)`
          : earlyTrailingActive
            ? `Stop Ativo: Trailing Momentum (-6% do Topo: ${trailPnlPct >= 0 ? '+' : ''}${(trailPnlPct * 100).toFixed(2)}%)`
            : `Stop Ativo: SL Fixo (${(pos.stopLossPct * 100).toFixed(2)}%) | Trailing: aguardando +8%`;

        console.log(`🟡 [SNIPER ATIVO${partialLabel}] Token: ${pos.symbol} | Sensor PnL: ${pnlSign}${(pnlPct * 100).toFixed(2)}% | Pico: ${peakSign}${(peakPnlPct * 100).toFixed(2)}% | ${stopStatusText} | Tempo: ${elapsedMin}min`);

        // Propaga o estado real de proteção para o painel. Sem isto a coluna
        // "Trailing Stop" ficava em INATIVO mesmo com o trailing ativo.
        pos.trailingActive = pos.partialTaken || earlyTrailingActive;
        pos.stopStatusText = stopStatusText;
        pos.peakSolValue = peakSolValue;
        pos.trailingStopSolValue = trailingStopSolValue;

        // 🧠 Ayla Sentinela de Saída Adaptativa:
        // Passa contexto atual da posição se disponível
        const exitSignal = positionEngine.evaluateExitBySol(
          pos.mint,
          currentSolValue,
          Date.now(),
          {
            currentLiquidityUsd: pos.entryLiquidityUsd, // atualizado dinamicamente
            currentVolume5m: pos.entryVolume5m
          }
        );

        positionEngine.recordQuoteSuccess(pos.mint);

        if (exitSignal.shouldExit && exitSignal.type !== 'HOLD') {
          // O sensor só arma a saída. A decisão financeira final usa uma cotação
          // executável Jupiter imediatamente antes do swap.
          const tokenAtomicAmount = assertAtomicAmountToNumber(pos.tokenAmount);
          const executableQuote = await jupiterEngine.getQuote(
            pos.mint,
            'So11111111111111111111111111111111111111112',
            tokenAtomicAmount,
            500
          );
          const executableSolValue = (executableQuote.outAmount || 0) / 1e9;
          const executablePnlPct = (executableSolValue - entrySol) / entrySol;
          const confirmedSignal = positionEngine.evaluateExitBySol(
            pos.mint,
            executableSolValue,
            Date.now(),
            {
              currentLiquidityUsd: pos.entryLiquidityUsd,
              currentVolume5m: pos.entryVolume5m
            }
          );

          if (confirmedSignal.shouldExit && confirmedSignal.type !== 'HOLD') {
            const detail = confirmedSignal.reasonDetail ? ` [${confirmedSignal.reasonDetail}]` : '';
            console.log(
              `🎯 [EXIT CONFIRMADO JUPITER${detail}] ${pos.symbol}: ${confirmedSignal.type} | ` +
              `PnL executável: ${(executablePnlPct * 100).toFixed(2)}% | Valor: ${executableSolValue.toFixed(4)} SOL`
            );
            await executeExitOrder(pos.mint, confirmedSignal.type, executablePnlPct, executableSolValue, {
              exitTokenAmount: confirmedSignal.exitTokenAmount,
              shouldCloseAta: confirmedSignal.shouldCloseAta
            });
          } else {
            console.log(
              `🟢 [EXIT NÃO CONFIRMADO] ${pos.symbol}: DexScreener acionou ${exitSignal.type}, ` +
              `mas a cotação executável Jupiter não confirmou o gatilho.`
            );
          }
        }
      } catch (quoteErr: any) {
        const { failures, shouldWarn, shouldEmergencyExit } = positionEngine.recordQuoteFailure(pos.mint);
        if (shouldWarn) {
          console.warn(`⚠️ [WATCHDOG] Instabilidade de sinal para ${pos.mint}. Tentando endpoint RPC secundário...`);
        } else if (shouldEmergencyExit) {
          console.error(`🚨 [WATCHDOG CONTINGÊNCIA] 8 falhas consecutivas de cotação (12s sem cotação). Disparando liquidação defensiva de emergência para ${pos.symbol} (${pos.mint})!`);
          try {
            let rawLamports: number;
            try {
              rawLamports = assertAtomicAmountToNumber(pos.tokenAmount);
            } catch (amountErr: any) {
              throw new Error(`Watchdog recusou quantidade n?o at?mica: ${amountErr?.message || amountErr}`);
            }
            const emergencySwap = await jupiterEngine.executeSwap({
              inputMint: pos.mint,
              outputMint: 'So11111111111111111111111111111111111111112',
              amountLamports: rawLamports,
              userPublicKey: OFFICIAL_PHANTOM_WALLET,
              keypair: wallet.getKeypair(),
              slippageBps: 600, // 6.0% slippage defensivo
              priorityLevel: 'high'
            });
            if (emergencySwap.status !== 'SUCCESS' && emergencySwap.status !== 'DRY_RUN_SUCCESS') {
              throw new Error(`Swap do watchdog não confirmado (${emergencySwap.status}): ${emergencySwap.error || 'sem detalhe'}. Posição e ATA preservadas.`);
            }
            if (emergencySwap.status === 'SUCCESS') {
              const closeResult = await rentRecovery.closeTokenAccount(pos.mint);
              if (!closeResult.success) {
                throw new Error('Swap confirmado, mas fechamento da ATA falhou; posição preservada para reconciliação.');
              }
            }
            antiSpamMemory.recordVeto(pos.mint, 'Watchdog de Perda de Sinal (12s sem cotação)', 24 * 60 * 60 * 1000);
            positionEngine.removePosition(pos.mint);
            positionEngine.recordClosedTrade({
              mint: pos.mint,
              symbol: pos.symbol,
              tokenAmount: pos.tokenAmount,
              entryPriceUsd: pos.entryPriceUsd,
              exitPriceUsd: 0,
              entryTimestamp: pos.entryTimestamp,
              exitTimestamp: Date.now(),
              pnlPct: -0.20,
              pnlUsdEst: 0,
              exitReason: 'MANUAL',
              txSignature: emergencySwap.txSignature
            });
            updateDashboardViews();
          } catch (emergencyErr: any) {
            console.error(`❌ [WATCHDOG ERRO] Falha ao executar liquidação defensiva de ${pos.symbol}:`, emergencyErr?.message || emergencyErr);
          }
        }
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
      
      // Alimenta a tabela de Ativos Custodiados On-Chain para o Dashboard
      latestState.walletHoldings = splAccounts.map(spl => ({
        mint: spl.mint,
        symbol: spl.mint.slice(0, 4) + '...' + spl.mint.slice(-4),
        tokenAmount: spl.tokenAmount,
        decimals: spl.decimals,
        ataAddress: spl.ataAddress,
        solscanUrl: `https://solscan.io/token/${spl.mint}`,
        dexScreenerUrl: `https://dexscreener.com/solana/${spl.mint}`
      }));

      for (const spl of splAccounts) {
        if (!positionEngine.getPosition(spl.mint)) {
          const meta = await scanner.fetchTokenMetadata(spl.mint);
          const price = (meta && meta.priceUsd > 0) ? meta.priceUsd : 0.00001;
          const symbol = meta?.symbol || (spl.mint.slice(0, 4) + '...' + spl.mint.slice(-4));
          
          // Atualiza símbolo no walletHoldings se disponível
          const h = latestState.walletHoldings.find(x => x.mint === spl.mint);
          if (h && meta?.symbol) h.symbol = meta.symbol;

          const atomicAmount = assertAtomicAmountToNumber(spl.atomicAmount);
          positionEngine.addPosition({
            mint: spl.mint,
            symbol,
            tokenAmount: atomicAmount,
            entryPriceUsd: price,
            entryTimestamp: Date.now(),
            stopLossPct: -0.20,
            takeProfitPct: 0.50,
            entrySol: 0.015
          });
          console.log(`📦 [Custódia On-Chain Detectada] ${spl.tokenAmount.toLocaleString()} de ${symbol} (${spl.mint}) adicionados (${atomicAmount} unidades atômicas).`);
        }
      }
    } catch (err: any) {
      console.warn(`⚠️ [Aviso Custódia] Falha ao sincronizar contas SPL: ${err?.message || err}`);
    }

    updateDashboardViews();

    // 🎯 CONCORRÊNCIA E ALOCAÇÃO DE CAPITAL (MAX_CONCURRENT_POSITIONS = 2, máx 0.10 SOL)
    const activePositions = positionEngine.getAllPositions();
    if (activePositions.length >= MAX_CONCURRENT_POSITIONS) {
      console.log(`🎯 [TETO DE CONCORRÊNCIA ATINGIDO] ${activePositions.length}/${MAX_CONCURRENT_POSITIONS} posições em custódia (${activePositions.map(p => p.symbol).join(', ')}). Scanner de novas compras em pausa.`);
      return;
    }

    // 🛑 DRAWDOWN BREAKER: Bloqueia novas entradas se o PnL diário exceder os limiares de risco
    if (!drawdownBreaker.canOpenNewPosition()) {
      const ddState = drawdownBreaker.getState();
      const pauseLabel = ddState.tier === 'PAUSED_DRAWDOWN_TIER2' ? 'até 00:00 UTC' : 'por 4h';
      console.log(`🛑 [DRAWDOWN BREAKER: ${ddState.tier}] PnL diário: ${ddState.dailyPnlSol.toFixed(4)} SOL. Novas entradas bloqueadas ${pauseLabel}.`);
      return;
    }

    const totalAllocatedSol = activePositions.reduce((acc, p) => acc + (p.entrySol || TRADE_AMOUNT_SOL), 0);
    if (totalAllocatedSol >= MAX_TOTAL_ALLOCATION_SOL) {
      console.log(`💰 [ALOCAÇÃO MÁXIMA ATINGIDA] Capital alocado (${totalAllocatedSol.toFixed(2)} SOL) atingiu teto de ${MAX_TOTAL_ALLOCATION_SOL} SOL. Aguardando saídas.`);
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
    console.log('🔍 [1/3 Scanner Descoberta] Buscando piscinas consolidadas (5-60m | Liquidez >= $15k)...');
    const candidates = await scanner.scanSolanaTrends(15000);
    const { waiting, mature, technicalDiscards: scannerDiscards } = scanner.lastIncubatorStats;

    let technicalDiscardCount = scannerDiscards || 0;
    let quarantineCount = 0;
    const eligibleCandidates: typeof candidates = [];

    for (const token of candidates) {
      const nowTs = Date.now();
      const tokenAgeMinutes = token.pairCreatedAt
        ? Math.max(0, Math.floor((nowTs - token.pairCreatedAt) / 60000))
        : 0;

      const classification = TokenClassifier.classify(token.mint, token.symbol, token.liquidityUsd);
      if (!classification.isEligibleForMemeScan) {
        technicalDiscardCount++;
        // Registro assíncrono no Decision Journal (rejeição de maturação / descarte técnico)
        journal.logDecision({
          traceId: randomUUID(),
          decision: 'ENTRY_REJECTED',
          token: {
            mint: token.mint,
            tokenSymbol: token.symbol,
            poolAddress: (token as any).pairAddress,
            ageMinutes: tokenAgeMinutes,
            liquidityUsd: token.liquidityUsd,
            priceUsd: token.priceUsd,
            priceChange5mPct: token.priceChangeM5,
            volume5mUsd: token.volume5mUsd
          },
          market: {
            sentinelRegime: (latestState.macroRegime as any) || 'NEUTRAL_RANGING',
            sessionHourUtc: new Date().getUTCHours(),
            isWeekend: [0, 6].includes(new Date().getUTCDay())
          },
          gateEvaluations: [
            DecisionLogger.evaluateGate('MATURITY_AGE', tokenAgeMinutes >= 5, tokenAgeMinutes, 5),
            DecisionLogger.evaluateGate('LIQUIDITY_THRESHOLD', (token.liquidityUsd || 0) >= 15000, token.liquidityUsd, 15000)
          ],
          rejectionReason: classification.reason || 'Descarte por classificação técnica'
        });

        // TTL inteligente de 5 minutos: permite que tokens com liquidez oscilante ou status transitório sejam reavaliados
        antiSpamMemory.recordTechnicalDiscard(token.mint, classification.reason || 'Descarte por classificação técnica', 5);
        continue;
      }

      const spamCheck = antiSpamMemory.shouldSkip(token.mint);
      if (spamCheck.skip) {
        quarantineCount++;
        continue;
      }

      eligibleCandidates.push(token);
    }

    const logMsg = `📊 [Incubadora: ${waiting} aguardando | Maturos (5-60m): ${mature} | Descarte Técnico: ${technicalDiscardCount} | Quarentena: ${quarantineCount} | Elegíveis para Laya: ${eligibleCandidates.length}]`;
    console.log(logMsg);

    latestState.incubator = {
      waiting,
      mature,
      technicalDiscards: technicalDiscardCount,
      aylaEligible: eligibleCandidates.length
    };

    // Registra no buffer de scannerLogs para exposição na API e Dashboard
    if (!latestState.scannerLogs) latestState.scannerLogs = [];
    latestState.scannerLogs.unshift({
      timestamp: new Date().toLocaleTimeString(),
      message: logMsg,
      type: eligibleCandidates.length > 0 ? 'success' : 'info'
    });
    if (latestState.scannerLogs.length > 15) latestState.scannerLogs.pop();

    if (eligibleCandidates.length > 0) {
      // PRIORIDADE 2: Fila de fallback - tenta até 3 candidatos se os primeiros falharem
      const maxCandidatesToTry = Math.min(3, eligibleCandidates.length);
      let candidateProcessed = false;
      
      for (let candidateIndex = 0; candidateIndex < maxCandidatesToTry && !candidateProcessed; candidateIndex++) {
        const topCandidate = eligibleCandidates[candidateIndex];
        const classification = TokenClassifier.classify(topCandidate.mint, topCandidate.symbol, topCandidate.liquidityUsd);

        console.log(`🔥 Analisando Candidato #${candidateIndex + 1}/${maxCandidatesToTry}: ${topCandidate.symbol} (${topCandidate.name})`);
        console.log(`   Subgrupo: [${classification.category}] | Mint: ${topCandidate.mint}`);
        console.log(`   Liquidez: $${topCandidate.liquidityUsd.toLocaleString()} | Preço: $${topCandidate.priceUsd}`);

        // Ciclo 3: Sentinela de Risco (RugCheck + Laya + Price Action Momentum)
        console.log('🛡️ [2/3 Sentinela Anti-Rug] Auditando contrato, liquidez e momentum de preço...');
        const audit = await gatekeeper.auditToken({
        mint: topCandidate.mint,
        liquidityUsd: topCandidate.liquidityUsd,
        mintAuthority: null,
        freezeAuthority: null,
        holdersCount: 250,
        priceChangeM5: topCandidate.priceChangeM5,
        buysM5: topCandidate.buysM5,
        sellsM5: topCandidate.sellsM5,
        volumeBuysM5: topCandidate.volumeBuysM5,
        volumeSellsM5: topCandidate.volumeSellsM5,
        priceUsd: topCandidate.priceUsd,
        h1HighPriceUsd: topCandidate.h1HighPriceUsd
      });

      console.log(`   Veredito de Segurança: ${audit.safe ? 'APROVADO ✅' : 'VETADO ⛔'}`);
      console.log(`   Score: ${audit.score}/100 | Validador: ${audit.validatedBy}`);

      if (audit.safe) {
        const m5Pct = topCandidate.priceChangeM5 !== undefined ? topCandidate.priceChangeM5.toFixed(1) : '0.0';
        const buys = topCandidate.buysM5 ?? 0;
        const sells = topCandidate.sellsM5 ?? 0;
        console.log(`🛡️ [Ayla Aprovado]: Contrato Seguro (80+) | Momentum m5: +${m5Pct}% | Buys/Sells: ${buys}/${sells} | Vol Comprador > Vendedor`);
      }

      let txSignature: string | null = null;

      // Avaliação detalhada dos 9 gates para o Decision Journal
      const openPositions = positionEngine.getAllPositions().length;
      const candidateAgeMinutes = topCandidate.pairCreatedAt
        ? Math.max(0, Math.floor((Date.now() - topCandidate.pairCreatedAt) / 60000))
        : 0;
      const buySellRatio = topCandidate.sellsM5 && topCandidate.sellsM5 > 0
        ? Number(((topCandidate.buysM5 || 0) / topCandidate.sellsM5).toFixed(2))
        : (topCandidate.buysM5 ? 2.0 : 1.0);
      const isPriceWindowValid = (topCandidate.priceChangeM5 ?? 0) >= 3 && (topCandidate.priceChangeM5 ?? 0) <= 85;
      const isBuyDominanceValid = buySellRatio >= 1.0;
      const isSentinelValid = ['NORMAL', 'NEUTRAL_RANGING'].includes(latestState.macroRegime || 'NORMAL');

      const gates: GateEvaluation[] = [
        DecisionLogger.evaluateGate('MATURITY_AGE', candidateAgeMinutes >= 5, candidateAgeMinutes, 5),
        DecisionLogger.evaluateGate('RUG_CHECK', audit.safe, audit.score, 80, audit.reason || undefined),
        DecisionLogger.evaluateGate('MINT_AUTHORITY', true),
        DecisionLogger.evaluateGate('FREEZE_AUTHORITY', true),
        DecisionLogger.evaluateGate('TOP_HOLDERS', true, 20, 20),
        DecisionLogger.evaluateGate('PRICE_WINDOW', isPriceWindowValid, topCandidate.priceChangeM5, 85),
        DecisionLogger.evaluateGate('BUY_DOMINANCE', isBuyDominanceValid, buySellRatio, 1.0),
        DecisionLogger.evaluateGate('SENTINEL_REGIME', isSentinelValid),
        DecisionLogger.evaluateGate('SLOT_AVAILABILITY', openPositions < MAX_CONCURRENT_POSITIONS, openPositions, MAX_CONCURRENT_POSITIONS),
        DecisionLogger.evaluateGate('LIQUIDITY_THRESHOLD', topCandidate.liquidityUsd >= 15000, topCandidate.liquidityUsd, 15000),
        DecisionLogger.evaluateGate('DISTANCE_FROM_LOW', true, 15, 35),
      ];

      const currentTraceId = randomUUID();

        if (!audit.safe) {
          console.log(`   Motivo do Veto: ${audit.reason}`);
          const vetoReasonText = audit.reason || 'Veto preventivo de segurança (RugCheck/Ayla)';
          antiSpamMemory.recordVeto(topCandidate.mint, vetoReasonText, 24 * 60 * 60 * 1000);
          // Persistência ativa no banco por 24 horas
          postgresRepo.saveQuarantine({
            mint: topCandidate.mint,
            symbol: topCandidate.symbol,
            reason: vetoReasonText,
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000)
          }).catch(() => {});

          // Registro assíncrono no Decision Journal (rejeição no Gatekeeper)
          journal.logDecision({
          traceId: currentTraceId,
          decision: 'ENTRY_REJECTED',
          compositeScore: audit.score,
          token: {
            mint: topCandidate.mint,
            tokenSymbol: topCandidate.symbol,
            poolAddress: (topCandidate as any).pairAddress,
            ageMinutes: candidateAgeMinutes,
            liquidityUsd: topCandidate.liquidityUsd,
            priceUsd: topCandidate.priceUsd,
            priceChange5mPct: topCandidate.priceChangeM5,
            buysCount5m: topCandidate.buysM5,
            sellsCount5m: topCandidate.sellsM5,
            buySellRatio,
            volume5mUsd: topCandidate.volume5mUsd,
          },
          market: {
            sentinelRegime: (latestState.macroRegime as any) || 'NEUTRAL_RANGING',
            sessionHourUtc: new Date().getUTCHours(),
            isWeekend: [0, 6].includes(new Date().getUTCDay()),
          },
          gateEvaluations: gates,
          rejectionReason: vetoReasonText,
        });
        
        console.log(`⏭️ Candidato #${candidateIndex + 1} reprovado no gatekeeper. ${candidateIndex + 1 < maxCandidatesToTry ? 'Tentando próximo candidato...' : 'Fim da fila de candidatos.'}`);
        // Não marca como processado - continua loop para próximo candidato
        continue;
      } else {
        antiSpamMemory.recordApproval(topCandidate.mint, audit.score);

        // Registro assíncrono no Decision Journal (aprovação no Gatekeeper)
        journal.logDecision({
          traceId: currentTraceId,
          decision: 'ENTRY_APPROVED',
          compositeScore: audit.score,
          token: {
            mint: topCandidate.mint,
            tokenSymbol: topCandidate.symbol,
            poolAddress: (topCandidate as any).pairAddress,
            ageMinutes: candidateAgeMinutes,
            liquidityUsd: topCandidate.liquidityUsd,
            priceUsd: topCandidate.priceUsd,
            priceChange5mPct: topCandidate.priceChangeM5,
            buysCount5m: topCandidate.buysM5,
            sellsCount5m: topCandidate.sellsM5,
            buySellRatio,
            volume5mUsd: topCandidate.volume5mUsd,
          },
          market: {
            sentinelRegime: (latestState.macroRegime as any) || 'NEUTRAL_RANGING',
            sessionHourUtc: new Date().getUTCHours(),
            isWeekend: [0, 6].includes(new Date().getUTCDay()),
          },
          execution: {
            sizeSol: TRADE_AMOUNT_SOL,
            estimatedSlippagePct: 7.5,
          },
          gateEvaluations: gates,
        });

        // Ciclo 4: Execução na Jupiter V6 (Dry-Run ou Real)
        // Dimensionamento adaptativo: o lote é escolhido pela profundidade real da pool.
        const currentBalance = latestState.balanceSol || (await wallet.getBalanceSol());
        const safeBalance = currentBalance - GAS_RESERVE_SOL;
        if (safeBalance < MIN_TRADE_AMOUNT_SOL) {
          console.log(`🛡️ [Reserva Intocável] Saldo livre (${safeBalance.toFixed(4)} SOL) insuficiente para alocar o lote mínimo ${MIN_TRADE_AMOUNT_SOL} SOL mantendo ${GAS_RESERVE_SOL} SOL de reserva para taxas de saída.`);
          break; // Sem saldo, não tenta mais candidatos
        }

        const SOL_MINT = 'So11111111111111111111111111111111111111112';

        // Gatilho opcional de momentum: observa apenas quotes off-chain/RPC.
        // Nenhuma transação é assinada ou transmitida nesta etapa.
        if (ENTRY_MOMENTUM_GATE_ENABLED) {
          try {
            const momentum = await observeEntryMomentum(
              () => scanner.fetchCurrentTokenPriceUsd(topCandidate.mint),
              {
                samples: ENTRY_MOMENTUM_SAMPLES,
                intervalMs: ENTRY_MOMENTUM_INTERVAL_MS,
                minRisePct: ENTRY_MOMENTUM_MIN_RISE_PCT,
                maxRisePct: ENTRY_MOMENTUM_MAX_RISE_PCT,
                maxPullbackPct: ENTRY_MOMENTUM_MAX_PULLBACK_PCT
              }
            );

            console.log(
              `📈 [Momentum Gate] ${topCandidate.symbol}: alta=${momentum.risePct.toFixed(3)}% | ` +
              `passos=${momentum.risingSteps}/${momentum.samples.length - 1} | ${momentum.reason}`
            );

            if (!momentum.pass) {
              antiSpamMemory.recordVeto(
                topCandidate.mint,
                `Momentum não confirmado: ${momentum.reason}`,
                Math.max(SCAN_INTERVAL_MS, 30_000)
              );
              continue;
            }
          } catch (momentumErr: any) {
            console.warn(
              `⚠️ [Momentum Gate] Falha ao observar ${topCandidate.symbol}: ${momentumErr?.message || momentumErr}`
            );
            continue;
          }
        }

        const quoteParams = {
          inputMint: SOL_MINT,
          outputMint: topCandidate.mint,
          slippageBps: 750,
          autoSlippage: true,
          poolLiquidityUsd: topCandidate.liquidityUsd,
          // Colisao calibrada pela profundidade real da pool, em vez do valor
          // fixo de 1000 USD que apertava demais o slippage em pools de 15k-100k.
          maxAutoSlippageBps: 750
        };

        console.log(`⚡ [3/3 Motor Jupiter V6] Dimensionando lote econômico com validação pré-voo (máx. 2 tentativas | autoSlippage 750bps)...`);

        // O hook `validate` fecha o ciclo sizer -> execução: cada degrau da
        // escada é testado contra a simulação real ANTES de comprometer capital.
        // Sem ele, um lote aprovado só por Price Impact ainda podia ser barrado
        // pelo 6014 no pré-voo interno do executeSwap, e o escalonamento só
        // ocorreria no token seguinte (com 1h de quarentena no meio).
        const economyLadderSol = topCandidate.liquidityUsd >= 200_000
          ? [0.05, 0.02]
          : topCandidate.liquidityUsd >= 75_000
            ? [0.035, 0.015]
            : [0.02, 0.015];

        const sizing = await adaptiveSizer.findExecutableSize(quoteParams, {
          ladderSol: economyLadderSol,
          validate: async (_quote, sizeSol) => {
            try {
              const sim = await jupiterEngine.simulateSwap({
                inputMint: SOL_MINT,
                outputMint: topCandidate.mint,
                amountLamports: Math.floor(sizeSol * 1e9),
                autoSlippage: true,
                poolLiquidityUsd: topCandidate.liquidityUsd,
                maxAutoSlippageBps: 750,
                skipPreflight: false,
                userPublicKey: OFFICIAL_PHANTOM_WALLET,
                keypair: wallet.getKeypair(),
                priorityLevel: 'medium'
              }, _quote);
              if (sim.success) {
                console.log(`   [Escada] Degrau ${sizeSol} SOL: simulacao APROVADA (CU=${sim.unitsConsumed ?? 'n/d'})`);
                return null;
              }
              console.log(`   [Escada] Degrau ${sizeSol} SOL: simulacao FALHOU -> ${sim.error}`);
              return sim.error || 'SIMULATION_REJECTED';
            } catch (err: any) {
              console.warn(`   [Sizing] Pré-voo do lote ${sizeSol} SOL lançou exceção: ${err?.message || err}`);
              return err?.message || 'exceção na simulação pré-voo';
            }
          }
        });

        if (!sizing.success || !sizing.quote) {
          const failReason = sizing.error || 'INSUFFICIENT_POOL_DEPTH';
          console.log(`🚫 [Dimensionamento Abortado] ${topCandidate.symbol}: ${failReason}`);
          console.log(`   Degraus testados: ${sizing.attempts.map((a) => `${a.sizeSol}SOL(pi=${a.priceImpactPct.toFixed(2)}%${a.accepted ? ',ok' : ',rej'})`).join(' -> ')}`);
          journal.logDecision({
            traceId: currentTraceId,
            decision: 'ENTRY_REJECTED',
            compositeScore: audit.score,
            token: {
              mint: topCandidate.mint,
              tokenSymbol: topCandidate.symbol,
              liquidityUsd: topCandidate.liquidityUsd,
              priceUsd: topCandidate.priceUsd
            },
            market: { sentinelRegime: (latestState.macroRegime as any) || 'NEUTRAL_RANGING' },
            gateEvaluations: gates,
            rejectionReason: `${sizing.abortReason}: ${failReason}`,
            metadata: { phase: 'SIZING', attempts: sizing.attempts }
          });
          antiSpamMemory.recordVeto(topCandidate.mint, `Sizing abortado: ${failReason}`, 60 * 60 * 1000);
          postgresRepo.saveQuarantine({
            mint: topCandidate.mint,
            symbol: topCandidate.symbol,
            reason: `Sizing abortado: ${failReason}`,
            expiresAt: new Date(Date.now() + 60 * 60 * 1000)
          }).catch(() => {});
          
          console.log(`⏭️ Candidato #${candidateIndex + 1} falhou no dimensionamento. ${candidateIndex + 1 < maxCandidatesToTry ? 'Tentando próximo candidato...' : 'Fim da fila de candidatos.'}`);
          // Não marca como processado - continua loop para próximo candidato
          continue;
        }

        const dynamicAllocSol = sizing.sizeSol;
        const tradeLamports = Math.floor(dynamicAllocSol * 1e9);
        console.log(`📐 Lote dimensionado e validado no pré-voo: ${dynamicAllocSol} SOL (Price Impact ${Math.abs(sizing.quote.priceImpactPct || 0).toFixed(3)}%)`);
        console.log(`   Escada percorrida: ${sizing.attempts.map((a) => `${a.sizeSol}SOL(${a.accepted ? 'ok' : 'rej'})`).join(' -> ')}`);

        console.log(`⚡ [3/3 Motor Jupiter V6] Executando compra com pré-voo fail-closed (${dynamicAllocSol} SOL | autoSlippage 750bps)...`);
        const swapSim = await jupiterEngine.executeSwap({
          inputMint: SOL_MINT,
          outputMint: topCandidate.mint,
          amountLamports: tradeLamports,
          autoSlippage: true,
                poolLiquidityUsd: topCandidate.liquidityUsd,
          maxAutoSlippageBps: 750, // Teto seguro com margem de 750 bps contra erro 6014
          skipPreflight: false, // Fail-closed: nunca transmite se a simulação rejeitar
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
          // CORREÇÃO: Só adiciona posição se houver txid on-chain confirmado
          if (!swapSim.txSignature && swapSim.status !== 'DRY_RUN_SUCCESS') {
            console.error(`🛑 [ENTRADA REJEITADA] Swap sem txid on-chain: ${topCandidate.symbol} | Status: ${swapSim.status}`);
            antiSpamMemory.recordVeto(topCandidate.mint, 'Swap sem txid on-chain', 60 * 60 * 1000);
            return;
          }
          
          // Snapshot de Entrada (Contexto Inicial da Operação):
          const nowTs = Date.now();
          positionEngine.addPosition({
            mint: topCandidate.mint,
            symbol: topCandidate.symbol,
            tokenAmount: swapSim.outAmount,
            entryPriceUsd: topCandidate.priceUsd,
            entryTimestamp: nowTs,
            stopLossPct: -0.06,
            takeProfitPct: 0.35, // +35% para colheita parcial 50%
            entrySol: dynamicAllocSol,
            entrySolValue: dynamicAllocSol,
            entryLiquidityUsd: topCandidate.liquidityUsd,
            entryVolume5m: topCandidate.volume5mUsd || 0,
            traceId: currentTraceId
          });
          console.log(`📈 Posição em ${topCandidate.symbol} registrada no Gestor de Posições (Snapshot: Liq $${topCandidate.liquidityUsd.toLocaleString()} | Vol5m $${(topCandidate.volume5mUsd || 0).toLocaleString()} | Alocação: ${dynamicAllocSol} SOL | SL: -6% | TP: +35%)`);
          
          // CORREÇÃO: Atualiza saldo imediatamente após compra
          const newBalance = await wallet.getBalanceSol();
          latestState.balanceSol = newBalance;
          console.log(`💰 [SALDO ATUALIZADO] Novo saldo após compra: ${newBalance.toFixed(4)} SOL`);
          
          updateDashboardViews();

          // Notificação assíncrona ao Cérebro & Telegram (não bloqueante)
          cerebroService.notifyTradeEvent({
            title: `Nova Entrada Executada (Sniper ${dynamicAllocSol} SOL)`,
            symbol: topCandidate.symbol,
            mint: topCandidate.mint,
            action: `Compra na Jupiter V6 | Lote: ${swapSim.outAmount.toLocaleString()}`,
            solValue: dynamicAllocSol,
            txSignature: swapSim.txSignature,
            detail: `Liq: $${topCandidate.liquidityUsd.toLocaleString()} | Vol5m: $${(topCandidate.volume5mUsd || 0).toLocaleString()}`
          }).catch(() => {});
          
          // Marca candidato como processado com sucesso - não tenta próximo
          candidateProcessed = true;
        } else {
          const failReason = swapSim.error || '0x177e (SlippageExceeded ou liquidez insuficiente)';
          const swapVetoText = `Swap Jupiter falhou: ${failReason}`;
          antiSpamMemory.recordVeto(topCandidate.mint, swapVetoText, 60 * 60 * 1000);
          // Persistência ativa no banco por 1 hora
          postgresRepo.saveQuarantine({
            mint: topCandidate.mint,
            symbol: topCandidate.symbol,
            reason: swapVetoText,
            expiresAt: new Date(Date.now() + 60 * 60 * 1000)
          }).catch(() => {});
          // Registra falha no dashboard como auditoria com swapFailReason visivel
          latestState.recentAudits[0] = { ...latestState.recentAudits[0], swapFailReason: failReason } as any;
          
          console.log(`⏭️ Swap falhou para candidato #${candidateIndex + 1}. ${candidateIndex + 1 < maxCandidatesToTry ? 'Tentando próximo candidato...' : 'Fim da fila de candidatos.'}`);
          // Não marca como processado - continua loop para próximo candidato
        }
        
        // Persistência no Postgres Central (Stateless Event Store) - dentro do loop
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
          swapFailReason: undefined, // preenchido abaixo se o swap falhar
          timestamp: Date.now()
        } as any);
        if (latestState.recentAudits.length > 20) latestState.recentAudits.pop();
      } // fecha else do if (!audit.safe)
      } // fecha for loop
    } else { // fecha if (eligibleCandidates.length > 0)
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

/**
 * 🔄 REIDRATAÇÃO ON-CHAIN NO BOOT (Fim da Amnésia pós-Restart)
 * Consulta getParsedTokenAccountsByOwner na carteira Phantom:
 * Se houver qualquer token SPL com saldo > 0 diferente de SOL/USDC,
 * reidrata-o automaticamente como posição ativa no PositionExitEngine.
 */
/** Janela de reidratação: só recompramos_positions dentro deste prazo. */
const REHYDRATE_WINDOW_MS = 2 * 60 * 60 * 1000; // 2 horas

/**
 * Mints que o AGENTE comprou: registrados como ENTRY_APPROVED no ledger dentro
 * da janela de reidratação. Sem isso, qualquer token solto na carteira virava
 * posição gerida com stop loss sintético.
 */
async function queryAgentOwnedMints(): Promise<Set<string>> {
  const mints = new Set<string>();
  const pool = postgresRepo.getPool();
  if (!pool) {
    console.warn('⚠️ [BOOT] Sem pool Postgres — reidratação pulada por segurança.');
    return mints;
  }
  try {
    const res = await pool.query(
      `SELECT DISTINCT mint FROM decision_journal
        WHERE decision = 'ENTRY_APPROVED'
          AND created_at >= NOW() - ($1 || ' milliseconds')::interval
          AND created_at <= NOW()`,
      [String(REHYDRATE_WINDOW_MS)]
    );
    for (const row of res.rows) if (row.mint) mints.add(row.mint);
  } catch (err: any) {
    console.warn('⚠️ [BOOT] Falha ao consultar mints do agente:', err?.message || err);
  }
  return mints;
}

async function rehydratePositionsFromWalletOnBoot() {
  console.log('🔄 [BOOT: Reidratação On-Chain] Verificando contas SPL na carteira Phantom...');
  try {
    const splAccounts = await wallet.getSplTokenAccounts();
    console.log(`📦 [BOOT: Contas SPL Encontradas] ${splAccounts.length} conta(s) com saldo > 0.`);

    // Ignora tokens de infraestrutura base (USDC, USDT, Wrapped SOL)
    const BASE_MINTS = new Set([
      'So11111111111111111111111111111111111111112', // SOL / WSOL
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
      'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'  // USDT
    ]);

    // Só reidrata o que o AGENTE comprou. Adotar qualquer token da carteira
    // criava posições com stop loss sintético (-20%) e PnL inventado sobre
    // resíduos de dumps manuais — o painel passava a "gerir" ativos que o
    // bot nunca comprou.
    const ownedMints = await queryAgentOwnedMints();
    if (ownedMints.size === 0) {
      console.log('ℹ️  [BOOT] Nenhum approval recente no ledger — nenhuma posição a reidratar.');
    } else {
      console.log(`📜 [BOOT] Aprovados no ledger (${REHYDRATE_WINDOW_MS / 3_600_000}h): ${ownedMints.size}`);
    }

    const orphans: Array<{ mint: string; tokenAmount: number }> = [];

    for (const spl of splAccounts) {
      if (BASE_MINTS.has(spl.mint) || spl.tokenAmount <= 0) continue;

      if (!positionEngine.getPosition(spl.mint) && !ownedMints.has(spl.mint)) {
        orphans.push({ mint: spl.mint, tokenAmount: spl.tokenAmount });
        continue;
      }

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
          stopLossPct: -0.06,
          takeProfitPct: 0.35,
          entrySol: 0.015,
          entrySolValue: 0.015,
          entryLiquidityUsd: 15000,
          entryVolume5m: 1000
        });

        console.log(`🛡️ [BOOT: Posição Reidratada e Protegida] ${symbol} (${spl.mint}) | Quantidade: ${spl.tokenAmount.toLocaleString()} | Preço Base: $${price}`);
      }
    }

    if (orphans.length > 0) {
      // Listados em bloco separado: visíveis para o operador, invisíveis para
      // a mesa de operações do bot.
      latestState.walletHoldings = orphans.map((o) => ({
        mint: o.mint,
        symbol: `${o.mint.slice(0, 4)}...${o.mint.slice(-4)}`,
        tokenAmount: o.tokenAmount,
        decimals: 0,
        ataAddress: '',
        solscanUrl: `https://solscan.io/token/${o.mint}`,
        dexScreenerUrl: `https://dexscreener.com/solana/${o.mint}`
      }));
      console.log(`🚫 [BOOT] ${orphans.length} token(í) órfão(ós) IGNORADOS pela mesa de operações:`);
      orphans.forEach((o) => console.log(`   • ${o.mint} (${o.tokenAmount})`));
      console.log(`   Use "npm run token:purge-ci" (ajuste CANARY_MINT) para expurgar.`);
    } else {
      latestState.walletHoldings = [];
    }

    updateDashboardViews();
  } catch (err: any) {
    console.warn(`⚠️ [BOOT: Aviso Reidratação] Erro ao carregar contas SPL:`, err?.message || err);
  }
}

/**
 * 🛡️ REIDRATAÇÃO DA QUARENTENA NO BOOT (Fim da Amnésia pós-Deploy)
 * Carrega todos os tokens com quarentena ativa do PostgreSQL
 * e força o bloqueio preventivo do token 'all/inCat' por 6 horas.
 */
async function rehydrateQuarantineFromDbOnBoot() {
  console.log('🔄 [BOOT: Quarentena On-Chain] Sincronizando tabela de quarentena do Postgres...');
  try {
    // 1. Expurgar o 'all/inCat' imediatamente (6 horas de quarentena forçada)
    const ALL_IN_CAT_MINT = '4vvmFPzhuW2cdfSxtHUfJQCSFFb7zPBXH4neBooipump';
    const sixHoursMs = 6 * 60 * 60 * 1000;
    const catExpiresAt = new Date(Date.now() + sixHoursMs);
    antiSpamMemory.recordVeto(ALL_IN_CAT_MINT, 'Veto Forçado Pós-StopLoss (Expurgado preventivo)', sixHoursMs);

    await postgresRepo.saveQuarantine({
      mint: ALL_IN_CAT_MINT,
      symbol: 'all/inCat',
      reason: 'Veto Forçado Pós-StopLoss (Expurgado preventivo por 6h)',
      expiresAt: catExpiresAt
    });

    // 2. Consulta quarentenas ativas no Postgres
    const activeDbQuarantines = await postgresRepo.getActiveQuarantine();
    if (activeDbQuarantines.length > 0) {
      antiSpamMemory.loadQuarantinedTokens(
        activeDbQuarantines.map(q => ({
          mint: q.mint,
          reason: q.reason,
          expiresAt: q.expiresAt.getTime()
        }))
      );
    }

    const totalQuarantined = antiSpamMemory.getStats().vettedCount;
    latestState.quarantineCount = totalQuarantined;
    console.log(`🛡️ [BOOT: Quarentena Reidratada] ${totalQuarantined} tokens bloqueados carregados do banco.`);
  } catch (err: any) {
    console.warn('⚠️ [BOOT: Aviso Quarentena] Erro ao carregar quarentenas do Postgres:', err?.message || err);
  }
}

async function main() {
  console.log('====================================================');
  console.log('🚀 NEXUS QUANT SOLANA - INICIALIZANDO SERVIÇO 24/7');
  console.log(`🪙 Carteira Phantom Oficial: ${OFFICIAL_PHANTOM_WALLET}`);
  console.log(
    IS_DRY_RUN
      ? '⚠️ [MODO SIMULADO] DRY_RUN ativo. Swaps reais bloqueados.'
      : '🚀 [MODO REAL ON-CHAIN] Jupiter Swap armado para execução real em SOL.'
  );
  console.log(`⏱️ Intervalo de Varredura: ${SCAN_INTERVAL_MS / 1000}s`);
  console.log(`⚡ Ultra-Fast Exit Monitor: ${FAST_EXIT_INTERVAL_MS}ms (DexScreener sensor + Jupiter confirmação)`);
  console.log(`🎯 Modo Sniper: MAX_CONCURRENT_POSITIONS = ${MAX_CONCURRENT_POSITIONS}`);
  console.log(`⚡ RPC Solana Ativa: ${ACTIVE_SOLANA_RPC_URL.split('?')[0]}`);
  console.log('====================================================');

  console.log(`🔑 Keypair Derivado On-Chain: ${wallet.getPublicKey()}`);
  if (wallet.getPublicKey() !== OFFICIAL_PHANTOM_WALLET) {
    console.warn(`⚠️ [ALERTA DE CHAVE] Chave pública derivada (${wallet.getPublicKey()}) diverge da carteira oficial configurada (${OFFICIAL_PHANTOM_WALLET})!`);
  }

  // 0. Inicialização do Decision Journal & Agendamento do Cron Noturno (03:00 UTC)
  await journal.initSchema();
  startCalibrationCron(pgPool);
  runMaintenance(pgPool).catch(() => {});
  setInterval(() => {
    runMaintenance(pgPool).catch(() => {});
  }, 24 * 60 * 60 * 1000);

  // 1. Reidratação da Quarentena do Banco (Fim da Amnésia pós-Deploy)
  await rehydrateQuarantineFromDbOnBoot();

  // 2. Reidratação On-Chain Imediata no Boot (protege ativos já comprados contra restart)
  await rehydratePositionsFromWalletOnBoot();

  // 2.1 Varredura e Resgate Automático de Rent Exemption de Contas Órfãs Vazias
  try {
    const sweep = await rentRecovery.sweepOrphanAccounts();
    if (sweep.closedCount > 0) {
      console.log(`🧹 [BOOT: Higiene On-Chain] ${sweep.closedCount} conta(s) vazia(s) fechada(s). ~${sweep.reclaimedSolEst} SOL devolvidos à carteira!`);
    }
  } catch (err: any) {
    console.warn(`⚠️ [BOOT: Aviso Rent] Falha ao varrer contas órfãs no boot: ${err?.message || err}`);
  }

  // 2.2 Agendamento de Varredura Periódica de Rent a cada 2 horas
  setInterval(() => {
    rentRecovery.sweepOrphanAccounts().catch(() => {});
  }, 2 * 60 * 60 * 1000);

  // 3. Loop Ultra-Rápido Dedicado de Saída a cada 1.500ms (inicia IMEDIATAMENTE)
  setInterval(runUltraFastExitMonitor, FAST_EXIT_INTERVAL_MS);

  // 4. Executa o primeiro ciclo de scanner imediatamente
  await executeAutonomousCycle();

  // 5. Loop Independente de Scanner de Novos Tokens a cada 30s
  setInterval(executeAutonomousCycle, SCAN_INTERVAL_MS);
}

// 🛑 SHUTDOWN GRACIOSO (SIGTERM / SIGINT) — Esvazia o buffer do Decision Journal antes de sair
process.on('SIGTERM', async () => {
  console.log('🛑 [SIGTERM] Encerrando serviço e esvaziando buffer do Decision Journal...');
  await journal.shutdown();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('🛑 [SIGINT] Encerrando serviço e esvaziando buffer do Decision Journal...');
  await journal.shutdown();
  process.exit(0);
});

main().catch(err => {
  console.error('❌ Falha fatal ao inicializar o agente:', err);
  process.exit(1);
});
