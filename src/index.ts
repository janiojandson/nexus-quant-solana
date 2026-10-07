import { buildContractGates } from './audit/contractGates.js';
import { NonBlockingTelemetry } from './protection/nonBlockingTelemetry.js';
import { reportProfitProtectionShadow } from './protection/profitProtectionShadow.js';
import http from 'http';
import dotenv from 'dotenv';
import axios from 'axios';
import { VitalityState, getAgentVitalityState } from './core/vitalityEngine.js';
import { SolanaWalletService } from './blockchain/solanaWallet.js';
import { JupiterExecutionEngine } from './blockchain/jupiterExecutionEngine.js';
import { priorityForJupiterWork } from './blockchain/jupiterPriorityPolicy.js';
import {
  AdaptivePositionSizer,
  MAX_TRADE_AMOUNT_SOL
} from './blockchain/adaptivePositionSizer.js';
import { buildEquitySizingPolicy } from './blockchain/equitySizingPolicy.js';
import { MemeRiskGatekeeper } from './risk/memeRiskGatekeeper.js';
import { DexScreenerScanner } from './scanner/dexScreenerScanner.js';
import { ReproductionEngine } from './lifecycle/reproductionEngine.js';
import { SolanaPostgresRepository } from './database/postgresClient.js';
import { PumpStrategyRepository } from './database/pumpStrategyRepository.js';
import { TokenClassifier, AntiSpamMemory } from './scanner/tokenClassifier.js';
import { CerebroIntegrationService } from './core/cerebroIntegration.js';
import { PositionExitEngine, type PositionTracking } from './execution/positionExitEngine.js';
import { evaluateExitCapacity } from './execution/exitCapacityPolicy.js';
import { ExitPathHealth } from './execution/exitPathHealth.js';
import { buildWatchdogExitPlan } from './execution/watchdogExitPolicy.js';
import { ExitRouter, type RoutedExitAttempt } from './execution/exitRouter.js';
import { PumpSellExecutor } from './pump/pumpSellExecutor.js';
import { renderDashboardHtml, DashboardState } from './dashboard/dashboardRenderer.js';
import { handleApiRoutes } from './server/routes.js';
import { RentRecoveryService } from './services/rentRecoveryService.js';
import { randomUUID } from 'crypto';
import { DecisionLogger, DecisionType, GateEvaluation } from './database/decisionJournal.js';
import { startCalibrationCron, runCalibrationNow } from './calibration/calibrationCron.js';
import { runMaintenance } from './database/maintenanceJob.js';
import { DailyPnlTracker } from './risk/dailyPnlTracker.js';
import { assertAtomicAmountToNumber, assertStoredAtomicNumberToNumber } from './execution/atomicAmount.js';
import { observeEntryMomentum, DEFAULT_ENTRY_MOMENTUM_CONFIG } from './execution/entryMomentumGate.js';
import { SolanaLayaAdapter, normalizeSolanaLayaTacticalMode } from './risk/solanaLayaAdapter.js';
import { SolanaAdminAuthService } from './auth/adminAuthService.js';
import { PumpObservatory, type PumpRpc } from './pump/pumpObservatory.js';
import { PumpDexTimingTracker } from './pump/pumpDexTiming.js';
import { PumpDexTimingRuntime } from './pump/pumpDexTimingRuntime.js';
import { PumpStrategyLabRuntime } from './pump/pumpStrategyLabRuntime.js';
import { SentinelHandoffScanner, type SentinelHandoffToken, type SentinelCrossMemoryResult } from './scanner/sentinelHandoffScanner.js';
import { BUY_AMOUNT_SOL } from './config/env.js';
import { scheduleEntryAdvisory } from './execution/entryAdvisory.js';
import { referencesProgram } from './execution/entryRoutePolicy.js';
import { PUMP_PROGRAM_ID } from './pump/pumpBondingCurve.js';


dotenv.config();

const OFFICIAL_PHANTOM_WALLET = process.env.AGENT_SOLANA_PUBLIC_KEY || 'FBx2SKLDLsdeLM8owxU8MNVPKAfJpLpmpHHRgiZDqBoi';
const SECRET_KEY_RAW = process.env.AGENT_SOLANA_PRIVATE_KEY || '[]';
const IS_DRY_RUN = process.env.DRY_RUN_MODE === 'false' ? false : true; // SIMULADOR POR PADRÃO (DRY-RUN 🟢)
const SCAN_INTERVAL_MS = parseInt(process.env.SCAN_INTERVAL_MS || '30000', 10);
const FAST_EXIT_INTERVAL_MS = 1500; // 1.5 segundos para Ultra-Fast Exit Monitor
const JUPITER_GENERAL_RPS = Math.max(0.1, Number(process.env.JUPITER_GENERAL_RPS || 1));
const MAX_CONCURRENT_POSITIONS = 2; // Permite operar até 2 posições simultâneas
const ENTRY_EQUITY_PCT = Math.min(0.25, Math.max(0.01, Number(process.env.ENTRY_EQUITY_PCT || 0.10)));
const MAX_TOTAL_ALLOCATION_PCT = Math.min(0.50, Math.max(ENTRY_EQUITY_PCT, Number(process.env.MAX_TOTAL_ALLOCATION_PCT || 0.20)));
const MIN_EXECUTABLE_ENTRY_SOL = Math.max(0.0001, Number(process.env.MIN_EXECUTABLE_ENTRY_SOL || 0.001));
const GAS_RESERVE_EQUITY_PCT = Math.min(0.25, Math.max(0, Number(process.env.GAS_RESERVE_EQUITY_PCT || 0.10)));
const MIN_GAS_RESERVE_SOL = Math.max(0, Number(process.env.MIN_GAS_RESERVE_SOL || 0.01));
const MAX_GAS_RESERVE_SOL = Math.max(MIN_GAS_RESERVE_SOL, Number(process.env.MAX_GAS_RESERVE_SOL || 0.05));
const MAX_TOTAL_ALLOCATION_SOL = Math.max(MAX_TRADE_AMOUNT_SOL, Number(process.env.MAX_TOTAL_ALLOCATION_SOL || 0.10));
const PORT = Number(process.env.PORT) || 3009;
const MACRO_SENTINEL_URL = process.env.MACRO_SENTINEL_URL || process.env.MACRO_SENTINEL_PUBLIC_URL || 'http://nexus-macro-sentinel.railway.internal:4005';
const ACTIVE_SOLANA_RPC_URL = process.env.HELIUS_RPC_URL || process.env.QUICKNODE_RPC_URL || process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const ENTRY_MOMENTUM_GATE_ENABLED = process.env.ENTRY_MOMENTUM_GATE_ENABLED === 'true';
const ENTRY_MOMENTUM_SAMPLES = Math.max(3, Number(process.env.ENTRY_MOMENTUM_SAMPLES || DEFAULT_ENTRY_MOMENTUM_CONFIG.samples));
const ENTRY_MOMENTUM_INTERVAL_MS = Math.max(250, Number(process.env.ENTRY_MOMENTUM_INTERVAL_MS || DEFAULT_ENTRY_MOMENTUM_CONFIG.intervalMs));
const ENTRY_MOMENTUM_MIN_RISE_PCT = Number(process.env.ENTRY_MOMENTUM_MIN_RISE_PCT || DEFAULT_ENTRY_MOMENTUM_CONFIG.minRisePct);
const ENTRY_MOMENTUM_MAX_RISE_PCT = Number(process.env.ENTRY_MOMENTUM_MAX_RISE_PCT || DEFAULT_ENTRY_MOMENTUM_CONFIG.maxRisePct);
const ENTRY_MOMENTUM_MAX_PULLBACK_PCT = Number(process.env.ENTRY_MOMENTUM_MAX_PULLBACK_PCT || DEFAULT_ENTRY_MOMENTUM_CONFIG.maxPullbackPct);

const SOLANA_LAYA_TACTICAL_MODE =
  normalizeSolanaLayaTacticalMode(process.env.SOLANA_LAYA_TACTICAL_MODE);
const SOLANA_LAYA_POSITION_INTERVAL_MS = Math.max(5_000, Number(process.env.SOLANA_LAYA_POSITION_INTERVAL_MS || 10_000));
const AUTO_RENT_RECOVERY_ENABLED = process.env.AUTO_RENT_RECOVERY_ENABLED === 'true';
const AUTO_RENT_RECOVERY_INTERVAL_MS = Math.max(5 * 60_000, Number(process.env.AUTO_RENT_RECOVERY_INTERVAL_MS || 30 * 60_000));
const NEXUS_MAINTENANCE_MODE = process.env.NEXUS_MAINTENANCE_MODE === 'true';
const PUMP_DIRECT_SELL_FALLBACK_ENABLED =
  process.env.PUMP_DIRECT_SELL_FALLBACK_ENABLED === 'true';
const PUMP_OBSERVATORY_ENABLED = process.env.PUMP_OBSERVATORY_ENABLED === 'true';
const PUMP_OBSERVATORY_REFRESH_MS = Math.max(
  5_000,
  Number(process.env.PUMP_OBSERVATORY_REFRESH_MS || 15_000)
);
const PUMP_OBSERVATORY_BATCH_SIZE = Math.max(
  1,
  Math.min(100, Number(process.env.PUMP_OBSERVATORY_BATCH_SIZE || 50))
);
const PUMP_DEX_TIMING_INTERVAL_MS = Math.max(
  2_000,
  Number(process.env.PUMP_DEX_TIMING_INTERVAL_MS || 5_000)
);
const PUMP_DEX_TIMING_BATCH_SIZE = Math.max(
  1,
  Math.min(30, Number(process.env.PUMP_DEX_TIMING_BATCH_SIZE || 30))
);
const PUMP_DEX_TIMING_MAX_AGE_MS = Math.max(
  60_000,
  Number(process.env.PUMP_DEX_TIMING_MAX_AGE_MS || 15 * 60_000)
);
const PUMP_STRATEGY_LAB_ENABLED = process.env.PUMP_STRATEGY_LAB_ENABLED !== 'false';
const PUMP_STRATEGY_LAB_INTERVAL_MS = Math.max(
  2_000,
  Number(process.env.PUMP_STRATEGY_LAB_INTERVAL_MS || 5_000)
);
const PUMP_STRATEGY_SHADOW_ENTRY_LAMPORTS = Math.max(
  10_000,
  Math.floor(Number(process.env.PUMP_STRATEGY_SHADOW_ENTRY_LAMPORTS || 1_000_000))
);
const PUMP_STRATEGY_NETWORK_FEE_LAMPORTS = Math.max(
  0,
  Math.floor(Number(process.env.PUMP_STRATEGY_NETWORK_FEE_LAMPORTS || 5_000))
);
const PUMP_STRATEGY_PRIORITY_FEE_LAMPORTS = Math.max(
  0,
  Math.floor(Number(process.env.PUMP_STRATEGY_PRIORITY_FEE_LAMPORTS || 0))
);

let isRunningScanner = false;
let isRunningFastExit = false;
let pumpStateSyncTimer: ReturnType<typeof setInterval> | null = null;
const antiSpamMemory = new AntiSpamMemory(60); // Padrão 60 minutos
const positionEngine = new PositionExitEngine();
console.log('[RISK_POLICY] initialStopLossPct=' + PositionExitEngine.DEFAULT_STOP_LOSS_PCT + ' gateEvidenceVersion=2');
const exitPathHealth = new ExitPathHealth({
  emergencyFailures: PositionExitEngine.WATCHDOG_EMERGENCY_FAILURES
});

const CANDIDATE_RPC_URLS: string[] = [];
if (process.env.HELIUS_RPC_URL) CANDIDATE_RPC_URLS.push(process.env.HELIUS_RPC_URL);
if (process.env.HELIUS_API_KEYS) {
  const keys = process.env.HELIUS_API_KEYS.split(/[,\s]+/).map(k => k.trim()).filter(Boolean);
  for (const k of keys) {
    CANDIDATE_RPC_URLS.push(`https://mainnet.helius-rpc.com/?api-key=${k}`);
  }
}
if (process.env.QUICKNODE_RPC_URL) CANDIDATE_RPC_URLS.push(process.env.QUICKNODE_RPC_URL);
if (process.env.SOLANA_RPC_URL) CANDIDATE_RPC_URLS.push(process.env.SOLANA_RPC_URL);
CANDIDATE_RPC_URLS.push('https://api.mainnet-beta.solana.com');

// Instâncias Globais dos Serviços Operacionais
const wallet = new SolanaWalletService({
  secretKeyRaw: SECRET_KEY_RAW,
  rpcUrl: ACTIVE_SOLANA_RPC_URL,
  rpcUrls: CANDIDATE_RPC_URLS
});

const rentRecovery = new RentRecoveryService(wallet.getConnection(), wallet.getKeypair());
const pumpObservatory = new PumpObservatory(
  wallet.getConnection() as unknown as PumpRpc,
  {
    enabled: PUMP_OBSERVATORY_ENABLED,
    refreshIntervalMs: PUMP_OBSERVATORY_REFRESH_MS,
    refreshBatchSize: PUMP_OBSERVATORY_BATCH_SIZE,
    maxRecent: 200
  }
);
const pumpDexTimingTracker = new PumpDexTimingTracker(pumpObservatory, {
  batchSize: PUMP_DEX_TIMING_BATCH_SIZE,
  maxAgeMs: PUMP_DEX_TIMING_MAX_AGE_MS
});
const pumpDexTimingRuntime = new PumpDexTimingRuntime(pumpDexTimingTracker, {
  enabled: PUMP_OBSERVATORY_ENABLED,
  intervalMs: PUMP_DEX_TIMING_INTERVAL_MS
});

const scanner = new DexScreenerScanner();
const exitTelemetry = new NonBlockingTelemetry<Awaited<ReturnType<typeof scanner.fetchCurrentTokenMarketSnapshot>>>();
// DEX e Sentinel agendam advisory separadamente; shadow nativo não atrasa os hard gates.
const entryGatekeeper = new MemeRiskGatekeeper({
  macroSentinelUrl: MACRO_SENTINEL_URL,
  layaNativeShadowEnabled: false
});
const solanaLayaAdapter = new SolanaLayaAdapter();
const layaPositionLastCheck = new Map<string, number>();
const layaPositionInFlight = new Set<string>();
/** Serializa qualquer liquidação por mint, independentemente da origem (hard gate, Laya ou manual). */
const exitOrderInFlight = new Set<string>();
/** Mints cujo /execute V2 ficou inconclusivo: bloqueia nova ordem até reinício/reconciliação. */
const uncertainExitMints = new Set<string>();
/** Circuit breaker em memória: impede novas entradas após uma execução V2 inconclusiva. */
let executionUncertainReason: string | null = null;

const jupiterEngine = new JupiterExecutionEngine({
  rpcUrl: ACTIVE_SOLANA_RPC_URL,
  isDryRun: IS_DRY_RUN
});

const pumpSellExecutor = new PumpSellExecutor(
  wallet.getConnection() as any,
  {
    reconcileRecentSell: async (mintAddress, sinceTimestampMs, expectedAmountAtomic) => {
      const found = await wallet.findRecentTokenDeltaTransaction(
        mintAddress,
        sinceTimestampMs,
        'OUT'
      );
      if (!found) return null;
      const soldAtomic = BigInt(found.deltaAtomic) < 0n
        ? -BigInt(found.deltaAtomic)
        : BigInt(found.deltaAtomic);
      if (soldAtomic < (expectedAmountAtomic * 99n) / 100n) return null;
      const grossReceivedLamports = found.walletLamportDelta + found.feeLamports;
      return {
        signature: found.signature,
        soldAtomic,
        receivedLamports: grossReceivedLamports > 0
          ? BigInt(grossReceivedLamports)
          : undefined
      };
    }
  }
);
const exitRouter = new ExitRouter({
  pumpFallbackEnabled: PUMP_DIRECT_SELL_FALLBACK_ENABLED
});

async function reconcileUncertainV2Execution(
  mint: string,
  sinceTimestampMs: number,
  direction: 'IN' | 'OUT',
  attempts = 4
) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const found = await wallet.findRecentTokenDeltaTransaction(
      mint,
      sinceTimestampMs,
      direction
    );
    if (found) return found;
    if (attempt < attempts - 1) {
      await new Promise(resolve => setTimeout(resolve, 1_500));
    }
  }
  return null;
}

const reproduction = new ReproductionEngine();
const adaptiveSizer = new AdaptivePositionSizer(jupiterEngine.getAggregator());
const postgresRepo = new SolanaPostgresRepository();
const pgPool = postgresRepo.getPool();
const pumpStrategyRepository = new PumpStrategyRepository(pgPool as any);
let latestShadowEntryLadderLamports = [PUMP_STRATEGY_SHADOW_ENTRY_LAMPORTS];
const pumpStrategyLabRuntime = new PumpStrategyLabRuntime(
  pumpObservatory,
  jupiterEngine.getAggregator(),
  pumpStrategyRepository,
  {
    enabled: PUMP_OBSERVATORY_ENABLED && PUMP_STRATEGY_LAB_ENABLED,
    intervalMs: PUMP_STRATEGY_LAB_INTERVAL_MS,
    entryLamports: PUMP_STRATEGY_SHADOW_ENTRY_LAMPORTS,
    entryLamportLadder: () => latestShadowEntryLadderLamports,
    networkFeeLamports: PUMP_STRATEGY_NETWORK_FEE_LAMPORTS,
    priorityFeeLamports: PUMP_STRATEGY_PRIORITY_FEE_LAMPORTS,
    canRunResearch: () => {
      if (!exitPathHealth.snapshot().canRunResearch) return false;
      // No Free, capital exposto tem prioridade total sobre pesquisa P6.
      if (JUPITER_GENERAL_RPS <= 1 && positionEngine.getAllPositions().length > 0) return false;
      return true;
    }
  }
);
const adminAuthService = new SolanaAdminAuthService(pgPool);
const sentinelHandoffScanner = new SentinelHandoffScanner(pgPool);
const journal = new DecisionLogger(pgPool, {
  flushIntervalMs: 5000,
  maxBufferSize: 100
});

// Watermark persistente do trailing: grava de forma assíncrona e limitada para
// não bloquear o loop de saída nem gerar write storm durante uma alta contínua.
const persistedPeakState = new Map<string, { value: number; at: number }>();
function persistPeakWatermark(
  pos: PositionTracking,
  peakSolValue: number,
  resetForReducedPosition = false
): void {
  if (!pgPool || !pos.traceId || !Number.isFinite(peakSolValue) || peakSolValue <= 0) return;

  const now = Date.now();
  const previous = persistedPeakState.get(pos.mint);
  const advancedEnough = !previous || peakSolValue >= previous.value * 1.02;
  const staleEnough = !previous || (now - previous.at) >= 15_000;
  if (!resetForReducedPosition && !advancedEnough && !staleEnough) return;

  persistedPeakState.set(pos.mint, { value: peakSolValue, at: now });
  const peakExpression = resetForReducedPosition
    ? '$1'
    : 'GREATEST(COALESCE(peak_sol_value, 0), $1)';
  const executableExpression = resetForReducedPosition
    ? '$1'
    : 'GREATEST(COALESCE(executable_peak_sol_value, peak_sol_value, 0), $1)';
  const observablePeakSolValue = Number(pos.observablePeakSolValue || peakSolValue);
  const observableExpression = resetForReducedPosition
    ? '$3'
    : 'GREATEST(COALESCE(observable_peak_sol_value, 0), $3)';
  const lastJupiterExecutableSolValue = Number.isFinite(Number(pos.lastJupiterExecutableSolValue))
    ? Number(pos.lastJupiterExecutableSolValue)
    : null;
  const lastHealthyExitRouteAt = Number.isFinite(Number(pos.lastHealthyExitRouteAt))
    ? Number(pos.lastHealthyExitRouteAt)
    : null;

  void pgPool.query(
    `UPDATE trade_outcomes
       SET peak_sol_value = ${peakExpression},
           executable_peak_sol_value = ${executableExpression},
           observable_peak_sol_value = ${observableExpression},
           last_jupiter_executable_sol_value = COALESCE($4, last_jupiter_executable_sol_value),
           last_healthy_exit_route_at = CASE
             WHEN $5::BIGINT IS NULL THEN last_healthy_exit_route_at
             ELSE to_timestamp($5::DOUBLE PRECISION / 1000.0)
           END,
           peak_updated_at = now()
     WHERE trace_id = $2
       AND status IN ('OPEN', 'PARTIAL_CLOSED')`,
    [peakSolValue, pos.traceId, observablePeakSolValue, lastJupiterExecutableSolValue, lastHealthyExitRouteAt]
  ).catch((err: any) => {
    console.warn(`⚠️ [TRAILING:Persistência] ${pos.symbol}: falha ao persistir pico: ${err?.message || err}`);
  });
}

const cerebroService = new CerebroIntegrationService();
const dailyPnlTracker = new DailyPnlTracker();

// Estado compartilhado em memória para o Dashboard
const latestState: DashboardState = {
  agent: 'NEXUS_QUANT_SOLANA_V1',
  wallet: OFFICIAL_PHANTOM_WALLET,
  balanceSol: 0,
  initialDepositSol: 0.3133,
  vitalityState: 'NORMAL',
  dryRun: IS_DRY_RUN,
  maintenanceMode: NEXUS_MAINTENANCE_MODE,
  macroRegime: 'NEUTRAL_RANGING',
  circuitBreakerActive: false,
  activeRpcUrl: ACTIVE_SOLANA_RPC_URL.split('?')[0],
  totalRealizedPnlSol: 0,
  totalNetworkFeesSolEst: 0,
  auth: { configured: Boolean(pgPool), needsBootstrap: true },
  rentRecovery: {
    autoEnabled: AUTO_RENT_RECOVERY_ENABLED,
    intervalMs: AUTO_RENT_RECOVERY_INTERVAL_MS,
    inFlight: false,
    lastClosedCount: 0,
    lastReclaimedSolEst: 0,
    lastReclaimedSolActual: 0,
    totalClosedCount: 0,
    totalReclaimedSolEst: 0,
    totalReclaimedSolActual: 0,
    lastErrors: []
  },
  laya: {
    tacticalMode: SOLANA_LAYA_TACTICAL_MODE,
    privateService: process.env.SOLANA_LAYA_PRIVATE_PROXY === 'true',
    health: 'UNKNOWN',
    loaded: []
  },
  positions: [],
  walletHoldings: [],
  closedTrades: [],
  recentAudits: [],
  quarantineCount: 0,
  incubator: { waiting: 0, mature: 0, technicalDiscards: 0, entryEligible: 0 },
  pumpObservatory: pumpObservatory.snapshot(),
  pumpStrategyLab: pumpStrategyLabRuntime.snapshot(),
  pumpDirectSellFallback: {
    enabled: PUMP_DIRECT_SELL_FALLBACK_ENABLED,
    selectedPath: 'NONE',
    confirmationState: 'IDLE',
    estimatedCostSol: null,
    fallbackReason: null
  },
  exitCapacity: evaluateExitCapacity({
    generalRps: JUPITER_GENERAL_RPS,
    monitorIntervalMs: FAST_EXIT_INTERVAL_MS,
    openPositions: 1,
    hasLocalExitSensor: false
  }),
  exitPathHealth: exitPathHealth.snapshot(),
  lastUpdated: new Date().toISOString()
};

void adminAuthService.initSchema()
  .then(async () => {
    await adminAuthService.bootstrapAdministratorFromEnvironment();
    const authStatus = await adminAuthService.getStatus();
    latestState.auth = {
      configured: authStatus.configured,
      needsBootstrap: authStatus.needsBootstrap
    };
    console.log(
      `🔐 [AdminAuth] configured=${authStatus.configured} needsBootstrap=${authStatus.needsBootstrap}`
    );
  })
  .catch((err: any) => {
    latestState.auth = { configured: false, needsBootstrap: false };
    console.warn(`⚠️ [AdminAuth] inicialização falhou: ${err?.message || err}`);
  });

async function refreshLayaHealth(): Promise<void> {
  try {
    const health = await solanaLayaAdapter.checkHealth();
    latestState.laya = {
      tacticalMode: SOLANA_LAYA_TACTICAL_MODE,
      privateService: process.env.SOLANA_LAYA_PRIVATE_PROXY === 'true',
      health: health.ok ? 'OK' : 'DEGRADED',
      loaded: health.loaded,
      latencyMs: health.latencyMs,
      lastCheckedAt: new Date().toISOString()
    };
    console.log(
      `🧠 [Laya:Health] ok=${health.ok} loaded=${health.loaded.join(',') || 'none'} latencyMs=${health.latencyMs}`
    );
  } catch (err: any) {
    if (latestState.laya) {
      latestState.laya.health = 'DEGRADED';
      latestState.laya.lastCheckedAt = new Date().toISOString();
    }
    console.warn(`⚠️ [Laya:Health] probe falhou: ${err?.message || err}`);
  }
}

void refreshLayaHealth();
setInterval(() => {
  void refreshLayaHealth();
}, 60_000);

let rentRecoverySweepInFlight = false;
async function runRentRecoverySweep(source: 'AUTO' | 'MANUAL'): Promise<Awaited<ReturnType<RentRecoveryService['sweepOrphanAccounts']>>> {
  if (rentRecoverySweepInFlight) {
    throw new Error('Varredura de rent já está em execução.');
  }
  if (source === 'AUTO' && (!AUTO_RENT_RECOVERY_ENABLED || IS_DRY_RUN)) {
    return {
      closedCount: 0,
      reclaimedSolEst: 0,
      reclaimedSolActual: 0,
      txSignatures: [],
      errors: []
    };
  }

  rentRecoverySweepInFlight = true;
  if (latestState.rentRecovery) latestState.rentRecovery.inFlight = true;

  try {
    const result = await rentRecovery.sweepOrphanAccounts();
    if (latestState.rentRecovery) {
      latestState.rentRecovery.lastRunAt = new Date().toISOString();
      latestState.rentRecovery.lastClosedCount = result.closedCount;
      latestState.rentRecovery.lastReclaimedSolEst = result.reclaimedSolEst;
      latestState.rentRecovery.lastReclaimedSolActual = result.reclaimedSolActual;
      latestState.rentRecovery.totalClosedCount += result.closedCount;
      latestState.rentRecovery.totalReclaimedSolEst = Number(
        (latestState.rentRecovery.totalReclaimedSolEst + result.reclaimedSolEst).toFixed(9)
      );
      latestState.rentRecovery.totalReclaimedSolActual = Number(
        (latestState.rentRecovery.totalReclaimedSolActual + result.reclaimedSolActual).toFixed(9)
      );
      latestState.rentRecovery.lastErrors = result.errors.slice(-10);
    }
    if (result.closedCount > 0 || result.errors.length > 0) {
      console.log(
        `🧹 [RentRecovery:${source}] fechadas=${result.closedCount} ` +
        `rentReal=${result.reclaimedSolActual.toFixed(9)} SOL erros=${result.errors.length}`
      );
    }
    return result;
  } finally {
    rentRecoverySweepInFlight = false;
    if (latestState.rentRecovery) latestState.rentRecovery.inFlight = false;
  }
}

if (AUTO_RENT_RECOVERY_ENABLED && !IS_DRY_RUN && !NEXUS_MAINTENANCE_MODE) {
  const firstSweepDelayMs = Math.min(60_000, Math.max(15_000, Math.floor(AUTO_RENT_RECOVERY_INTERVAL_MS / 4)));
  setTimeout(() => {
    void runRentRecoverySweep('AUTO').catch((err: any) => {
      console.warn(`⚠️ [RentRecovery:AUTO] sweep inicial falhou: ${err?.message || err}`);
    });
  }, firstSweepDelayMs);
  setInterval(() => {
    void runRentRecoverySweep('AUTO').catch((err: any) => {
      console.warn(`⚠️ [RentRecovery:AUTO] sweep agendado falhou: ${err?.message || err}`);
    });
  }, AUTO_RENT_RECOVERY_INTERVAL_MS);
  console.log(`🧹 [RentRecovery:AUTO] habilitado a cada ${Math.round(AUTO_RENT_RECOVERY_INTERVAL_MS / 60000)} min.`);
} else {
  console.log(
    `🧹 [RentRecovery:AUTO] desabilitado (config=${AUTO_RENT_RECOVERY_ENABLED}, dryRun=${IS_DRY_RUN}, maintenance=${NEXUS_MAINTENANCE_MODE}).`
  );
}

/**
 * Executa o encerramento seguro e imediato de uma posição aberta:
 * 1. Swap Jupiter Token -> SOL
 * 2. Fechamento de Associated Token Account (Rent Exemption: ~0.00204 SOL de volta)
 * 3. Quarentena severa de 24 horas no AntiSpamMemory se for STOP_LOSS ou MANUAL
 * 4. Registro no histórico de trades fechados e atualização no Dashboard
 */
type ExitOrderReason = 'TAKE_PROFIT' | 'PARTIAL_TAKE_PROFIT_50' | 'STOP_LOSS' | 'TRAILING_STOP' | 'TIME_STOP' | 'MANUAL' | 'LAYA_EXIT' | 'WATCHDOG_EXIT';
type ExitOrderOptions = {
  exitTokenAmount?: number;
  shouldCloseAta?: boolean;
  trafficPriority?: ReturnType<typeof priorityForJupiterWork>;
  initialSlippageBps?: number;
};
type ExitOrderResult = { success: boolean; txSignature?: string; error?: string };

async function executeExitOrder(
  mint: string,
  exitReason: ExitOrderReason,
  pnlPct: number,
  exitSolValue: number,
  options?: ExitOrderOptions
): Promise<ExitOrderResult> {
  if (uncertainExitMints.has(mint)) {
    return {
      success: false,
      error: `V2_EXECUTION_UNCERTAIN:${mint}: nova saída bloqueada até reconciliação/restart seguro`
    };
  }
  if (exitOrderInFlight.has(mint)) {
    return { success: false, error: `EXIT_ALREADY_IN_FLIGHT:${mint}` };
  }
  exitOrderInFlight.add(mint);
  try {
    return await executeExitOrderUnlocked(mint, exitReason, pnlPct, exitSolValue, options);
  } finally {
    exitOrderInFlight.delete(mint);
  }
}

async function executeExitOrderUnlocked(
  mint: string,
  exitReason: ExitOrderReason,
  pnlPct: number,
  exitSolValue: number,
  options?: ExitOrderOptions
): Promise<ExitOrderResult> {
  const pos = positionEngine.getPosition(mint);
  if (!pos) {
    return { success: false, error: 'Posição não encontrada no Gestor' };
  }

  const tokenAmountToSell = options?.exitTokenAmount || pos.tokenAmount;
  const isPartial = exitReason === 'PARTIAL_TAKE_PROFIT_50';
  const shouldCloseAta = options?.shouldCloseAta ?? !isPartial;
  const trafficPriority = options?.trafficPriority ?? priorityForJupiterWork('PROTECTIVE_EXIT');
  const initialSlippageBps = Math.min(750, Math.max(250, options?.initialSlippageBps ?? 500));

  // Validação atômica ANTES de qualquer cotação. `tokenAmount` vem de
  // `swapSim.outAmount` (inteiro do Jupiter), mas um refactor futuro poderia
  // trocar a origem por uiAmount sem quebrar nenhum teste — e o swap passaria
  // a vender 5 lamports em vez de milhões, deixando a posição presa na carteira.
  let exitAmountAtomic: number;
  try {
    exitAmountAtomic = assertStoredAtomicNumberToNumber(tokenAmountToSell);
  } catch (err: any) {
    console.error(`🛑 [PositionExit] ${pos.symbol}: ${err.message}`);
    latestState.recentAudits[0] = {
      ...latestState.recentAudits[0],
      swapFailReason: `Montante de saida invalido: ${err.message}`
    } as any;
    return { success: false, error: err.message };
  }

  // Saídas manuais chegam pela API sem um valor econômico pré-calculado.
  // Antes do broadcast, obtém uma quote executável para registrar PnL/valor reais
  // e evitar fechar o ledger com pnl=0 e exit_size_sol=0.
  if (exitReason === 'MANUAL' || !Number.isFinite(exitSolValue) || exitSolValue <= 0) {
    try {
      const manualQuote = await jupiterEngine.getQuote(
        pos.mint,
        'So11111111111111111111111111111111111111112',
        exitAmountAtomic,
        initialSlippageBps,
        trafficPriority
      );
      const quotedSolValue = (manualQuote.outAmount || 0) / 1e9;
      if (!Number.isFinite(quotedSolValue) || quotedSolValue <= 0) {
        return { success: false, error: 'Quote Jupiter inválida para liquidação manual.' };
      }
      exitSolValue = quotedSolValue;
      const effectiveEntrySol = pos.entrySol || 0.015;
      pnlPct = (exitSolValue - effectiveEntrySol) / effectiveEntrySol;
      console.log(
        `🎯 [SAÍDA MANUAL COTADA] ${pos.symbol} | valor executável=${exitSolValue.toFixed(9)} SOL ` +
        `| PnL=${(pnlPct * 100).toFixed(2)}%`
      );
    } catch (err: any) {
      const reason = err?.message || String(err);
      if (!exitRouter.isPumpFallbackEnabled()) {
        console.error(`🚫 [SAÍDA MANUAL SEM QUOTE] ${pos.symbol}: ${reason}`);
        return { success: false, error: `Falha ao cotar saída manual: ${reason}` };
      }
      // Com fallback Pump explicitamente armado, a ausência de quote Jupiter
      // não impede a tentativa de saída. O valor contábil será substituído pelo
      // resultado da rota confirmada; jamais usamos este placeholder como lucro.
      exitSolValue = pos.entrySol || 0.015;
      pnlPct = 0;
      console.warn(
        `⚠️ [SAÍDA MANUAL SEM QUOTE JUPITER] ${pos.symbol}: ${reason} | ` +
        'seguindo para ExitRouter com Pump SELL fallback elegível.'
      );
    }
  }

  console.log(`🚨 [EXECUÇÃO DE SAÍDA ON-CHAIN] ${pos.symbol} (${pos.mint}) | Motivo: ${exitReason} | Lote: ${exitAmountAtomic} (atomic) | PnL: ${(pnlPct * 100).toFixed(2)}%`);
  console.log(`⚡ [Jupiter Swap V2] Saída com slippage ${initialSlippageBps}bps e landing gerenciado...`);

  // 1. Swap Jupiter V2 — /order + assinatura local + /execute gerenciado
  const exitAttemptStartedAt = Date.now();
  let exitSwap: RoutedExitAttempt = await jupiterEngine.executeSwap({
    inputMint: pos.mint,
    outputMint: 'So11111111111111111111111111111111111111112', // SOL
    amountLamports: exitAmountAtomic,
    userPublicKey: OFFICIAL_PHANTOM_WALLET,
    keypair: wallet.getKeypair(),
    slippageBps: initialSlippageBps,
    priorityLevel: 'high',
    trafficPriority
  });

  // Segunda tentativa ainda fail-closed: amplia até o hard-cap de 7,5%,
  // mas continua simulando antes de transmitir. Não existe mais envio cego com
  // skipPreflight, evitando pagar taxa por uma falha que a simulação detectaria.
  if (exitSwap.status === 'FAILED') {
    console.warn(`⚠️ [TENTATIVA 1 FALHOU DEFINITIVAMENTE] ${pos.symbol}: ${exitSwap.error} | Tentando nova ordem com slippage 750bps...`);

    exitSwap = await jupiterEngine.executeSwap({
      inputMint: pos.mint,
      outputMint: 'So11111111111111111111111111111111111111112',
      amountLamports: exitAmountAtomic,
      userPublicKey: OFFICIAL_PHANTOM_WALLET,
      keypair: wallet.getKeypair(),
      slippageBps: 750,
      priorityLevel: 'veryHigh',
      skipPreflight: false,
      trafficPriority
    });

    if (exitSwap.status === 'SUCCESS' || exitSwap.status === 'DRY_RUN_SUCCESS') {
      console.log(`✅ [TENTATIVA 2 SUCESSO] ${pos.symbol}: Liquidação V2 confirmada com slippage 750bps`);
    }
  }

  if (exitSwap.status === 'SUBMITTED_UNCONFIRMED') {
    console.warn(
      `⚠️ [Jupiter V2: RECONCILIAÇÃO] ${pos.symbol}: resposta /execute inconclusiva; ` +
      'procurando delta confirmado na wallet antes de qualquer nova ordem.'
    );
    const reconciled = await reconcileUncertainV2Execution(
      pos.mint,
      exitAttemptStartedAt,
      'OUT'
    );

    if (reconciled) {
      const soldAtomic = Math.abs(Number(BigInt(reconciled.deltaAtomic)));
      if (Number.isSafeInteger(soldAtomic) && soldAtomic >= Math.floor(exitAmountAtomic * 0.99)) {
        const grossSolLamports = reconciled.walletLamportDelta + reconciled.feeLamports;
        exitSwap = {
          ...exitSwap,
          status: 'SUCCESS',
          txSignature: reconciled.signature,
          inAmount: soldAtomic,
          outAmount: grossSolLamports > 0
            ? grossSolLamports
            : Math.max(1, Math.round(exitSolValue * 1e9)),
          error: undefined
        };
        uncertainExitMints.delete(pos.mint);
        console.log(
          `✅ [Jupiter V2: RECONCILIADO ON-CHAIN] ${pos.symbol} | tx=${reconciled.signature} ` +
          `| vendido=${soldAtomic} atomic`
        );
      }
    }

    if (exitSwap.status === 'SUBMITTED_UNCONFIRMED') {
      uncertainExitMints.add(pos.mint);
      executionUncertainReason =
        `Saída V2 inconclusiva em ${pos.symbol} (${pos.mint}); novas entradas suspensas.`;
      console.error(
        `🛑 [Jupiter V2: ESTADO INCERTO] ${pos.symbol}: não foi possível reconciliar on-chain. ` +
        'Nova saída deste mint e novas entradas ficam BLOQUEADAS para evitar duplicidade.'
      );
    }
  }

  let selectedExitPath: 'JUPITER' | 'PUMP_DIRECT' = 'JUPITER';
  const jupiterFallbackReason = exitSwap.status === 'FAILED'
    ? (exitSwap.error || 'Jupiter exit failed definitively')
    : null;
  latestState.pumpDirectSellFallback = {
    enabled: PUMP_DIRECT_SELL_FALLBACK_ENABLED,
    selectedPath: 'JUPITER',
    confirmationState: 'PENDING',
    estimatedCostSol: null,
    fallbackReason: jupiterFallbackReason
  };
  const routedExit = await exitRouter.routeAfterJupiter(
    exitSwap,
    async (): Promise<RoutedExitAttempt> => {
      console.warn(
        `🛟 [ExitRouter] Jupiter falhou definitivamente para ${pos.symbol}; ` +
        'avaliando Pump sell_v2 direto (SELL-only).'
      );

      if (IS_DRY_RUN) {
        const simulated = await pumpSellExecutor.simulateSell({
          mint: new (await import('@solana/web3.js')).PublicKey(pos.mint),
          userKeypair: wallet.getKeypair(),
          tokenAmountAtomic: BigInt(exitAmountAtomic),
          slippageBps: 750
        });
        if (!simulated.success || !simulated.built) {
          return {
            status: 'FAILED',
            txSignature: '',
            inAmount: exitAmountAtomic,
            outAmount: 0,
            error: simulated.error || 'Pump direct sell simulation failed.'
          };
        }
        return {
          status: 'DRY_RUN_SUCCESS',
          txSignature: `dry_run_pump_sell_${Date.now()}`,
          inAmount: exitAmountAtomic,
          outAmount: Number(simulated.built.quote.netSolLamports)
        };
      }

      const direct = await pumpSellExecutor.executeSell({
        mint: new (await import('@solana/web3.js')).PublicKey(pos.mint),
        userKeypair: wallet.getKeypair(),
        tokenAmountAtomic: BigInt(exitAmountAtomic),
        slippageBps: 750
      });
      return {
        status: direct.status,
        txSignature: direct.txSignature || '',
        inAmount: exitAmountAtomic,
        outAmount: Number(
          direct.actualReceivedLamports ??
          direct.expectedNetSolLamports ??
          0n
        ),
        error: direct.error
      };
    }
  );
  selectedExitPath = routedExit.path;
  exitSwap = routedExit.result;
  latestState.pumpDirectSellFallback = {
    enabled: PUMP_DIRECT_SELL_FALLBACK_ENABLED,
    selectedPath: selectedExitPath,
    confirmationState:
      exitSwap.status === 'SUCCESS' || exitSwap.status === 'DRY_RUN_SUCCESS'
        ? 'CONFIRMED'
        : exitSwap.status === 'SUBMITTED_UNCONFIRMED'
          ? 'UNCERTAIN'
          : 'FAILED',
    estimatedCostSol: null,
    fallbackReason: selectedExitPath === 'PUMP_DIRECT' ? jupiterFallbackReason : null
  };

  if (
    selectedExitPath === 'PUMP_DIRECT' &&
    exitSwap.status === 'SUBMITTED_UNCONFIRMED'
  ) {
    uncertainExitMints.add(pos.mint);
    executionUncertainReason =
      `Pump direct sell inconclusivo em ${pos.symbol} (${pos.mint}); novas entradas suspensas.`;
    console.error(
      `🛑 [Pump sell_v2: ESTADO INCERTO] ${pos.symbol}: nenhuma segunda venda será criada até reconciliação.`
    );
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

  const tokenAmountBefore = pos.tokenAmount;
  const soldRatio = Math.min(1, Math.max(0, exitAmountAtomic / tokenAmountBefore));
  const costBasisSoldSol = (pos.entrySol || 0.015) * soldRatio;
  const actualExitSolValue = exitSwap.outAmount > 0
    ? exitSwap.outAmount / 1e9
    : exitSolValue * soldRatio;
  const realizedPnlSol = actualExitSolValue - costBasisSoldSol;
  const realizedPnlPct = costBasisSoldSol > 0
    ? realizedPnlSol / costBasisSoldSol
    : pnlPct;
  const impliedFullPositionSolValue = soldRatio > 0
    ? actualExitSolValue / soldRatio
    : exitSolValue;

  console.log(
    `💵 [ExitRouter:${selectedExitPath}] ${pos.symbol} | recebido=${actualExitSolValue.toFixed(9)} SOL ` +
    `| custo-base=${costBasisSoldSol.toFixed(9)} SOL | PnL=${(realizedPnlPct * 100).toFixed(2)}%`
  );

  if (isPartial) {
    const committed = positionEngine.commitPartialExit(pos.mint, exitAmountAtomic, impliedFullPositionSolValue);
    if (!committed) {
      console.error(`❌ [CONSISTÊNCIA] Swap parcial confirmou, mas o estado local não conseguiu aplicar a redução de ${exitAmountAtomic} unidades em ${pos.symbol}.`);
    }
  }

  // 3. Recuperação de Rent Exemption: fecha ATA ESTRITAMENTE em liquidações totais (100% vendido).
  // Falha ao fechar a ATA NÃO reabre a posição: se o swap foi confirmado, o risco financeiro já foi encerrado.
  // O rent fica pendente para o sweep automático, e não é creditado ficticiamente no ledger.
  let ataClosed = false;
  let rentRecoveredActualSol = 0;
  if (shouldCloseAta) {
    try {
      const closeResult = await wallet.closeTokenAccount(pos.mint);
      ataClosed = closeResult.success;
      if (ataClosed) {
        rentRecoveredActualSol = 0.00204;
        console.log(`🧹 [Higiene On-Chain] Conta ATA de ${pos.symbol} encerrada. ~0.00204 SOL de caução recuperados!`);
      } else {
        console.warn(
          `⚠️ [Aviso Fechamento ATA] Swap de ${pos.symbol} confirmado, mas ATA permaneceu aberta. ` +
          'Rent ficará pendente para o sweep automático.'
        );
      }
    } catch (err: any) {
      console.warn(
        `⚠️ [Aviso Fechamento ATA] Swap de ${pos.symbol} confirmado, mas fechamento da ATA falhou:`,
        err?.message || err
      );
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
      WATCHDOG_EXIT: 24 * 60 * 60 * 1000,  // 24 horas após perda prolongada de rota
      TRAILING_STOP: 0,
      TAKE_PROFIT:   0,
      LAYA_EXIT:     0
    };
    const quarantineMs = QUARANTINE_MS[exitReason] ?? 0;
    if (quarantineMs > 0) {
      const labels: Record<string, string> = {
        STOP_LOSS: '3h',
        TIME_STOP: '30min',
        MANUAL: '24h',
        WATCHDOG_EXIT: '24h'
      };
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

  // 5. Registra Trade Fechado usando o valor REAL refletido na wallet pelo /execute V2.
  const pnlSol = realizedPnlSol;

  // Telemetria diária de resultado; não bloqueia novas entradas.
  dailyPnlTracker.recordTradeResult(pnlSol);

  positionEngine.recordClosedTrade({
    mint: pos.mint,
    symbol: pos.symbol,
    tokenAmount: tokenAmountToSell,
    entryPriceUsd: pos.entryPriceUsd,
    exitPriceUsd: pos.entryPriceUsd * (1 + realizedPnlPct),
    entryTimestamp: pos.entryTimestamp,
    exitTimestamp: Date.now(),
    pnlPct: realizedPnlPct,
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
    LAYA_EXIT: 'EXIT_LAYA',
    WATCHDOG_EXIT: 'EXIT_WATCHDOG',
  };

  const rentRecovered = rentRecoveredActualSol;
  const feesSol = 0.00005;
  const netPnlSol = pnlSol - feesSol + rentRecovered;
  const tradeDurationS = Math.floor((Date.now() - pos.entryTimestamp) / 1000);

  journal.logOutcome({
    traceId: pos.traceId || randomUUID(),
    mint: pos.mint,
    entryPriceUsd: pos.entryPriceUsd,
    entrySizeSol: costBasisSoldSol,
    entryTimestamp: new Date(pos.entryTimestamp),
    exitPriceUsd: pos.entryPriceUsd * (1 + realizedPnlPct),
    exitSizeSol: actualExitSolValue,
    exitTimestamp: new Date(),
    exitReason: exitTypeMap[exitReason] || 'EXIT_WATCHDOG',
    pnlSol,
    pnlPct: realizedPnlPct * 100,
    feesTotalSol: feesSol,
    rentRecoveredSol: rentRecovered,
    netPnlSol,
    totalTradeDurationS: tradeDurationS,
    status: shouldCloseAta
      ? (exitReason === 'MANUAL' ? 'PANIC_CLOSED' : exitReason === 'WATCHDOG_EXIT' ? 'WATCHDOG_CLOSED' : 'FULLY_CLOSED')
      : 'PARTIAL_CLOSED'
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
    title: isPartial ? 'Colheita Parcial (+35%)' : `Saída Executada (${exitReason})`,
    symbol: pos.symbol,
    mint: pos.mint,
    action: isPartial ? 'Venda de 50% / Breakeven ativado' : 'Liquidação Total / ATA encerrada',
    pnlPct: realizedPnlPct,
    solValue: actualExitSolValue,
    txSignature: exitSwap.txSignature
  }).catch(() => {});

  updateDashboardViews();
  return { success: true, txSignature: exitSwap.txSignature };
}

async function maybeRunLayaTacticalPositionDecision(
  pos: PositionTracking,
  currentSolValue: number,
  pnlPct: number,
  currentPriceUsd: number
): Promise<void> {
  if (SOLANA_LAYA_TACTICAL_MODE === 'OFF') return;

  const now = Date.now();
  const lastCheck = layaPositionLastCheck.get(pos.mint) || 0;
  if (now - lastCheck < SOLANA_LAYA_POSITION_INTERVAL_MS) return;
  if (layaPositionInFlight.has(pos.mint)) return;

  layaPositionLastCheck.set(pos.mint, now);
  layaPositionInFlight.add(pos.mint);

  try {
    const entrySol = pos.entrySol || 0.015;
    const peakSol = positionEngine.getPeakSolValue(pos.mint) || entrySol;
    const peakPnlPct = entrySol > 0 ? (peakSol - entrySol) / entrySol : pnlPct;
    const layaPosition = await solanaLayaAdapter.evaluatePosition({
      mint: pos.mint,
      symbol: pos.symbol,
      pnlPct,
      peakPnlPct,
      holdingSeconds: Math.max(0, Math.floor((Date.now() - pos.entryTimestamp) / 1000)),
      partialTaken: Boolean(pos.partialTaken),
      currentPriceUsd,
      entryPriceUsd: pos.entryPriceUsd,
      lastKnownLiquidityUsd: pos.entryLiquidityUsd,
      lastKnownVolume5mUsd: pos.entryVolume5m,
      trailingActive: Boolean(pos.trailingActive),
      stopLossPct: pos.stopLossPct
    });

    console.log(
      `🧠 [Laya:Tactical:${SOLANA_LAYA_TACTICAL_MODE}:POSITION] ${pos.symbol} ` +
      `action=${layaPosition.action} confidence=${layaPosition.confidence.toFixed(4)} ` +
      `abstention=${layaPosition.abstention ?? 'none'} latencyMs=${layaPosition.latencyMs}`
    );

    // A resposta da Laya é telemetria advisory. Stops, trailing e saídas
    // permanecem exclusivamente sob o motor determinístico.

  } catch (err: any) {
    // Falha da Laya nunca desarma os hard exits do motor determinístico.
    console.warn(
      `⚠️ [Laya:Tactical:${SOLANA_LAYA_TACTICAL_MODE}:POSITION] ${pos.symbol}: ` +
      `${err?.message || err}`
    );
  } finally {
    layaPositionInFlight.delete(pos.mint);
  }
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
    dailyPnlState: dailyPnlTracker.getState(),
    executeExitOrder: (mint, reason, pnlPct, exitSolValue, options) =>
      executeExitOrder(mint, reason as any, pnlPct, exitSolValue, options),
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
        priorityLevel: 'high',
        trafficPriority: priorityForJupiterWork('PROTECTIVE_EXIT')
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
    sweepRent: () => runRentRecoverySweep('MANUAL'),
    panicToken: async (mint: string) => {
      console.log(`🚨 [API PANIC TOKEN] Liquidando moeda ${mint} a mercado via Jupiter Swap V2...`);
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
          priorityLevel: 'high',
          trafficPriority: priorityForJupiterWork('EMERGENCY_EXIT')
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
            priorityLevel: 'high',
            trafficPriority: priorityForJupiterWork('EMERGENCY_EXIT')
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
    journal,
    authService: adminAuthService
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
  if (NEXUS_MAINTENANCE_MODE) return;
  if (isRunningFastExit) return;
  isRunningFastExit = true;

  try {
    const openPositions = positionEngine.getAllPositions().sort((a, b) => {
      // Com cota limitada da Jupiter, runners pós-parcial têm prioridade de leitura:
      // já carregam lucro não realizado e dependem do trailing para proteção.
      const partialPriority = Number(Boolean(b.partialTaken)) - Number(Boolean(a.partialTaken));
      if (partialPriority !== 0) return partialPriority;
      return positionEngine.getPeakSolValue(b.mint) - positionEngine.getPeakSolValue(a.mint);
    });
    
    // CORREÇÃO: Log de debug mesmo sem posições (para diagnóstico)
    if (openPositions.length === 0) {
      return;
    }

    for (const pos of openPositions) {
      try {
        // Verdade econômica de saída = valor executável Jupiter Token -> SOL.
        // DexScreener permanece como referência de mercado, mas nunca decide PnL/stop
        // quando diverge da rota efetivamente vendável.
        const entrySol = pos.entrySol || 0.015;
        if (!pos.entryPriceUsd || pos.entryPriceUsd <= 0) {
          throw new Error('Posição sem preço USD de entrada para monitor de saída');
        }

        // Inicia a leitura de mercado em paralelo à Jupiter. DexScreener é
        // telemetria de liquidez/fluxo; Jupiter continua sendo a verdade econômica
        // para PnL e execução. Isso reduz latência e ativa de fato o gate de
        // drenagem de liquidez sem adicionar uma segunda chamada HTTP.
        exitTelemetry.sample(`${pos.mint}:${pos.entryPairAddress || ''}`, () => scanner.fetchCurrentTokenMarketSnapshot(pos.mint, pos.entryPairAddress));
        const tokenAtomicAmount = assertStoredAtomicNumberToNumber(pos.tokenAmount);
        const exitQuoteRequestedAt = Date.now();
        const executableQuote = await jupiterEngine.getQuote(
          pos.mint,
          'So11111111111111111111111111111111111111112',
          tokenAtomicAmount,
          500,
          priorityForJupiterWork('EXIT_CONFIRMATION')
        );
        const marketSnapshot = exitTelemetry.read(`${pos.mint}:${pos.entryPairAddress || ''}`);
        const dexPriceUsd = marketSnapshot?.priceUsd ?? null;
        const currentSolValue = (executableQuote.outAmount || 0) / 1e9;
        if (!Number.isFinite(currentSolValue) || currentSolValue <= 0) {
          throw new Error('Jupiter sem valor executável válido para monitor de saída');
        }
        positionEngine.recordExitRouteObservation(pos.mint, {
          observableSolValue: currentSolValue,
          executableSolValue: currentSolValue,
          jupiterExecutableSolValue: currentSolValue,
          healthyAtMs: Date.now()
        });
        exitPathHealth.recordSuccess(pos.mint);
        latestState.exitPathHealth = exitPathHealth.snapshot();
        const pnlPct = (currentSolValue - entrySol) / entrySol;
        reportProfitProtectionShadow(`${pos.mint}:${pos.entryTimestamp}`, {
          remainingCost: entrySol, initialCost: pos.entrySolValue || entrySol,
          confirmedProceeds: pos.partialTaken ? undefined : 0,
          executableValue: currentSolValue, peakValue: Math.max(pos.peakSolValue || entrySol, currentSolValue),
          remainingFraction: pos.tokenAmount / (pos.initialTokenAmount || pos.tokenAmount),
          quoteAgeMs: Date.now() - exitQuoteRequestedAt, estimatedExitFee: 0, maxSlippageBps: 750
        });
        const sensorSource = 'JUPITER_EXECUTABLE';
        const sensorPriceUsd = dexPriceUsd && Number.isFinite(dexPriceUsd) && dexPriceUsd > 0
          ? dexPriceUsd
          : pos.entryPriceUsd * (1 + pnlPct);

        if (dexPriceUsd && Number.isFinite(dexPriceUsd) && dexPriceUsd > 0) {
          const dexPnlPct = (dexPriceUsd / pos.entryPriceUsd) - 1;
          const divergencePctPoints = Math.abs(dexPnlPct - pnlPct) * 100;
          if (divergencePctPoints >= 15) {
            console.warn(
              `🚨 [PRICE_DIVERGENCE_CRITICAL] ${pos.symbol} | Dex PnL=${(dexPnlPct * 100).toFixed(2)}% ` +
              `| Jupiter executável=${(pnlPct * 100).toFixed(2)}% | divergência=${divergencePctPoints.toFixed(2)}pp`
            );
          }
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
        const liquidityNow = marketSnapshot?.liquidityUsd;
        const liquidityDropPct = liquidityNow !== undefined && pos.entryLiquidityUsd && pos.entryLiquidityUsd > 0
          ? Math.max(0, (pos.entryLiquidityUsd - liquidityNow) / pos.entryLiquidityUsd)
          : null;
        if (liquidityDropPct !== null && liquidityDropPct >= 0.15) {
          console.warn(
            `⚠️ [LIQUIDITY_DRAIN_WATCH] ${pos.symbol} | entrada=$${Math.round(pos.entryLiquidityUsd || 0).toLocaleString('en-US')} ` +
            `| atual=$${Math.round(liquidityNow || 0).toLocaleString('en-US')} | queda=${(liquidityDropPct * 100).toFixed(1)}%`
          );
        }

        console.log(
          `[ExitSensor] Token: ${pos.symbol} | Fonte: ${sensorSource} | PnL: ${(pnlPct * 100).toFixed(2)}% | ` +
          `Impacto: ${executableQuote.priceImpactPct.toFixed(3)}% | ` +
          `Liq: ${liquidityNow !== undefined ? '$' + Math.round(liquidityNow).toLocaleString('en-US') : 'N/D'} | ` +
          `SL: ${((pos.stopLossPct ?? PositionExitEngine.DEFAULT_STOP_LOSS_PCT) * 100).toFixed(1)}% | Trailing: ${trailingStatus}`
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

        // 🧠 Sentinela Solana de Saída Adaptativa:
        // Passa contexto atual da posição se disponível
        const exitSignal = positionEngine.evaluateExitBySol(
          pos.mint,
          currentSolValue,
          Date.now(),
          {
            currentLiquidityUsd: marketSnapshot?.liquidityUsd,
            currentVolume5m: marketSnapshot?.volume5mUsd
          }
        );

        if (!exitSignal.shouldExit || exitSignal.type === 'HOLD') {
          persistPeakWatermark(pos, positionEngine.getPeakSolValue(pos.mint));
          // O ciclo inteiro de leitura foi saudável; só agora zeramos o watchdog.
          // Antes isto ocorria ANTES da cotação executável de saída e mascarava
          // falhas consecutivas justamente no caminho crítico de liquidação.
          positionEngine.recordQuoteSuccess(pos.mint);
          void maybeRunLayaTacticalPositionDecision(
            pos,
            currentSolValue,
            pnlPct,
            Number(sensorPriceUsd || pos.entryPriceUsd)
          );
        }

        if (exitSignal.shouldExit && exitSignal.type !== 'HOLD') {
          // O próprio sinal já nasceu da cotação executável Jupiter deste ciclo.
          // executeSwap() ainda obtém/valida a transação final imediatamente antes do envio.
          positionEngine.recordQuoteSuccess(pos.mint);
          const detail = exitSignal.reasonDetail ? ` [${exitSignal.reasonDetail}]` : '';
          console.log(
            `🎯 [EXIT CONFIRMADO JUPITER${detail}] ${pos.symbol}: ${exitSignal.type} | ` +
            `PnL executável: ${(pnlPct * 100).toFixed(2)}% | Valor: ${currentSolValue.toFixed(9)} SOL`
          );
          await executeExitOrder(pos.mint, exitSignal.type, pnlPct, currentSolValue, {
            exitTokenAmount: exitSignal.exitTokenAmount,
            shouldCloseAta: exitSignal.shouldCloseAta
          });

          // Se a posição permaneceu aberta (parcial confirmada ou saída falhou),
          // persiste o watermark já ajustado ao lote/custo remanescente.
          const remainingPosition = positionEngine.getPosition(pos.mint);
          if (remainingPosition) {
            const partialWasCommitted =
              exitSignal.type === 'PARTIAL_TAKE_PROFIT_50' && remainingPosition.partialTaken === true;
            persistPeakWatermark(
              remainingPosition,
              positionEngine.getPeakSolValue(pos.mint),
              partialWasCommitted
            );
          }
        }
      } catch (quoteErr: any) {
        const { failures, shouldWarn, shouldEmergencyExit } = positionEngine.recordQuoteFailure(pos.mint);
        exitPathHealth.recordFailure(pos.mint, failures, quoteErr?.message || String(quoteErr));
        latestState.exitPathHealth = exitPathHealth.snapshot();
        if (failures === 1) {
          console.warn(
            `⚠️ [ExitMonitor:Falha Crítica] ${pos.symbol} (${pos.mint}) | ` +
            `falha=${quoteErr?.message || quoteErr}`
          );
        }
        if (shouldWarn) {
          console.warn(`⚠️ [WATCHDOG] ${failures} falhas consecutivas no caminho de cotação/saída para ${pos.mint}.`);
        } else if (shouldEmergencyExit) {
          console.error(`🚨 [WATCHDOG CONTINGÊNCIA] 8 falhas consecutivas de cotação (12s sem cotação). Disparando liquidação defensiva de emergência para ${pos.symbol} (${pos.mint})!`);
          try {
            let rawLamports: number;
            try {
              rawLamports = assertStoredAtomicNumberToNumber(pos.tokenAmount);
            } catch (amountErr: any) {
              throw new Error(`Watchdog recusou quantidade n?o at?mica: ${amountErr?.message || amountErr}`);
            }
            const watchdogPlan = buildWatchdogExitPlan({
              entrySol: pos.entrySol || 0.015,
              tokenAmountAtomic: rawLamports
            });
            const emergencyResult = await executeExitOrder(
              pos.mint,
              watchdogPlan.exitReason,
              watchdogPlan.pnlPct,
              watchdogPlan.exitSolValue,
              watchdogPlan.options
            );
            if (!emergencyResult.success) {
              throw new Error(
                `Saída segura do watchdog não confirmada: ${emergencyResult.error || 'sem detalhe'}. ` +
                'Posição preservada; nenhuma nova ordem é criada se a execução ficou incerta.'
              );
            }
            exitPathHealth.recordSuccess(pos.mint);
            latestState.exitPathHealth = exitPathHealth.snapshot();
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
 * Varredura DexScreener, Análise RugCheck + filtros determinísticos + Laya shadow e Execução Sniper
 */
async function executeAutonomousCycle() {
  if (NEXUS_MAINTENANCE_MODE) return;
  if (executionUncertainReason) {
    console.error(`🛑 [CIRCUIT BREAKER V2] Novas entradas suspensas: ${executionUncertainReason}`);
    return;
  }
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
        const tracked = positionEngine.getPosition(spl.mint);
        if (!tracked) continue;

        const atomicAmount = assertAtomicAmountToNumber(spl.atomicAmount);
        if (atomicAmount < tracked.tokenAmount) {
          console.warn(
            `⚖️ [Reconciliação On-Chain] ${tracked.symbol} (${spl.mint}) quantidade gerida ${tracked.tokenAmount} -> ${atomicAmount} unidades atômicas.`
          );
          tracked.tokenAmount = atomicAmount;
        } else if (atomicAmount > tracked.tokenAmount) {
          console.warn(
            `⚖️ [Reconciliação On-Chain] ${tracked.symbol} possui ${atomicAmount - tracked.tokenAmount} unidade(s) atômica(s) excedentes; o lote extra não foi adotado automaticamente.`
          );
        }

        const meta = await scanner.fetchTokenMetadata(spl.mint);
        const h = latestState.walletHoldings.find(x => x.mint === spl.mint);
        if (h && meta?.symbol) h.symbol = meta.symbol;
      }

      // Tokens presentes na carteira, mas ausentes do ledger de execução do bot,
      // permanecem apenas no painel de custódia. Nunca são promovidos a posição
      // operacional com preço/custo/stops inventados.
    } catch (err: any) {
      console.warn(`⚠️ [Aviso Custódia] Falha ao sincronizar contas SPL: ${err?.message || err}`);
    }

    updateDashboardViews();

    // 🎯 CONCORRÊNCIA E ALOCAÇÃO DE CAPITAL (MAX_CONCURRENT_POSITIONS = 2, máx 0.10 SOL)
    const activePositions = positionEngine.getAllPositions();
    exitPathHealth.retainOpenPositions(activePositions.map(position => position.mint));
    const currentExitHealth = exitPathHealth.snapshot();
    latestState.exitPathHealth = currentExitHealth;
    if (!currentExitHealth.canOpenNewPosition) {
      console.log(
        `🛑 [EXIT PATH ${currentExitHealth.state}] Novas entradas pausadas: ` +
        `${currentExitHealth.reason || 'rota de saída degradada'} ` +
        `(falhas=${currentExitHealth.maxFailures}).`
      );
      return;
    }
    if (activePositions.length >= MAX_CONCURRENT_POSITIONS) {
      console.log(`🎯 [TETO DE CONCORRÊNCIA ATINGIDO] ${activePositions.length}/${MAX_CONCURRENT_POSITIONS} posições em custódia (${activePositions.map(p => p.symbol).join(', ')}). Scanner de novas compras em pausa.`);
      return;
    }

    const exitCapacity = evaluateExitCapacity({
      generalRps: JUPITER_GENERAL_RPS,
      monitorIntervalMs: FAST_EXIT_INTERVAL_MS,
      openPositions: activePositions.length + 1,
      hasLocalExitSensor: false
    });
    latestState.exitCapacity = exitCapacity;
    if (!exitCapacity.admit) {
      console.log(
        `🛑 [EXIT CAPACITY] Nova entrada bloqueada: ${exitCapacity.reason} ` +
        `Posições após entrada=${activePositions.length + 1}; monitor=${FAST_EXIT_INTERVAL_MS}ms.`
      );
      return;
    }

    const capitalPolicy = buildEquitySizingPolicy({
      cashBalanceSol: balanceSol,
      positions: activePositions.map(position => ({
        costBasisSol: Math.max(0, position.entrySol || 0),
        executableValueSol: position.lastJupiterExecutableSolValue || position.entrySol
      })),
      maxPositions: MAX_CONCURRENT_POSITIONS,
      entryEquityPct: ENTRY_EQUITY_PCT,
      maxTotalAllocationPct: MAX_TOTAL_ALLOCATION_PCT,
      maxEntrySol: BUY_AMOUNT_SOL,
      maxTotalAllocationSol: MAX_TOTAL_ALLOCATION_SOL,
      minExecutableEntrySol: MIN_EXECUTABLE_ENTRY_SOL,
      gasReserveEquityPct: GAS_RESERVE_EQUITY_PCT,
      minGasReserveSol: MIN_GAS_RESERVE_SOL,
      maxGasReserveSol: MAX_GAS_RESERVE_SOL
    });
    latestShadowEntryLadderLamports = (capitalPolicy.ladderSol.length > 0
      ? capitalPolicy.ladderSol
      : [MIN_EXECUTABLE_ENTRY_SOL])
      .map(value => Math.max(1, Math.floor(value * 1e9)));
    if (!capitalPolicy.canOpenNextPosition) {
      console.log(
        `💰 [CAPITAL DINÂMICO] Sem lote executável: patrimônio=${capitalPolicy.portfolioEquitySol.toFixed(6)} SOL ` +
        `caixa=${capitalPolicy.cashBalanceSol.toFixed(6)} SOL reserva=${capitalPolicy.gasReserveSol.toFixed(6)} SOL ` +
        `alocado=${capitalPolicy.openCostBasisSol.toFixed(6)}/${capitalPolicy.totalAllocationLimitSol.toFixed(6)} SOL.`
      );
      return;
    }
    console.log(
      `💰 [CAPITAL DINÂMICO] patrimônio=${capitalPolicy.portfolioEquitySol.toFixed(6)} SOL ` +
      `entrada-alvo=${capitalPolicy.targetEntrySol.toFixed(6)} SOL ` +
      `cap=${capitalPolicy.selectedEntryCapSol.toFixed(6)} SOL slots=${capitalPolicy.slotsRemaining}/${MAX_CONCURRENT_POSITIONS}.`
    );

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
    const { waiting, mature, technicalDiscards: scannerDiscards, upstreamFailures = 0, retrying = 0 } = scanner.lastIncubatorStats;
    if (upstreamFailures > 0 || retrying > 0) {
      console.warn(`[DEX_UPSTREAM_WAIT] falhas/pares vazios=${upstreamFailures} | maduros aguardando retry=${retrying} | backoff=15000ms`);
    }

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
            DecisionLogger.evaluateGate('MATURITY_AGE', tokenAgeMinutes >= 5 && tokenAgeMinutes <= 60, tokenAgeMinutes, 5),
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

    const logMsg = `📊 [Incubadora: ${waiting} aguardando | Maturos (5-60m): ${mature} | Descarte Técnico: ${technicalDiscardCount} | Quarentena: ${quarantineCount} | Elegíveis para Auditoria: ${eligibleCandidates.length}]`;
    console.log(logMsg);

    latestState.incubator = {
      waiting,
      mature,
      technicalDiscards: technicalDiscardCount,
      entryEligible: eligibleCandidates.length
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
      // Consulta de Memória Cruzada Sentinel: verifica histórico de graduação na bonding curve (sentinel_handoff)
      for (const candidate of eligibleCandidates) {
        try {
          const cross = await sentinelHandoffScanner.checkCrossMemory(candidate.mint, (candidate as any).devWallet);
          if (cross.found && (cross.isGraduated || (cross.layaScore !== null && cross.layaScore >= 75))) {
            (candidate as any).sentinelCrossMemory = cross;
            (candidate as any).hasSentinelPriorityBonus = true;
            console.log(
              `⚡ [Memória Cruzada Sentinel] Token ${candidate.symbol} (${candidate.mint}) reconhecido no Sentinel Handoff! ` +
              `Status=${cross.status} LayaScore=${cross.layaScore ?? 'N/D'} | Bonificação heurística de prioridade no pipeline Jupiter concedida.`
            );
          }
        } catch {
          // Tolerante
        }
      }

      // Prioriza candidatos reconhecidos pelo Sentinel no topo da fila
      eligibleCandidates.sort((a, b) => {
        const aBonus = (a as any).hasSentinelPriorityBonus ? 1 : 0;
        const bBonus = (b as any).hasSentinelPriorityBonus ? 1 : 0;
        return bBonus - aBonus;
      });

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
        const audit = await entryGatekeeper.auditToken({
        mint: topCandidate.mint,
        liquidityUsd: topCandidate.liquidityUsd,
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
        console.log(`🛡️ [Filtros Solana aprovados]: Contrato Seguro (80+) | Momentum m5: +${m5Pct}% | Buys/Sells: ${buys}/${sells} | Vol Comprador > Vendedor`);
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
        DecisionLogger.evaluateGate('MATURITY_AGE', candidateAgeMinutes >= 5 && candidateAgeMinutes <= 60, candidateAgeMinutes, 5),
        DecisionLogger.evaluateGate('RUG_CHECK', audit.safe, audit.score, 80, audit.reason || undefined),
        ...buildContractGates(audit, topCandidate),
        DecisionLogger.evaluateGate('PRICE_WINDOW', isPriceWindowValid, topCandidate.priceChangeM5, 85),
        DecisionLogger.evaluateGate('BUY_DOMINANCE', isBuyDominanceValid, buySellRatio, 1.0),
        DecisionLogger.evaluateGate('SENTINEL_REGIME', isSentinelValid),
        DecisionLogger.evaluateGate('SLOT_AVAILABILITY', openPositions < MAX_CONCURRENT_POSITIONS, openPositions, MAX_CONCURRENT_POSITIONS),
        DecisionLogger.evaluateGate('LIQUIDITY_THRESHOLD', topCandidate.liquidityUsd >= 15000, topCandidate.liquidityUsd, 15000),
      ];

      const currentTraceId = randomUUID();

        if (!audit.safe) {
          console.log(`   Motivo do Veto: ${audit.reason}`);
          const vetoReasonText = audit.reason || 'Veto preventivo de segurança (RugCheck/Filtros Solana)';
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
          metadata: {
            layaNativeShadow: audit.layaNativeShadow ?? null,
            rugCheckReport: audit.rugCheckReport ?? null,
            gateEvidenceVersion: 2,
            activeValidator: audit.validatedBy
          },
        });
        
        console.log(`⏭️ Candidato #${candidateIndex + 1} reprovado no gatekeeper. ${candidateIndex + 1 < maxCandidatesToTry ? 'Tentando próximo candidato...' : 'Fim da fila de candidatos.'}`);
        // Não marca como processado - continua loop para próximo candidato
        continue;
      } else {
        let momentumTelemetry: any = null;
        let layaEntryTelemetry: any = null;
        const getMomentumStatus = () => {
          if (!ENTRY_MOMENTUM_GATE_ENABLED) return 'DISABLED';
          if (!momentumTelemetry) return 'UNKNOWN';
          if (momentumTelemetry.staleSource) return 'INDETERMINATE_STALE_SOURCE';
          return momentumTelemetry.pass ? 'PASS' : 'FAIL';
        };

        // Ciclo 4: Execução na Jupiter Swap V2 Meta-Aggregator (Dry-Run ou Real).
        // O teto de capital e a reserva foram calculados sobre o patrimônio total
        // antes da seleção; a profundidade da pool escolhe o degrau final.
        const SOL_MINT = 'So11111111111111111111111111111111111111112';

        // Momentum de curtíssimo prazo: usa o micropreço disponível no sensor.
        // Se todas as amostras vierem exatamente iguais, isso é tratado como fonte
        // congelada/indeterminada — não como evidência de momentum negativo. Nesse
        // caso os hard gates de 5m já aprovados continuam válidos e a decisão segue
        // para a Laya. Movimento real não-estagnado continua sendo bloqueado quando
        // viola alta mínima/máxima, continuidade ou pullback.
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
            momentumTelemetry = momentum;

            console.log(
              `📈 [Momentum Gate:MICROPRICE] ${topCandidate.symbol}: alta=${momentum.risePct.toFixed(3)}% | ` +
              `passos=${momentum.risingSteps}/${momentum.samples.length - 1} | stale=${momentum.staleSource} | ${momentum.reason}`
            );

            if (momentum.staleSource) {
              console.warn(
                `⚠️ [Momentum Gate:STALE] ${topCandidate.symbol}: fonte sem atualização na janela curta; ` +
                `hard gates de 5m permanecem válidos e o candidato seguirá para Laya.`
              );
            } else if (!momentum.pass) {
              const reason = `MOMENTUM_GATE: ${momentum.reason}`;
              antiSpamMemory.recordVeto(
                topCandidate.mint,
                reason,
                Math.max(SCAN_INTERVAL_MS, 30_000)
              );
              journal.logDecision({
                traceId: currentTraceId,
                decision: 'ENTRY_REJECTED',
                compositeScore: audit.score,
                token: {
                  mint: topCandidate.mint,
                  tokenSymbol: topCandidate.symbol,
                  liquidityUsd: topCandidate.liquidityUsd,
                  priceUsd: topCandidate.priceUsd,
                  priceChange5mPct: topCandidate.priceChangeM5,
                  buysCount5m: topCandidate.buysM5,
                  sellsCount5m: topCandidate.sellsM5,
                  buySellRatio,
                  volume5mUsd: topCandidate.volume5mUsd
                },
                market: {
                  sentinelRegime: (latestState.macroRegime as any) || 'NEUTRAL_RANGING',
                  sessionHourUtc: new Date().getUTCHours(),
                  isWeekend: [0, 6].includes(new Date().getUTCDay())
                },
                gateEvaluations: gates,
                rejectionReason: reason,
                metadata: {
                  phase: 'MOMENTUM_GATE',
                  momentumSource: 'DEXSCREENER_PRICE',
                  momentumStatus: 'FAIL',
                  momentumRisePct: momentum.risePct,
                  momentumRisingSteps: momentum.risingSteps,
                  momentumMaxPullbackPct: momentum.maxPullbackPct,
                  momentumSamples: momentum.samples,
                  layaStatus: 'NOT_CALLED_BLOCKED_BY_MOMENTUM'
                }
              });
              continue;
            }
          } catch (momentumErr: any) {
            const errText = momentumErr?.message || String(momentumErr);
            const reason = `MOMENTUM_SOURCE_UNAVAILABLE: ${errText}`;
            console.warn(`⚠️ [Momentum Gate:MICROPRICE] Falha ao observar ${topCandidate.symbol}: ${errText}`);
            antiSpamMemory.recordVeto(
              topCandidate.mint,
              reason,
              Math.max(SCAN_INTERVAL_MS, 30_000)
            );
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
              market: {
                sentinelRegime: (latestState.macroRegime as any) || 'NEUTRAL_RANGING',
                sessionHourUtc: new Date().getUTCHours()
              },
              gateEvaluations: gates,
              rejectionReason: reason,
              metadata: {
                phase: 'MOMENTUM_GATE',
                momentumSource: 'DEXSCREENER_PRICE',
                momentumStatus: 'SOURCE_FAILED',
                layaStatus: 'NOT_CALLED_MOMENTUM_SOURCE_FAILED'
              }
            });
            continue;
          }
        }

        // Mercado DEX: Laya é sempre advisory, inclusive com configuração LIVE/ACTIVE.
        // Nenhuma resposta ou falha da IA altera o fluxo financeiro.
        if (SOLANA_LAYA_TACTICAL_MODE !== 'OFF' || process.env.SOLANA_LAYA_SHADOW_ENABLED === 'true') {
          layaEntryTelemetry = scheduleEntryAdvisory({
            facts: audit.layaFacts,
            evaluate: facts => solanaLayaAdapter.evaluateEntry(facts),
            report: telemetry => console.log(
              `🧠 [Laya:Tactical:SHADOW:ENTRY] ${topCandidate.symbol} ` +
              `status=${telemetry.status} action=${telemetry.action ?? 'N/D'} ` +
              `score=${telemetry.score ?? 'N/D'} error=${telemetry.error ?? 'none'}`
            )
          });
        }

        const quoteParams = {
          inputMint: SOL_MINT,
          outputMint: topCandidate.mint,
          slippageBps: 750,
          autoSlippage: true,
          poolLiquidityUsd: topCandidate.liquidityUsd,
          // Colisao calibrada pela profundidade real da pool, em vez do valor
          // fixo de 1000 USD que apertava demais o slippage em pools de 15k-100k.
          maxAutoSlippageBps: 750,
          trafficPriority: (topCandidate as any).hasSentinelPriorityBonus
            ? priorityForJupiterWork('ENTRY_ORDER')
            : priorityForJupiterWork('ENTRY_SIZING')
        };

        console.log(
          `⚡ [3/3 Motor Jupiter V2] Dimensionando ${capitalPolicy.ladderSol.length} degrau(s) ` +
          `proporcionais ao patrimônio (${(capitalPolicy.entryEquityPct * 100).toFixed(1)}% | hard-cap 750bps)...`
        );

        // Cada degrau mantém o mesmo orçamento de risco da banca e reduz o lote
        // até o piso técnico. Isso permite encontrar uma execução <= 750 bps sem
        // relaxar slippage ou inventar liquidez.
        const economyLadderSol = capitalPolicy.ladderSol;

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
                priorityLevel: 'medium',
                forbiddenProgramIds: [PUMP_PROGRAM_ID.toBase58()],
                trafficPriority: priorityForJupiterWork('ENTRY_SIZING')
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
            metadata: {
              phase: 'SIZING',
              attempts: sizing.attempts,
              momentumSource: ENTRY_MOMENTUM_GATE_ENABLED ? 'DEXSCREENER_PRICE' : 'DISABLED',
                  momentumStatus: getMomentumStatus(),
              momentumRisePct: momentumTelemetry?.risePct ?? null,
              momentumRisingSteps: momentumTelemetry?.risingSteps ?? null,
              layaMode: 'SHADOW',
              layaStatus: layaEntryTelemetry?.status ?? (SOLANA_LAYA_TACTICAL_MODE === 'OFF' ? 'OFF' : 'NOT_CALLED'),
              layaAction: layaEntryTelemetry?.action ?? null,
              layaConfidence: layaEntryTelemetry?.confidence ?? null,
              layaAbstention: layaEntryTelemetry?.abstention ?? null,
              layaLatencyMs: layaEntryTelemetry?.latencyMs ?? null
            }
          });
          const sizingRetryMs = sizing.abortReason === 'SIMULATION_REJECTED'
            || sizing.abortReason === 'QUOTE_UNAVAILABLE'
            ? 2 * 60 * 1000
            : 5 * 60 * 1000;
          const sizingReason = `Sizing temporariamente inviável: ${failReason}`;
          antiSpamMemory.recordVeto(topCandidate.mint, sizingReason, sizingRetryMs);
          postgresRepo.saveQuarantine({
            mint: topCandidate.mint,
            symbol: topCandidate.symbol,
            reason: sizingReason,
            expiresAt: new Date(Date.now() + sizingRetryMs)
          }).catch(() => {});
          
          console.log(`⏭️ Candidato #${candidateIndex + 1} falhou no dimensionamento. ${candidateIndex + 1 < maxCandidatesToTry ? 'Tentando próximo candidato...' : 'Fim da fila de candidatos.'}`);
          // Não marca como processado - continua loop para próximo candidato
          continue;
        }

        if (referencesProgram(sizing.quote.rawQuote?.routePlan, PUMP_PROGRAM_ID.toBase58())) {
          console.warn(`🚫 [Veto de Rota] ${topCandidate.symbol}: contrato explícito da bonding curve Pump.fun.`);
          continue;
        }

        const dynamicAllocSol = sizing.sizeSol;
        const tradeLamports = Math.floor(dynamicAllocSol * 1e9);
        console.log(`📐 Lote dimensionado e validado no pré-voo: ${dynamicAllocSol} SOL (${tradeLamports} lamports) (Price Impact ${Math.abs(sizing.quote.priceImpactPct || 0).toFixed(3)}%)`);
        console.log(`   Escada percorrida: ${sizing.attempts.map((a) => `${a.sizeSol}SOL(${a.accepted ? 'ok' : 'rej'})`).join(' -> ')}`);

        // ENTRY_APPROVED: hard gates e lote dinâmico validados; Laya apenas advisory.
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
            volume5mUsd: topCandidate.volume5mUsd
          },
          market: {
            sentinelRegime: (latestState.macroRegime as any) || 'NEUTRAL_RANGING',
            sessionHourUtc: new Date().getUTCHours(),
            isWeekend: [0, 6].includes(new Date().getUTCDay())
          },
          execution: {
            sizeSol: dynamicAllocSol,
            estimatedSlippagePct: 7.5
          },
          gateEvaluations: gates,
          metadata: {
            phase: 'READY_FOR_JUPITER_SWAP',
            momentumSource: ENTRY_MOMENTUM_GATE_ENABLED ? 'DEXSCREENER_PRICE' : 'DISABLED',
                  momentumStatus: getMomentumStatus(),
            momentumRisePct: momentumTelemetry?.risePct ?? null,
            momentumRisingSteps: momentumTelemetry?.risingSteps ?? null,
            momentumMaxPullbackPct: momentumTelemetry?.maxPullbackPct ?? null,
            layaMode: 'SHADOW',
              layaStatus: layaEntryTelemetry?.status ?? (SOLANA_LAYA_TACTICAL_MODE === 'OFF' ? 'OFF' : 'NOT_CALLED'),
            layaAction: layaEntryTelemetry?.action ?? null,
            layaConfidence: layaEntryTelemetry?.confidence ?? null,
            layaAbstention: layaEntryTelemetry?.abstention ?? null,
            layaLatencyMs: layaEntryTelemetry?.latencyMs ?? null,
            sizingAttempts: sizing.attempts,
            priceImpactPct: sizing.quote.priceImpactPct
          }
        });

        console.log(`⚡ [3/3 Motor Jupiter Swap V2] Executando compra com RTSE + pré-voo fail-closed (${dynamicAllocSol} SOL | hard-cap 750bps)...`);
        const entryAttemptStartedAt = Date.now();
        let swapSim = await jupiterEngine.executeSwap({
          inputMint: SOL_MINT,
          outputMint: topCandidate.mint,
          amountLamports: tradeLamports,
          autoSlippage: true,
                poolLiquidityUsd: topCandidate.liquidityUsd,
          maxAutoSlippageBps: 750, // Teto seguro com margem de 750 bps contra erro 6014
          skipPreflight: false, // Fail-closed: nunca transmite se a simulação rejeitar
          forbiddenProgramIds: [PUMP_PROGRAM_ID.toBase58()],
          userPublicKey: OFFICIAL_PHANTOM_WALLET,
          keypair: wallet.getKeypair(),
          trafficPriority: priorityForJupiterWork('ENTRY_ORDER')
        });

        txSignature = swapSim.txSignature;
        console.log(`   Status do Swap: ${swapSim.status}`);
        if (swapSim.error) {
          console.log(`   ⚠️ Erro Swap: ${swapSim.error}`);
        }
        console.log(`   Assinatura Tx: ${swapSim.txSignature || 'N/A'}`);
        console.log(`   Retorno V2: ${swapSim.outAmount.toLocaleString()} unidades atômicas | router=${swapSim.router || 'n/d'} | slippage=${swapSim.slippageBps ?? 'n/d'}bps`);

        if (swapSim.status === 'SUBMITTED_UNCONFIRMED') {
          console.warn(
            `⚠️ [Jupiter V2: RECONCILIAÇÃO DE ENTRADA] ${topCandidate.symbol}: ` +
            'resposta /execute inconclusiva; procurando delta confirmado na wallet.'
          );
          const reconciled = await reconcileUncertainV2Execution(
            topCandidate.mint,
            entryAttemptStartedAt,
            'IN'
          );

          if (reconciled) {
            const receivedAtomic = Number(BigInt(reconciled.deltaAtomic));
            if (Number.isSafeInteger(receivedAtomic) && receivedAtomic > 0) {
              swapSim = {
                ...swapSim,
                status: 'SUCCESS',
                txSignature: reconciled.signature,
                outAmount: receivedAtomic,
                error: undefined
              };
              txSignature = reconciled.signature;
              console.log(
                `✅ [Jupiter V2: ENTRADA RECONCILIADA ON-CHAIN] ${topCandidate.symbol} ` +
                `| tx=${reconciled.signature} | recebido=${receivedAtomic} atomic`
              );
            }
          }

          if (swapSim.status === 'SUBMITTED_UNCONFIRMED') {
            const reason =
              `Entrada V2 inconclusiva em ${topCandidate.symbol} (${topCandidate.mint}); ` +
              'novas entradas suspensas até reconciliação/restart seguro.';
            executionUncertainReason = reason;
            antiSpamMemory.recordVeto(topCandidate.mint, reason, 24 * 60 * 60 * 1000);
            void postgresRepo.saveQuarantine({
              mint: topCandidate.mint,
              symbol: topCandidate.symbol,
              reason,
              expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000)
            }).catch(() => {});
            console.error(`🛑 [CIRCUIT BREAKER V2] ${reason}`);
            return;
          }
        }

        if (swapSim.status === 'SUCCESS' || swapSim.status === 'DRY_RUN_SUCCESS') {
          // CORREÇÃO: Só adiciona posição se houver txid on-chain confirmado
          if (!swapSim.txSignature && swapSim.status !== 'DRY_RUN_SUCCESS') {
            const reason = `JUPITER_SWAP_NO_TXID: status=${swapSim.status}`;
            console.error(`🛑 [ENTRADA REJEITADA] Swap sem txid on-chain: ${topCandidate.symbol} | Status: ${swapSim.status}`);
            antiSpamMemory.recordVeto(topCandidate.mint, reason, 60 * 60 * 1000);
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
              rejectionReason: reason,
              metadata: {
                phase: 'JUPITER_SWAP',
                swapStatus: swapSim.status,
                swapError: swapSim.error ?? null,
                momentumRisePct: momentumTelemetry?.risePct ?? null,
                layaAction: layaEntryTelemetry?.action ?? null,
                layaConfidence: layaEntryTelemetry?.confidence ?? null
              }
            });
            return;
          }
          
          // Snapshot de Entrada (Contexto Inicial da Operação):
          const nowTs = Date.now();
          const confirmedEntrySol = swapSim.inAmount / 1e9;

          // A quote Jupiter informa uma expectativa. Para posição REAL, a quantidade
          // gerida deve vir do delta efetivamente confirmado na própria transação.
          let managedEntryAtomic = Math.trunc(swapSim.outAmount);
          if (!swapSim.isDryRun && swapSim.txSignature) {
            const actualReceivedAtomic = await wallet.getReceivedTokenDeltaAtomic(
              swapSim.txSignature,
              topCandidate.mint
            );
            if (actualReceivedAtomic) {
              managedEntryAtomic = assertAtomicAmountToNumber(actualReceivedAtomic);
              if (managedEntryAtomic !== Math.trunc(swapSim.outAmount)) {
                console.warn(
                  `⚖️ [ENTRY:Reconciliação Imediata] ${topCandidate.symbol}: quote=${Math.trunc(swapSim.outAmount)} ` +
                  `| recebido on-chain=${managedEntryAtomic} unidades atômicas.`
                );
              }
            } else {
              console.warn(
                `⚠️ [ENTRY] ${topCandidate.symbol}: delta on-chain indisponível após confirmação; ` +
                'mantendo outAmount cotado até a próxima reconciliação de custódia.'
              );
            }
          }

          // Só agora a aprovação entra no cache: a compra já foi confirmada pelo executor.
          antiSpamMemory.recordApproval(topCandidate.mint, audit.score);
          positionEngine.addPosition({
            mint: topCandidate.mint,
            symbol: topCandidate.symbol,
            tokenAmount: managedEntryAtomic,
            entryPriceUsd: topCandidate.priceUsd,
            entryTimestamp: nowTs,
            stopLossPct: PositionExitEngine.DEFAULT_STOP_LOSS_PCT,
            takeProfitPct: 0.35, // +35% para colheita parcial 50%
            entrySol: confirmedEntrySol,
            entrySolValue: confirmedEntrySol,
            entryLiquidityUsd: topCandidate.liquidityUsd,
            entryVolume5m: topCandidate.volume5mUsd || 0,
            entryPairAddress: topCandidate.pairAddress,
            traceId: currentTraceId
          });

          // Ledger de execução real: somente este evento prova que a compra chegou
          // ao executor. A aprovação anterior é pré-swap e não pode reidratar posição.
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
              volume5mUsd: topCandidate.volume5mUsd
            },
            market: {
              sentinelRegime: (latestState.macroRegime as any) || 'NEUTRAL_RANGING',
              sessionHourUtc: new Date().getUTCHours(),
              isWeekend: [0, 6].includes(new Date().getUTCDay())
            },
            execution: {
              sizeSol: confirmedEntrySol,
              estimatedSlippagePct: (swapSim.slippageBps ?? 750) / 100
            },
            gateEvaluations: gates,
            metadata: {
              phase: 'ENTRY_EXECUTED',
              gateEvidenceVersion: 2,
              txSignature: swapSim.txSignature,
              outAmountAtomic: String(managedEntryAtomic),
              quotedOutAmountAtomic: String(Math.trunc(swapSim.outAmount)),
              executionPath: swapSim.executionPath,
              jupiterRouter: swapSim.router ?? null,
              jupiterRequestId: swapSim.requestId ?? null,
              jupiterFeeBps: swapSim.feeBps ?? null,
              jupiterFeeMint: swapSim.feeMint ?? null,
              jupiterSlippageBps: swapSim.slippageBps ?? null,
              stopLossPct: PositionExitEngine.DEFAULT_STOP_LOSS_PCT,
              takeProfitPct: 0.35,
              entryTimestampMs: nowTs,
              isDryRun: swapSim.isDryRun,
              momentumSource: ENTRY_MOMENTUM_GATE_ENABLED ? 'DEXSCREENER_PRICE' : 'DISABLED',
                  momentumStatus: getMomentumStatus(),
              momentumRisePct: momentumTelemetry?.risePct ?? null,
              momentumRisingSteps: momentumTelemetry?.risingSteps ?? null,
              momentumMaxPullbackPct: momentumTelemetry?.maxPullbackPct ?? null,
              layaMode: 'SHADOW',
              layaStatus: layaEntryTelemetry?.status ?? (SOLANA_LAYA_TACTICAL_MODE === 'OFF' ? 'OFF' : 'NOT_CALLED'),
              layaAction: layaEntryTelemetry?.action ?? null,
              layaConfidence: layaEntryTelemetry?.confidence ?? null,
              layaAbstention: layaEntryTelemetry?.abstention ?? null,
              layaLatencyMs: layaEntryTelemetry?.latencyMs ?? null
            }
          });

          // Cria o trade OPEN imediatamente; a mesma linha será atualizada nas
          // saídas via ON CONFLICT(trace_id). O flush aqui ocorre após a compra,
          // portanto não adiciona latência ao envio on-chain e evita amnésia pós-restart.
          journal.logOutcome({
            traceId: currentTraceId,
            mint: topCandidate.mint,
            entryPriceUsd: topCandidate.priceUsd,
            entrySizeSol: confirmedEntrySol,
            entryTimestamp: new Date(nowTs),
            // Slippage tolerance is not realized slippage; leave the latter unknown.
            status: 'OPEN'
          });
          await journal.flush();

          console.log(`📈 Posição em ${topCandidate.symbol} registrada no Gestor de Posições (Snapshot: Liq $${topCandidate.liquidityUsd.toLocaleString()} | Vol5m $${(topCandidate.volume5mUsd || 0).toLocaleString()} | Alocação: ${dynamicAllocSol} SOL | SL: -12.5% | TP: +35%)`);
          
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
            action: `Compra na Jupiter V2 (${swapSim.router || 'router n/d'}) | Recebido: ${managedEntryAtomic.toLocaleString()} unidades atômicas`,
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
          journal.logDecision({
            traceId: currentTraceId,
            decision: 'ENTRY_REJECTED',
            compositeScore: audit.score,
            token: {
              mint: topCandidate.mint,
              tokenSymbol: topCandidate.symbol,
              liquidityUsd: topCandidate.liquidityUsd,
              priceUsd: topCandidate.priceUsd,
              priceChange5mPct: topCandidate.priceChangeM5
            },
            market: { sentinelRegime: (latestState.macroRegime as any) || 'NEUTRAL_RANGING' },
            gateEvaluations: gates,
            rejectionReason: swapVetoText,
            metadata: {
              phase: 'JUPITER_SWAP',
              swapStatus: swapSim.status,
              swapError: failReason,
              txSignature: swapSim.txSignature || null,
              momentumSource: ENTRY_MOMENTUM_GATE_ENABLED ? 'DEXSCREENER_PRICE' : 'DISABLED',
                  momentumStatus: getMomentumStatus(),
              momentumRisePct: momentumTelemetry?.risePct ?? null,
              momentumRisingSteps: momentumTelemetry?.risingSteps ?? null,
              layaMode: 'SHADOW',
              layaStatus: layaEntryTelemetry?.status ?? (SOLANA_LAYA_TACTICAL_MODE === 'OFF' ? 'OFF' : 'NOT_CALLED'),
              layaAction: layaEntryTelemetry?.action ?? null,
              layaConfidence: layaEntryTelemetry?.confidence ?? null,
              layaAbstention: layaEntryTelemetry?.abstention ?? null,
              layaLatencyMs: layaEntryTelemetry?.latencyMs ?? null
            }
          });
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

    // Ciclo 5: Reprodução Darwinista legada removida (projeto anterior)

    console.log(`✅ [${new Date().toLocaleTimeString()}] Ciclo finalizado com proteção integral.`);
  } catch (error: any) {
    console.error('⚠️ Erro durante o ciclo de varredura:', error?.message || error);
  } finally {
    isRunningScanner = false;
  }
}

/**
 * 🔄 REIDRATAÇÃO NO BOOT (ledger + reconciliação on-chain)
 * Só restaura posições cuja compra foi confirmada e persistida pelo agente.
 * O saldo SPL confirma a quantidade restante; tokens sem prova no ledger
 * permanecem visíveis como custódia, mas fora do PositionExitEngine.
 */
interface RecoverablePositionRecord {
  traceId: string;
  mint: string;
  symbol: string;
  entryPriceUsd: number;
  entrySizeSol: number;
  entryTimestamp: number;
  initialTokenAmountAtomic: number;
  entryLiquidityUsd: number;
  entryVolume5m: number;
  entryPairAddress?: string;
  peakSolValue?: number;
  observablePeakSolValue?: number;
  executablePeakSolValue?: number;
  lastJupiterExecutableSolValue?: number;
  lastHealthyExitRouteAt?: number;
  stopLossPct: number;
  takeProfitPct: number;
  partialTaken: boolean;
  entryTxSignature: string;
}

async function queryRecoverablePositions(): Promise<Map<string, RecoverablePositionRecord>> {
  const positions = new Map<string, RecoverablePositionRecord>();
  const pool = postgresRepo.getPool();
  if (!pool) {
    console.warn('⚠️ [BOOT] Sem pool Postgres — reidratação pulada por segurança.');
    return positions;
  }
  try {
    const res = await pool.query(`
      WITH latest AS (
        SELECT DISTINCT ON (dj.mint)
          dj.trace_id, dj.mint, dj.token_symbol, dj.pool_address, dj.liquidity_usd, dj.volume_5m_usd,
          dj.metadata, dj.created_at, o.entry_price_usd, o.entry_size_sol,
          o.entry_timestamp, o.status, o.peak_sol_value,
          o.observable_peak_sol_value, o.executable_peak_sol_value,
          o.last_jupiter_executable_sol_value, o.last_healthy_exit_route_at
        FROM decision_journal dj
        JOIN trade_outcomes o ON o.trace_id = dj.trace_id
        WHERE dj.decision = 'ENTRY_APPROVED'
          AND dj.metadata->>'phase' = 'ENTRY_EXECUTED'
          AND COALESCE(dj.metadata->>'txSignature', '') <> ''
          AND COALESCE(dj.metadata->>'isDryRun', 'false') = 'false'
        ORDER BY dj.mint, dj.created_at DESC
      )
      SELECT * FROM latest WHERE status IN ('OPEN', 'PARTIAL_CLOSED')
    `);

    for (const row of res.rows) {
      try {
        const metadata = row.metadata || {};
        const initialAtomic = assertAtomicAmountToNumber(String(metadata.outAmountAtomic || ''));
        positions.set(row.mint, {
          traceId: String(row.trace_id),
          mint: String(row.mint),
          symbol: String(row.token_symbol || `${String(row.mint).slice(0, 4)}...${String(row.mint).slice(-4)}`),
          entryPriceUsd: Number(row.entry_price_usd),
          entrySizeSol: Number(row.entry_size_sol),
          entryTimestamp: new Date(row.entry_timestamp).getTime(),
          initialTokenAmountAtomic: initialAtomic,
          entryLiquidityUsd: Number(row.liquidity_usd || 0),
          entryVolume5m: Number(row.volume_5m_usd || 0),
          entryPairAddress: row.pool_address ? String(row.pool_address) : undefined,
          peakSolValue: row.peak_sol_value != null ? Number(row.peak_sol_value) : undefined,
          observablePeakSolValue: row.observable_peak_sol_value != null ? Number(row.observable_peak_sol_value) : undefined,
          executablePeakSolValue: row.executable_peak_sol_value != null ? Number(row.executable_peak_sol_value) : undefined,
          lastJupiterExecutableSolValue: row.last_jupiter_executable_sol_value != null
            ? Number(row.last_jupiter_executable_sol_value)
            : undefined,
          lastHealthyExitRouteAt: row.last_healthy_exit_route_at
            ? new Date(row.last_healthy_exit_route_at).getTime()
            : undefined,
          stopLossPct: Number(metadata.stopLossPct ?? PositionExitEngine.DEFAULT_STOP_LOSS_PCT),
          takeProfitPct: Number(metadata.takeProfitPct ?? 0.35),
          partialTaken: row.status === 'PARTIAL_CLOSED',
          entryTxSignature: String(metadata.txSignature)
        });
      } catch (rowErr: any) {
        console.warn(`⚠️ [BOOT] Registro de recuperação inválido para ${row.mint}: ${rowErr?.message || rowErr}`);
      }
    }
  } catch (err: any) {
    console.warn('⚠️ [BOOT] Falha ao consultar posições recuperáveis:', err?.message || err);
  }
  return positions;
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

    // Uma posição só volta à mesa quando existe prova durável de execução:
    // ENTRY_EXECUTED + trade_outcomes OPEN/PARTIAL_CLOSED + tx signature.
    // O saldo on-chain serve apenas para reconciliar a quantidade efetivamente
    // custodiada; ele nunca inventa preço de entrada, custo ou stops.
    const recoverablePositions = await queryRecoverablePositions();
    if (recoverablePositions.size === 0) {
      console.log('ℹ️  [BOOT] Nenhum trade executado e aberto no ledger — nenhuma posição a reidratar.');
    } else {
      console.log(`📜 [BOOT] Trades executados recuperáveis no ledger: ${recoverablePositions.size}`);
    }

    const orphans: Array<{ mint: string; tokenAmount: number; decimals: number; ataAddress: string }> = [];

    for (const spl of splAccounts) {
      if (BASE_MINTS.has(spl.mint)) continue;

      const currentAtomic = assertAtomicAmountToNumber(spl.atomicAmount);
      const recovery = recoverablePositions.get(spl.mint);

      if (!recovery) {
        orphans.push({
          mint: spl.mint,
          tokenAmount: spl.tokenAmount,
          decimals: spl.decimals,
          ataAddress: spl.ataAddress
        });
        continue;
      }

      if (positionEngine.getPosition(spl.mint)) continue;

      // Nunca adota unidades adicionadas manualmente depois da compra do bot.
      // Em runner pós-parcial, a posição esperada não pode exceder ~50% do lote inicial.
      const expectedCapAtomic = recovery.partialTaken
        ? Math.ceil(recovery.initialTokenAmountAtomic / 2)
        : recovery.initialTokenAmountAtomic;
      const managedAtomic = Math.min(currentAtomic, expectedCapAtomic);
      if (managedAtomic <= 0) continue;

      const remainingRatio = managedAtomic / recovery.initialTokenAmountAtomic;
      const remainingEntrySol = recovery.entrySizeSol * remainingRatio;
      const effectiveStopLossPct = recovery.partialTaken ? 0.01 : (recovery.stopLossPct >= 0 ? recovery.stopLossPct : PositionExitEngine.DEFAULT_STOP_LOSS_PCT);

      positionEngine.addPosition({
        mint: spl.mint,
        symbol: recovery.symbol,
        tokenAmount: managedAtomic,
        initialTokenAmount: recovery.initialTokenAmountAtomic,
        entryPriceUsd: recovery.entryPriceUsd,
        entryTimestamp: recovery.entryTimestamp,
        stopLossPct: effectiveStopLossPct,
        takeProfitPct: recovery.takeProfitPct,
        entrySol: remainingEntrySol,
        entrySolValue: recovery.entrySizeSol,
        entryLiquidityUsd: recovery.entryLiquidityUsd,
        entryVolume5m: recovery.entryVolume5m,
        entryPairAddress: recovery.entryPairAddress,
        peakSolValue: recovery.peakSolValue,
        observablePeakSolValue: recovery.observablePeakSolValue,
        executablePeakSolValue: recovery.executablePeakSolValue,
        lastJupiterExecutableSolValue: recovery.lastJupiterExecutableSolValue,
        lastHealthyExitRouteAt: recovery.lastHealthyExitRouteAt,
        traceId: recovery.traceId,
        partialTaken: recovery.partialTaken
      });

      console.log(
        `🛡️ [BOOT: Posição Restaurada do Ledger] ${recovery.symbol} (${spl.mint}) | ` +
        `atomic=${managedAtomic}/${recovery.initialTokenAmountAtomic} | custo restante=${remainingEntrySol.toFixed(6)} SOL | ` +
        `status=${recovery.partialTaken ? 'PARTIAL_CLOSED' : 'OPEN'}`
      );

      if (currentAtomic > managedAtomic) {
        console.warn(
          `⚖️ [BOOT] ${currentAtomic - managedAtomic} unidade(s) atômica(s) excedentes em ${spl.mint} ` +
          'ficaram fora da posição automática por segurança.'
        );
      }
    }

    // A visão de custódia deve refletir TODAS as contas com saldo on-chain,
    // inclusive posições gerenciadas. "Órfão" é apenas classificação operacional,
    // não critério para esconder saldo do operador.
    latestState.walletHoldings = splAccounts
      .filter((spl) => !BASE_MINTS.has(spl.mint))
      .map((spl) => {
        const recovery = recoverablePositions.get(spl.mint);
        return {
          mint: spl.mint,
          symbol: recovery?.symbol || `${spl.mint.slice(0, 4)}...${spl.mint.slice(-4)}`,
          tokenAmount: spl.tokenAmount,
          decimals: spl.decimals,
          ataAddress: spl.ataAddress,
          solscanUrl: `https://solscan.io/token/${spl.mint}`,
          dexScreenerUrl: `https://dexscreener.com/solana/${spl.mint}`
        };
      });

    if (orphans.length > 0) {
      console.log(`🚫 [BOOT] ${orphans.length} token(s) sem trade executado no ledger ficaram fora da mesa automática, mas permanecem visíveis em holdings.`);
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

// ============================================================
// PONTE SENTINEL HANDOFF — "Graduation Dip" Handler
// ============================================================
// Tokens entregues pelo nexus-pump-sentinel já foram auditados
// na bonding curve (dev share <= 5%, LayaScore >= 75).
// Este handler implementa um warm-up de rota na Jupiter
// (10-25s para indexar novas pools Raydium) e, quando a rota
// estiver disponível dentro da janela de 45-90s pós-criação,
// dispara a entrada via executeAutonomousCycle com bypass de
// maturidade mínima (os 5 minutos do mercado geral).
// O núcleo do Padrão Ouro (liquidez >= $15k, slippage 750bps,
// Escada 4D, Regra Zero) permanece 100% intocado.
// ============================================================

const SOL_MINT_GLOBAL = 'So11111111111111111111111111111111111111112';
const SENTINEL_DIP_WARMUP_RETRY_MS = 3_000;    // Retenta cotação a cada 3s
const SENTINEL_DIP_WARMUP_MAX_MS = 60_000;     // Janela máxima de warm-up: 60s
const SENTINEL_DIP_WINDOW_MIN_MS = 45_000;     // Janela mínima do dip: 45s pós-criação
const SENTINEL_DIP_WINDOW_MAX_MS = 90_000;     // Janela máxima do dip: 90s pós-criação
const SENTINEL_MIN_LIQUIDITY_USD = 15_000;     // Invariante do Padrão Ouro
const SENTINEL_DIP_DIRECT_LIQUIDITY_USD = 25_000; // Rota confirmada permite entrada antes de 45s
const sentinelActiveGraduations = new Set<string>(); // Impede processamento duplo do mesmo mint

async function handleSentinelGraduationDip(token: SentinelHandoffToken): Promise<void> {
  const { mint, symbol } = token;

  // Proteção contra processamento concorrente do mesmo mint
  if (sentinelActiveGraduations.has(mint)) {
    console.log(`[SentinelHandoff] ${symbol}: graduação já em processamento, ignorando evento duplicado.`);
    return;
  }
  // Rejeita se já auditado/vetado recentemente
  if (antiSpamMemory.shouldSkip(mint).skip) {
    console.log(`[SentinelHandoff] ${symbol}: mint em quarentena local, descartado.`);
    return;
  }
  // O score recebido é telemetria advisory, inclusive quando ausente ou baixo.
  console.log(`[SentinelHandoff] ${symbol}: LayaScore advisory=${token.layaScore ?? 'N/D'} (sem veto).`);

  sentinelActiveGraduations.add(mint);
  const startMs = Date.now();
  console.log(`[SentinelHandoff] Iniciando warm-up de rota Jupiter para ${symbol} (${mint})...`);

  try {
    const warmupDeadlineMs = startMs + SENTINEL_DIP_WARMUP_MAX_MS;
    let routeAvailable = false;
    let marketSnapshot: Awaited<ReturnType<typeof scanner.fetchCurrentTokenMarketSnapshot>> = null;

    // Loop de warm-up: tenta obter cotação Jupiter a cada 3s por até 60s
    while (Date.now() < warmupDeadlineMs) {
      await new Promise(resolve => setTimeout(resolve, SENTINEL_DIP_WARMUP_RETRY_MS));

      const elapsedMs = Date.now() - startMs;
      const tokenAgeMs = Date.now() - token.createdAt.getTime();
      if (tokenAgeMs > SENTINEL_DIP_WINDOW_MAX_MS) {
        console.warn(`[SentinelHandoff] ${symbol}: janela máxima do Graduation Dip expirada. Abortando.`);
        return;
      }

      // Verifica snapshot de mercado na DexScreener (liquidez on-chain)
      marketSnapshot = null;
      try {
        marketSnapshot = await scanner.fetchCurrentTokenMarketSnapshot(mint);
      } catch {
        // Aguarda próxima tentativa
      }

      if (!marketSnapshot || marketSnapshot.liquidityUsd < SENTINEL_MIN_LIQUIDITY_USD) {
        console.log(`[SentinelHandoff] ${symbol}: liquidez insuficiente ($${Math.round(marketSnapshot?.liquidityUsd ?? 0)}) em ${Math.round(elapsedMs / 1000)}s. Aguardando...`);
        continue;
      }

      // Tenta obter cotação na Jupiter (confirma que a pool está indexada)
      try {
        const probeAmountLamports = Math.floor(0.001 * 1e9); // probe mínimo: 0.001 SOL
        const quote = await jupiterEngine.getQuote(
          SOL_MINT_GLOBAL,
          mint,
          probeAmountLamports,
          750,
          priorityForJupiterWork('ENTRY_SIZING')
        );
        if (quote && quote.outAmount > 0) {
          // Verifica se a rota não passa por bonding curve da Pump.fun
          if (referencesProgram(quote.rawQuote?.routePlan, PUMP_PROGRAM_ID.toBase58())) {
            console.log(`[SentinelHandoff] ${symbol}: contrato Bonding Curve bloqueado. Aguardando migração...`);
            continue;
          }
          const confirmedAgeMs = Date.now() - token.createdAt.getTime();
          if (confirmedAgeMs > SENTINEL_DIP_WINDOW_MAX_MS) {
            console.warn(`[SentinelHandoff] ${symbol}: janela máxima expirou durante a cotação. Abortando.`);
            return;
          }
          if (confirmedAgeMs < SENTINEL_DIP_WINDOW_MIN_MS && marketSnapshot.liquidityUsd < SENTINEL_DIP_DIRECT_LIQUIDITY_USD) {
            const waitMs = SENTINEL_DIP_WINDOW_MIN_MS - confirmedAgeMs;
            if (waitMs > 0 && waitMs <= 45_000) {
              console.log(`[SentinelHandoff] ${symbol}: rota confirmada; aguardando ${waitMs}ms para abertura da janela do Dip.`);
              await new Promise(resolve => setTimeout(resolve, waitMs));
            }
            // Renova liquidez e rota após a espera; não reutiliza a cotação antiga.
            continue;
          }
          routeAvailable = true;
          console.log(
            `[SentinelHandoff] ${symbol}: rota Jupiter confirmada em ${Math.round(elapsedMs / 1000)}s ` +
            `| liq=$${Math.round(marketSnapshot.liquidityUsd)} | tokenAge=${Math.round(tokenAgeMs / 1000)}s`
          );
          break;
        }
      } catch {
        console.log(`[SentinelHandoff] ${symbol}: rota Jupiter ainda não disponível em ${Math.round(elapsedMs / 1000)}s. Aguardando...`);
      }
    }

    if (!routeAvailable || !marketSnapshot) {
      console.warn(`[SentinelHandoff] ${symbol}: rota não confirmada dentro da janela de ${SENTINEL_DIP_WARMUP_MAX_MS / 1000}s. Abortando.`);
      antiSpamMemory.recordTechnicalDiscard(mint, 'Sentinel: rota Jupiter nao confirmada no warm-up', 5);
      return;
    }

    // Liquidez robusta dispensa apenas a idade mínima; o teto de 90s permanece.
    const tokenAgeMs = Date.now() - token.createdAt.getTime();
    if (tokenAgeMs > SENTINEL_DIP_WINDOW_MAX_MS) {
      console.warn(
        `[SentinelHandoff] ${symbol}: token fora da janela do Graduation Dip ` +
        `(idade=${Math.round(tokenAgeMs / 1000)}s, janela=${SENTINEL_DIP_WINDOW_MIN_MS / 1000}s-${SENTINEL_DIP_WINDOW_MAX_MS / 1000}s). Abortando.`
      );
      return;
    }

    // Monta um TokenCandidate sintético compatível com o fluxo normal do Padrão Ouro
    // com isSentinelPreAudited = true para bypass do gate de maturidade de 5 minutos.
    const syntheticCandidate = {
      mint,
      symbol: marketSnapshot.symbol || symbol,
      name: marketSnapshot.symbol || symbol,
      priceUsd: marketSnapshot.priceUsd,
      liquidityUsd: marketSnapshot.liquidityUsd,
      volume24hUsd: 0,
      volume5mUsd: marketSnapshot.volume5mUsd,
      buysM5: marketSnapshot.buysM5,
      sellsM5: marketSnapshot.sellsM5,
      pairCreatedAt: token.createdAt.getTime(),
      dexId: marketSnapshot.dexId || 'raydium',
      priceChangeM5: undefined, // Sem dado de priceChangeM5 nesta janela nascente
      pairAddress: marketSnapshot.pairAddress,
      // Flag de bypass: token já foi auditado pelo Sentinel na bonding curve
      isSentinelPreAudited: true as const
    };

    console.log(
      `[SentinelHandoff] ${symbol}: candidato sintetico montado para execucao. ` +
      `liq=$${Math.round(syntheticCandidate.liquidityUsd)} | layaScore=${token.layaScore ?? 'N/D'} | age=${Math.round(tokenAgeMs / 1000)}s`
    );

    // Injeta o token diretamente no ciclo autônomo de entrada como candidato de alta prioridade.
    // O ciclo verifica: slots disponíveis, capital disponível, Sentinel macro, RugCheck,
    // AdaptiveSizer, Pump.fun route veto, Escada 4D — tudo do Padrão Ouro inalterado.
    // O único bypass aplicado é a dispensa do gate MATURITY_AGE (5-60min).
    await executeSentinelEntryCandidate(syntheticCandidate, token);
  } catch (err: any) {
    console.error(`[SentinelHandoff] ${symbol}: erro no handler de Graduation Dip: ${err?.message || err}`);
  } finally {
    sentinelActiveGraduations.delete(mint);
  }
}

/**
 * Executa a tentativa de entrada para um candidato pré-auditado pelo Sentinel.
 * Reutiliza a lógica de capital, sizing e execução Jupiter do ciclo normal,
 * com um gate MATURITY_AGE bypass explícito para tokens desta origem.
 */
async function executeSentinelEntryCandidate(
  topCandidate: {
    mint: string; symbol: string; name: string; priceUsd: number;
    liquidityUsd: number; volume24hUsd: number; volume5mUsd?: number;
    buysM5?: number; sellsM5?: number; pairCreatedAt: number; dexId: string;
    priceChangeM5?: number; pairAddress?: string; isSentinelPreAudited?: true;
  },
  sentinelToken: SentinelHandoffToken
): Promise<void> {
  // Guarda de concorrência: não abre nova posição se já no teto ou circuit breaker ativo
  if (executionUncertainReason) return;
  if (positionEngine.getAllPositions().length >= MAX_CONCURRENT_POSITIONS) {
    console.log(`[SentinelHandoff] ${topCandidate.symbol}: teto de concorrência atingido, pulando.`);
    return;
  }
  if (latestState.circuitBreakerActive) {
    console.log(`[SentinelHandoff] ${topCandidate.symbol}: circuit breaker ativo, pulando.`);
    return;
  }

  console.log(
    `[SentinelHandoff] Auditando ${topCandidate.symbol} via RugCheck ` +
    `(bypass MATURITY_AGE ativo — pre-auditado na bonding curve pelo Sentinel).`
  );

  // Auditoria completa via RugCheck + MemeRiskGatekeeper (sem bypass de risco — apenas de idade)
  const audit = await entryGatekeeper.auditToken({
    mint: topCandidate.mint,
    liquidityUsd: topCandidate.liquidityUsd,
    priceChangeM5: topCandidate.priceChangeM5,
    buysM5: topCandidate.buysM5,
    sellsM5: topCandidate.sellsM5,
    priceUsd: topCandidate.priceUsd
  });

  if (!audit.safe) {
    console.warn(`[SentinelHandoff] ${topCandidate.symbol}: vetado pela auditoria de risco: ${audit.reason}`);
    antiSpamMemory.recordVeto(topCandidate.mint, audit.reason || 'SentinelHandoff: veto RugCheck', 60 * 60 * 1000);
    return;
  }

  console.log(`[SentinelHandoff] ${topCandidate.symbol}: aprovado pelo RugCheck (score=${audit.score}). Dimensionando entrada...`);

  const balanceSol = await wallet.getBalanceSol();
  const activePositions = positionEngine.getAllPositions();
  const capitalPolicy = buildEquitySizingPolicy({
    cashBalanceSol: balanceSol,
    positions: activePositions.map(p => ({ costBasisSol: Math.max(0, p.entrySol || 0), executableValueSol: p.lastJupiterExecutableSolValue || p.entrySol })),
    maxPositions: MAX_CONCURRENT_POSITIONS,
    entryEquityPct: ENTRY_EQUITY_PCT,
    maxTotalAllocationPct: MAX_TOTAL_ALLOCATION_PCT,
    maxEntrySol: BUY_AMOUNT_SOL,
    maxTotalAllocationSol: MAX_TOTAL_ALLOCATION_SOL,
    minExecutableEntrySol: BUY_AMOUNT_SOL,
    gasReserveEquityPct: GAS_RESERVE_EQUITY_PCT,
    minGasReserveSol: MIN_GAS_RESERVE_SOL,
    maxGasReserveSol: MAX_GAS_RESERVE_SOL
  });

  if (!capitalPolicy.canOpenNextPosition) {
    console.log(`[SentinelHandoff] ${topCandidate.symbol}: capital insuficiente para nova entrada.`);
    return;
  }

  // Laya é advisory também na ponte Sentinel, mesmo configurada como LIVE/ACTIVE.
  if (SOLANA_LAYA_TACTICAL_MODE !== 'OFF' || process.env.SOLANA_LAYA_SHADOW_ENABLED === 'true') {
    scheduleEntryAdvisory({
      facts: audit.layaFacts,
      evaluate: facts => solanaLayaAdapter.evaluateEntry(facts),
      report: telemetry => console.log(
        `🧠 [Laya:Tactical:SHADOW:SENTINEL_ENTRY] ${topCandidate.symbol} ` +
        `status=${telemetry.status} action=${telemetry.action ?? 'N/D'} ` +
        `score=${telemetry.score ?? 'N/D'} error=${telemetry.error ?? 'none'}`
      )
    });
  }

  const quoteParams = {
    inputMint: SOL_MINT_GLOBAL,
    outputMint: topCandidate.mint,
    slippageBps: 750,
    autoSlippage: true,
    poolLiquidityUsd: topCandidate.liquidityUsd,
    maxAutoSlippageBps: 750,
    trafficPriority: priorityForJupiterWork('ENTRY_ORDER')
  };

  const sizing = await adaptiveSizer.findExecutableSize(quoteParams, {
    ladderSol: capitalPolicy.ladderSol,
    validate: async (_quote, sizeSol) => {
      try {
        const sim = await jupiterEngine.simulateSwap({
          inputMint: SOL_MINT_GLOBAL,
          outputMint: topCandidate.mint,
          amountLamports: Math.floor(sizeSol * 1e9),
          forbiddenProgramIds: [PUMP_PROGRAM_ID.toBase58()],
          autoSlippage: true,
          poolLiquidityUsd: topCandidate.liquidityUsd,
          maxAutoSlippageBps: 750,
          skipPreflight: false,
          userPublicKey: OFFICIAL_PHANTOM_WALLET,
          keypair: wallet.getKeypair(),
          priorityLevel: 'medium',
          trafficPriority: priorityForJupiterWork('ENTRY_ORDER')
        }, _quote);
        return sim.success ? null : (sim.error || 'SIMULATION_REJECTED');
      } catch (err: any) {
        return err?.message || 'excecao na simulacao pre-voo';
      }
    }
  });

  if (!sizing.success || !sizing.quote) {
    console.log(`[SentinelHandoff] ${topCandidate.symbol}: dimensionamento falhou — ${sizing.error || 'pool rasa'}.`);
    antiSpamMemory.recordTechnicalDiscard(topCandidate.mint, `Sentinel: sizing falhou: ${sizing.error || 'pool rasa'}`, 2);
    return;
  }

  // Migrated AMMs are eligible; only the explicit bonding curve program is forbidden.
  if (referencesProgram(sizing.quote.rawQuote?.routePlan, PUMP_PROGRAM_ID.toBase58())) {
    console.warn(`[SentinelHandoff] ${topCandidate.symbol}: contrato Bonding Curve vetado. Entrada abortada.`);
    return;
  }

  const dynamicAllocSol = sizing.sizeSol;
  const tradeLamports = Math.floor(dynamicAllocSol * 1e9);
  const traceId = randomUUID();
  console.log(
    `[SentinelHandoff] Executando swap Graduation Dip — ${topCandidate.symbol} | ` +
    `${dynamicAllocSol} SOL (${tradeLamports} lamports) | impact=${Math.abs(sizing.quote.priceImpactPct || 0).toFixed(3)}% | traceId=${traceId}`
  );

  const swapResult = await jupiterEngine.executeSwap({
    inputMint: SOL_MINT_GLOBAL,
    outputMint: topCandidate.mint,
    amountLamports: tradeLamports,
    forbiddenProgramIds: [PUMP_PROGRAM_ID.toBase58()],
    autoSlippage: true,
    poolLiquidityUsd: topCandidate.liquidityUsd,
    maxAutoSlippageBps: 750,
    skipPreflight: false,
    userPublicKey: OFFICIAL_PHANTOM_WALLET,
    keypair: wallet.getKeypair(),
    trafficPriority: priorityForJupiterWork('ENTRY_ORDER')
  });

  if (swapResult.status !== 'SUCCESS' && swapResult.status !== 'DRY_RUN_SUCCESS') {
    console.error(`[SentinelHandoff] ${topCandidate.symbol}: swap falhou — ${swapResult.error || swapResult.status}`);
    antiSpamMemory.recordVeto(topCandidate.mint, `Sentinel swap falhou: ${swapResult.status}`, 10 * 60 * 1000);
    return;
  }

  let managedAtomic = Math.trunc(swapResult.outAmount);
  if (!swapResult.isDryRun && swapResult.txSignature) {
    const actualDelta = await wallet.getReceivedTokenDeltaAtomic(swapResult.txSignature, topCandidate.mint);
    if (actualDelta) managedAtomic = assertAtomicAmountToNumber(actualDelta);
  }

  const nowTs = Date.now();
  const confirmedEntrySol = swapResult.inAmount / 1e9;

  // Registra a posição no PositionExitEngine com a Escada 4D completa do Padrão Ouro
  positionEngine.addPosition({
    mint: topCandidate.mint,
    symbol: topCandidate.symbol,
    tokenAmount: managedAtomic,
    entryPriceUsd: topCandidate.priceUsd,
    entrySol: confirmedEntrySol,
    stopLossPct: PositionExitEngine.DEFAULT_STOP_LOSS_PCT,
    takeProfitPct: PositionExitEngine.TP1_TRIGGER_PCT,
    entryTimestamp: nowTs,
    traceId,
    initialTokenAmount: managedAtomic,
    entryPairAddress: topCandidate.pairAddress
  });

  journal.logDecision({
    traceId,
    decision: 'ENTRY_APPROVED',
    compositeScore: audit.score,
    token: {
      mint: topCandidate.mint,
      tokenSymbol: topCandidate.symbol,
      poolAddress: topCandidate.pairAddress,
      ageMinutes: Math.round((nowTs - topCandidate.pairCreatedAt) / 60000),
      liquidityUsd: topCandidate.liquidityUsd,
      priceUsd: topCandidate.priceUsd,
      priceChange5mPct: topCandidate.priceChangeM5,
      volume5mUsd: topCandidate.volume5mUsd
    },
    market: { sentinelRegime: latestState.macroRegime as any || 'NEUTRAL_RANGING' },
    execution: { sizeSol: sizing.sizeSol, estimatedSlippagePct: 7.5 },
    gateEvaluations: [
      // MATURITY_AGE: bypass documentado — token pre-auditado na bonding curve pelo Sentinel
      DecisionLogger.evaluateGate('MATURITY_AGE', true, 0, 0),
      DecisionLogger.evaluateGate('RUG_CHECK', audit.safe, audit.score, 80, audit.reason || undefined),
      DecisionLogger.evaluateGate('LIQUIDITY_THRESHOLD', topCandidate.liquidityUsd >= 15000, topCandidate.liquidityUsd, 15000),
      DecisionLogger.evaluateGate('SLOT_AVAILABILITY', positionEngine.getAllPositions().length <= MAX_CONCURRENT_POSITIONS, positionEngine.getAllPositions().length, MAX_CONCURRENT_POSITIONS),
    ],
    metadata: {
      phase: 'ENTRY_EXECUTED',
      txSignature: swapResult.txSignature,
      isDryRun: swapResult.isDryRun,
      sentinelHandoff: true,
      layaScore: sentinelToken.layaScore,
      devWallet: sentinelToken.devWallet,
      graduationDipAgeMs: nowTs - sentinelToken.createdAt.getTime()
    }
  });

  console.log(
    `[SentinelHandoff] Posicao Graduation Dip aberta com sucesso: ${topCandidate.symbol} ` +
    `| ${managedAtomic} unidades atomicas | tx=${swapResult.txSignature || 'DRY_RUN'}`
  );
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
  console.log(`⚡ Ultra-Fast Exit Monitor: ${FAST_EXIT_INTERVAL_MS}ms (Jupiter executable + nonblocking Dex telemetry; profit protection SHADOW; confirmação)`);
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

  // Observatório Pump.fun: estritamente READ-ONLY. Não assina transações e não
  // altera a decisão de BUY/SELL nesta fase; apenas antecipa descoberta e mede timing.
  await pumpObservatory.start();
  latestState.pumpObservatory = pumpObservatory.snapshot();
  if (PUMP_OBSERVATORY_ENABLED) {
    console.log(
      `🧪 [Pump Observatory] ${latestState.pumpObservatory.running ? 'STREAM ATIVO' : 'STREAM INDISPONÍVEL'} ` +
      `| refresh=${PUMP_OBSERVATORY_REFRESH_MS}ms batch=${PUMP_OBSERVATORY_BATCH_SIZE} | READ-ONLY`
    );
    pumpDexTimingRuntime.start();
    console.log(
      `🧪 [Pump→Dex Timing] ativo | interval=${PUMP_DEX_TIMING_INTERVAL_MS}ms ` +
      `batch=${PUMP_DEX_TIMING_BATCH_SIZE} maxAge=${PUMP_DEX_TIMING_MAX_AGE_MS}ms`
    );
    if (PUMP_STRATEGY_LAB_ENABLED) {
      try {
        await pumpStrategyLabRuntime.restore();
        console.log(
          `📐 [Pump Strategy Lab] estado recuperado | samples=${pumpStrategyLabRuntime.snapshot().totalSamples}`
        );
      } catch (err: any) {
        console.warn(
          `⚠️ [Pump Strategy Lab] recuperação indisponível; iniciando coleta nova: ${err?.message || err}`
        );
      }
      pumpStrategyLabRuntime.start();
      console.log(
        `📐 [Pump Strategy Lab] SHADOW ativo | interval=${PUMP_STRATEGY_LAB_INTERVAL_MS}ms ` +
        `| entryModel=escada dinâmica da banca (fallback ${PUMP_STRATEGY_SHADOW_ENTRY_LAMPORTS} lamports) ` +
        `| slippageCap=750bps | priority=P6`
      );
    }
    pumpStateSyncTimer = setInterval(() => {
      latestState.pumpObservatory = pumpObservatory.snapshot();
      latestState.pumpStrategyLab = pumpStrategyLabRuntime.snapshot();
    }, 2_500);
    pumpStateSyncTimer.unref?.();
  } else {
    console.log('🧪 [Pump Observatory] desabilitado por configuração.');
  }
  setInterval(() => {
    runMaintenance(pgPool).catch(() => {});
  }, 24 * 60 * 60 * 1000);

  // 1. Reidratação da Quarentena do Banco (Fim da Amnésia pós-Deploy)
  await rehydrateQuarantineFromDbOnBoot();

  // 2. Reidratação On-Chain Imediata no Boot (protege ativos já comprados contra restart)
  await rehydratePositionsFromWalletOnBoot();

  if (NEXUS_MAINTENANCE_MODE) {
    console.warn(
      '🛠️ [MODO MANUTENÇÃO] Scanner, saídas automáticas e sweeps automáticos estão pausados. ' +
      'Dashboard, autenticação e liquidação manual permanecem disponíveis.'
    );
    return;
  }

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

  // 2.3 Ponte Sentinel Handoff: ingere tokens pré-auditados da bonding curve
  //     com bypass cirúrgico da trava de 5 minutos.
  await sentinelHandoffScanner.start();
  sentinelHandoffScanner.on('sentinelGraduationToken', (token: SentinelHandoffToken) => {
    void handleSentinelGraduationDip(token);
  });

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
  if (pumpStateSyncTimer) clearInterval(pumpStateSyncTimer);
  pumpDexTimingRuntime.stop();
  await pumpObservatory.stop();
  await journal.shutdown();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('🛑 [SIGINT] Encerrando serviço e esvaziando buffer do Decision Journal...');
  if (pumpStateSyncTimer) clearInterval(pumpStateSyncTimer);
  pumpDexTimingRuntime.stop();
  await pumpObservatory.stop();
  await journal.shutdown();
  process.exit(0);
});

main().catch(err => {
  console.error('❌ Falha fatal ao inicializar o agente:', err);
  process.exit(1);
});
