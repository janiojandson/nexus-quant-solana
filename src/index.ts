import { buildContractGates } from './audit/contractGates.js';
import { NonBlockingTelemetry } from './protection/nonBlockingTelemetry.js';
import { reportProfitProtectionShadow } from './protection/profitProtectionShadow.js';
import http from 'http';
import { PublicKey } from '@solana/web3.js';
import dotenv from 'dotenv';
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
import { createQuantHubs } from "./hubs/runtimeHubs.js";

import { PreFlightEngine } from "./execution/preflightEngine.js";
import { EntryAdmission } from './execution/entryAdmission.js';
import { PostgresPositionLedger, type LedgerPositionState } from './database/positionLedger.js';
import { validateConfirmedLiveExitEvidence, type ConfirmedWalletExitDelta } from './execution/confirmedLiveExitEvidence.js';
import { AdaptiveExitPoller } from './execution/adaptiveExitPoller.js';
import { commitShadowExitFromQuote } from './execution/shadowExitCommit.js';
import { JupiterDiscoveryScanner } from "./scanner/jupiterDiscoveryScanner.js";

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
import { resolveExecutionMode, readSigningSecretKey, isHypotheticalExecution } from './execution/executionMode.js';
import { referencesProgram } from './execution/entryRoutePolicy.js';
import { PUMP_PROGRAM_ID } from './pump/pumpBondingCurve.js';
import { ConfirmedPoolReader } from './pump/confirmedPoolReader.js';


dotenv.config();

const OFFICIAL_PHANTOM_WALLET = process.env.AGENT_SOLANA_PUBLIC_KEY || 'FBx2SKLDLsdeLM8owxU8MNVPKAfJpLpmpHHRgiZDqBoi';
const EXECUTION_MODE = resolveExecutionMode(process.env);
const IS_DRY_RUN = EXECUTION_MODE.shadow;
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
const ACTIVE_SOLANA_RPC_URL = 'https://mainnet.helius-rpc.com/'; // Hub-owned transport only.
const ENTRY_MOMENTUM_GATE_ENABLED = true; // Mandatory live momentum for conventional DEX entries.
const ENTRY_MOMENTUM_SAMPLES = Math.max(3, Number(process.env.ENTRY_MOMENTUM_SAMPLES || DEFAULT_ENTRY_MOMENTUM_CONFIG.samples));
const ENTRY_MOMENTUM_INTERVAL_MS = Math.max(250, Number(process.env.ENTRY_MOMENTUM_INTERVAL_MS || DEFAULT_ENTRY_MOMENTUM_CONFIG.intervalMs));
const ENTRY_MOMENTUM_MIN_RISE_PCT = Number(process.env.ENTRY_MOMENTUM_MIN_RISE_PCT || DEFAULT_ENTRY_MOMENTUM_CONFIG.minRisePct);
const ENTRY_MOMENTUM_MAX_RISE_PCT = Number(process.env.ENTRY_MOMENTUM_MAX_RISE_PCT || DEFAULT_ENTRY_MOMENTUM_CONFIG.maxRisePct);
const ENTRY_MOMENTUM_MAX_PULLBACK_PCT = Number(process.env.ENTRY_MOMENTUM_MAX_PULLBACK_PCT || DEFAULT_ENTRY_MOMENTUM_CONFIG.maxPullbackPct);

const SOLANA_LAYA_TACTICAL_MODE = 'OFF';
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
let pumpStateSyncTimer: ReturnType<typeof setInterval> | null = null;
const antiSpamMemory = new AntiSpamMemory(60); // Padrão 60 minutos
const positionEngine = new PositionExitEngine();
console.log('[RISK_POLICY] initialStopLossPct=' + PositionExitEngine.DEFAULT_STOP_LOSS_PCT + ' gateEvidenceVersion=2');
const exitPathHealth = new ExitPathHealth({
  emergencyFailures: PositionExitEngine.WATCHDOG_EMERGENCY_FAILURES
});

const {jupiterHub,rpcHub,connection:hubConnection}=createQuantHubs();

// Instâncias Globais dos Serviços Operacionais
const wallet = new SolanaWalletService({
  publicKey: OFFICIAL_PHANTOM_WALLET,
  secretKeyRaw: readSigningSecretKey(process.env),
  connection: hubConnection
});

const getExecutionSigner = () => resolveExecutionMode(process.env).canSign ? wallet.getKeypair() : undefined;
const rentRecovery = new RentRecoveryService(
  wallet.getConnection(), getExecutionSigner(), process.env,
  new PublicKey(wallet.getPublicKey())
);
const pumpObservatory = new PumpObservatory(
  wallet.getConnection() as unknown as PumpRpc,
  {
    enabled: false, // Sentinel owns observation subscriptions.
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


const shadowPreFlight = new PreFlightEngine(jupiterHub, rpcHub, OFFICIAL_PHANTOM_WALLET);
const physicalExitPoolReader = new ConfirmedPoolReader(rpcHub);
let entryAdmission: EntryAdmission;
const scanner = new JupiterDiscoveryScanner(jupiterHub);

const exitTelemetry = new NonBlockingTelemetry<any>();
// DEX e Sentinel agendam advisory separadamente; shadow nativo não atrasa os hard gates.
const entryGatekeeper = new MemeRiskGatekeeper({});
const layaPositionLastCheck = new Map<string, number>();
const layaPositionInFlight = new Set<string>();
/** Serializa qualquer liquidação por mint, independentemente da origem (hard gate, Laya ou manual). */
const exitOrderInFlight = new Set<string>();
/** Mints cujo /execute V2 ficou inconclusivo: bloqueia nova ordem até reinício/reconciliação. */
const uncertainExitMints = new Set<string>();
/** Circuit breaker em memória: impede novas entradas após uma execução V2 inconclusiva. */
let executionUncertainReason: string | null = null;

const jupiterEngine = new JupiterExecutionEngine({
  connection: hubConnection,
  jupiterHub,
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
const positionLedger = new PostgresPositionLedger(pgPool, position => {
  if (!position.mint || !position.traceId || position.status === 'FULLY_CLOSED') return;
  restoreShadowPosition(position);
});
entryAdmission = new EntryAdmission(shadowPreFlight, IS_DRY_RUN ? positionLedger : undefined);
const pumpStrategyRepository = new PumpStrategyRepository(pgPool as any);
let latestShadowEntryLadderLamports = [PUMP_STRATEGY_SHADOW_ENTRY_LAMPORTS];
const pumpStrategyLabRuntime = new PumpStrategyLabRuntime(
  pumpObservatory,
  jupiterEngine.getAggregator(),
  pumpStrategyRepository,
  {
    enabled: false, // Standalone Jupiter quote research has no financial quota allocation.
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
const sentinelHandoffScanner = new SentinelHandoffScanner(pgPool, { rpcHub });
const journal = new DecisionLogger(pgPool, {
  flushIntervalMs: 5000,
  maxBufferSize: 100
});

function restoreShadowPosition(state: LedgerPositionState): void {
  if (!state.mint || !state.traceId || !state.tokenAmount || state.status === 'FULLY_CLOSED') return;
  positionEngine.addPosition({
    mint: state.mint, symbol: state.symbol || state.mint,
    tokenAmount: state.tokenAmount, initialTokenAmount: state.initialTokenAmount,
    entryPriceUsd: state.entryPriceUsd || 0,
    entryTimestamp: state.entryTimestamp || Date.now(),
    entrySol: state.remainingCostSol, entrySolValue: state.initialCapitalSol,
    entryLiquidityUsd: state.entryLiquidityUsd,
    entryPhysicalSolLamports: state.entryPhysicalSolLamports,
    entryPairAddress: state.entryPairAddress,
    traceId: state.traceId, accountingMode: 'SHADOW',
    highestTpStepReached: state.highestTpStepReached,
    partialTaken: state.highestTpStepReached >= 1,
    stopLossPct: state.stopLossPct,
    peakSolValue: state.executablePeakSolValue,
    executablePeakSolValue: state.executablePeakSolValue,
    observablePeakSolValue: state.observablePeakSolValue,
    lastJupiterExecutableSolValue: state.lastJupiterExecutableSolValue,
    lastHealthyExitRouteAt: state.lastHealthyExitRouteAt
  });
}

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
  sentinelHandoffQueue: 0,
  agent: 'NEXUS_QUANT_SOLANA_V1',
  wallet: OFFICIAL_PHANTOM_WALLET,
  balanceSol: 0,
  initialDepositSol: 0.3133,
  vitalityState: 'NORMAL',
  dryRun: IS_DRY_RUN,
  maintenanceMode: NEXUS_MAINTENANCE_MODE,
  macroRegime: 'NOT_APPLICABLE',
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


let rentRecoverySweepInFlight = false;
async function runRentRecoverySweep(source: 'AUTO' | 'MANUAL'): Promise<Awaited<ReturnType<RentRecoveryService['sweepOrphanAccounts']>>> {
  if (rentRecoverySweepInFlight) {
    throw new Error('Varredura de rent já está em execução.');
  }
  if (!resolveExecutionMode(process.env).canBroadcast ||
      (source === 'AUTO' && !AUTO_RENT_RECOVERY_ENABLED)) {
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

if (AUTO_RENT_RECOVERY_ENABLED && EXECUTION_MODE.canBroadcast && !NEXUS_MAINTENANCE_MODE) {
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
  if (pos.accountingMode === 'SHADOW') {
    return { success: false, error: 'SHADOW position has no signed or broadcast exit transport.' };
  }

  const tokenAmountToSell = options?.exitTokenAmount || pos.tokenAmount;
  const isPartial = exitReason === 'PARTIAL_TAKE_PROFIT_50';
  const shouldCloseAta = options?.shouldCloseAta ?? !isPartial;
  const trafficPriority = options?.trafficPriority ?? priorityForJupiterWork('PROTECTIVE_EXIT');
  const initialSlippageBps = Math.min(750, Math.max(250, options?.initialSlippageBps ?? 500));
  if (!pos.traceId || !Number.isFinite(pos.entrySolValue) || (pos.entrySolValue ?? 0) <= 0 ||
      !Number.isFinite(pos.entrySol) || (pos.entrySol ?? 0) <= 0 ||
      !Number.isSafeInteger(pos.initialTokenAmount) || (pos.initialTokenAmount ?? 0) <= 0) {
    return { success: false, error: 'LIVE_POSITION_ACCOUNTING_PROOF_MISSING' };
  }

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

  try {
    await positionLedger.assertLiveExitReady(pos.traceId, pos.tokenAmount);
  } catch (error) {
    executionUncertainReason = `LIVE ledger unavailable for ${pos.mint}: ${error instanceof Error ? error.message : String(error)}`;
    uncertainExitMints.add(pos.mint);
    return { success: false, error: executionUncertainReason };
  }

  console.log(`🚨 [EXECUÇÃO DE SAÍDA ON-CHAIN] ${pos.symbol} (${pos.mint}) | Motivo: ${exitReason} | Lote: ${exitAmountAtomic} (atomic) | PnL: ${(pnlPct * 100).toFixed(2)}%`);
  console.log(`⚡ [Jupiter Swap V2] Saída com slippage ${initialSlippageBps}bps e landing gerenciado...`);

  // 1. Swap Jupiter V2 — /order + assinatura local + /execute gerenciado
  const exitAttemptStartedAt = Date.now();
  let reconciledLiveEvidence: ConfirmedWalletExitDelta | null = null;
  let exitSwap: RoutedExitAttempt = await jupiterEngine.executeSwap({
    inputMint: pos.mint,
    outputMint: 'So11111111111111111111111111111111111111112', // SOL
    amountLamports: exitAmountAtomic,
    userPublicKey: OFFICIAL_PHANTOM_WALLET,
    keypair: getExecutionSigner(),
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
      keypair: getExecutionSigner(),
      slippageBps: 750,
      priorityLevel: 'veryHigh',
      skipPreflight: false,
      trafficPriority
    });

    if (exitSwap.status === 'SUCCESS' && !isHypotheticalExecution(exitSwap)) {
      console.log(`✅ [TENTATIVA 2 SUCESSO] ${pos.symbol}: Liquidação V2 confirmada com slippage 750bps`);
    } else if (isHypotheticalExecution(exitSwap)) {
      console.log(`[SHADOW] ${pos.symbol}: tentativa 2 hipotética, sem liquidação confirmada`);
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
        reconciledLiveEvidence = reconciled;
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
          userPublicKey: new (await import('@solana/web3.js')).PublicKey(wallet.getPublicKey()),
          userKeypair: getExecutionSigner(),
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
        userKeypair: getExecutionSigner(),
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
      exitSwap.status === 'SUCCESS'
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

  if (isHypotheticalExecution(exitSwap)) {
    return { success: false, txSignature: '', error: 'Hypothetical shadow exit; position and rent remain unchanged.' };
  }

  // 2. Fail-Closed na Saída: só prossegue com higiene on-chain e books se o swap
  // foi de fato confirmado. Sem esta trava, uma saída falha fechava a ATA
  // (prendendo os tokens), gravava PnLperformed fictício e notificava "Saída Executada".
  const exitConfirmed = exitSwap.status === 'SUCCESS';

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
      market: { sentinelRegime: (latestState.macroRegime as any) || 'NOT_APPLICABLE' },
      execution: { sizeSol: exitSolValue },
      gateEvaluations: [],
      rejectionReason: `EXIT_SWAP_FAILED: ${failReason}`,
      metadata: { phase: 'EXIT', exitReason, tokenAmountToSell }
    });

    updateDashboardViews();
    return { success: false, txSignature: '', error: failReason };
  }

  const exitTypeMap: Record<string, DecisionType> = {
    STOP_LOSS: 'EXIT_SL', PARTIAL_TAKE_PROFIT_50: 'EXIT_PARTIAL',
    TRAILING_STOP: 'EXIT_TRAILING', TIME_STOP: 'EXIT_TIME_STOP',
    MANUAL: 'EXIT_PANIC', TAKE_PROFIT: 'EXIT_PARTIAL',
    LAYA_EXIT: 'EXIT_LAYA', WATCHDOG_EXIT: 'EXIT_WATCHDOG'
  };
  let confirmedFill;
  let durableLiveFill;
  try {
    const evidence = reconciledLiveEvidence?.signature === exitSwap.txSignature
      ? reconciledLiveEvidence
      : await wallet.findRecentTokenDeltaTransaction(pos.mint, exitAttemptStartedAt, 'OUT');
    confirmedFill = validateConfirmedLiveExitEvidence(evidence, exitSwap.txSignature, exitAmountAtomic);
    durableLiveFill = await positionLedger.appendConfirmedLiveFill({
      traceId: pos.traceId, mint: pos.mint, ...confirmedFill,
      initialCapitalSol: pos.entrySolValue!, initialTokenAmount: pos.initialTokenAmount!,
      entryPriceUsd: pos.entryPriceUsd, entryTimestamp: new Date(pos.entryTimestamp),
      exitPriceUsd: pos.entryPriceUsd * (1 + pnlPct),
      exitReason: exitTypeMap[exitReason] || 'EXIT_WATCHDOG',
      nextStep: isPartial ? (pos.highestTpStepReached ?? 0) + 1 : (pos.highestTpStepReached ?? 0),
      isFull: !isPartial
    });
  } catch (error) {
    executionUncertainReason = `LIVE confirmed exit needs reconciliation for ${pos.mint}: ${error instanceof Error ? error.message : String(error)}`;
    uncertainExitMints.add(pos.mint);
    console.error(`🛑 [LIVE EXIT LEDGER UNCERTAIN] ${executionUncertainReason}`);
    return { success: false, txSignature: exitSwap.txSignature, error: executionUncertainReason };
  }
  if (!durableLiveFill.applied) {
    executionUncertainReason = `LIVE fill ${confirmedFill.fillId} already committed; reload position before further exits`;
    uncertainExitMints.add(pos.mint);
    return { success: false, txSignature: confirmedFill.fillId, error: executionUncertainReason };
  }

  const tokenAmountBefore = pos.tokenAmount;
  const soldRatio = Math.min(1, Math.max(0, confirmedFill.soldAtomic / tokenAmountBefore));
  const costBasisSoldSol = pos.entrySol! * soldRatio;
  const actualExitSolValue = confirmedFill.receivedLamports / 1e9;
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
    const committed = positionEngine.commitPartialExit(pos.mint, confirmedFill.soldAtomic, impliedFullPositionSolValue);
    if (!committed || pos.tokenAmount !== durableLiveFill.remainingTokenAmount ||
        pos.highestTpStepReached !== durableLiveFill.highestTpStepReached) {
      console.error(`❌ [CONSISTÊNCIA] Swap parcial confirmou, mas o estado local não conseguiu aplicar a redução de ${exitAmountAtomic} unidades em ${pos.symbol}.`);
      executionUncertainReason = `LIVE local position mismatch after durable fill ${confirmedFill.fillId}`;
      uncertainExitMints.add(pos.mint);
      return { success: false, txSignature: confirmedFill.fillId, error: executionUncertainReason };
    }
    pos.entrySol = durableLiveFill.remainingCostSol;
    pos.stopLossPct = durableLiveFill.stopLossPct;
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
        console.log(`🧹 [Higiene On-Chain] Conta ATA de ${pos.symbol} encerrada; recuperação de rent não creditada sem delta confirmado separado.`);
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

  // O ledger LIVE já aplicou o fill imutável e o outcome cumulativo em uma transação.

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
  // Laya logic removed
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
        keypair: getExecutionSigner(),
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
        return { success: false, hypothetical: true, simulated: true,
          error: 'Hypothetical shadow liquidation; holding remains unchanged.' };
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
      if (!resolveExecutionMode(process.env).canBroadcast) {
        return { success: false, error: 'Hypothetical shadow mode: no token was liquidated and no rent was recovered.' };
      }
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
          keypair: getExecutionSigner(),
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
      if (!resolveExecutionMode(process.env).canBroadcast) {
        return { success: false, liquidationsCount: 0,
          error: 'Hypothetical shadow mode: no tokens were liquidated and no rent was recovered.' };
      }
      console.log('🚨 [API PANIC ALL] Desarmando Sentinel, liquidando todos os tokens e fechando ATAs...');
      latestState.circuitBreakerActive = true;

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
            keypair: getExecutionSigner(),
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
async function runUltraFastExitMonitor(onlyMint: string) {
  if (NEXUS_MAINTENANCE_MODE) return;

  try {
    const openPositions = positionEngine.getAllPositions().filter(p => p.mint === onlyMint).sort((a, b) => {
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
      if (uncertainExitMints.has(pos.mint)) continue;
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
        // Read the physical vault state alongside the executable quote. RPC
        // absence is unknown, never a fabricated USD liquidity value.
        const physicalSnapshotPromise = pos.accountingMode === 'SHADOW'
          ? physicalExitPoolReader.read(pos.mint, pos.entryPairAddress ? [pos.entryPairAddress] : [])
          : Promise.resolve(null);
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
        const physicalSnapshot = await physicalSnapshotPromise;
        const physicalReservoirDrained = physicalSnapshot?.ok === false
          ? physicalSnapshot.code === 'INSUFFICIENT_PHYSICAL_SOL'
          : false;
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
        if (pos.accountingMode === 'SHADOW') {
          const watermarks = positionEngine.getExitWatermarks(pos.mint);
          try {
            await positionLedger.updateShadowWatermarks(pos.traceId!, {
              executablePeakSolValue: watermarks.executablePeakSolValue,
              observablePeakSolValue: watermarks.observablePeakSolValue,
              lastJupiterExecutableSolValue: currentSolValue,
              lastHealthyExitRouteAt: watermarks.lastHealthyExitRouteAt || Date.now()
            });
          } catch (error) {
            uncertainExitMints.add(pos.mint);
            executionUncertainReason = `SHADOW watermark persistence unavailable for ${pos.mint}`;
            console.error(`[SHADOW_WATERMARK_UNCERTAIN] ${pos.mint}:`, error);
            continue;
          }
        }
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
        const earlyTrailingActive = false;
        const activeTrailingDistance = PositionExitEngine.TRAILING_DISTANCE;
        const trailingStopSolValue = peakSolValue * (1 - activeTrailingDistance);
        const trailPnlPct = (trailingStopSolValue - entrySol) / entrySol;
        const trailingStatus = (pos.highestTpStepReached ?? 0) >= 2 ? 'ATIVO' : 'INATIVO';
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
        const partialLabel = pos.partialTaken ? ' [RUNNER]' : '';

        // Exibição clara e não ambígua do status de proteção.
        const stopStatusText = (pos.highestTpStepReached ?? 0) >= 2
          ? `Stop Ativo: Trailing Dinâmico (-10% do Topo: ${trailPnlPct >= 0 ? '+' : ''}${(trailPnlPct * 100).toFixed(2)}%)`
          : `Stop Ativo: Piso Fixo (${(pos.stopLossPct * 100).toFixed(2)}%) | Trailing: INATIVO`;

        console.log(`🟡 [SNIPER ATIVO${partialLabel}] Token: ${pos.symbol} | Sensor PnL: ${pnlSign}${(pnlPct * 100).toFixed(2)}% | Pico: ${peakSign}${(peakPnlPct * 100).toFixed(2)}% | ${stopStatusText} | Tempo: ${elapsedMin}min`);

        // Propaga o estado real de proteção para o painel. Sem isto a coluna
        // "Trailing Stop" ficava em INATIVO mesmo com o trailing ativo.
        pos.trailingActive = (pos.highestTpStepReached ?? 0) >= 2;
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
            physicalReservoirDrained,
            currentLiquidityUsd: pos.accountingMode === 'SHADOW' ? undefined : marketSnapshot?.liquidityUsd,
            currentVolume5m: marketSnapshot?.volume5mUsd
          }
        );

        if (!exitSignal.shouldExit || exitSignal.type === 'HOLD') {
          if (pos.accountingMode !== 'SHADOW') persistPeakWatermark(pos, positionEngine.getPeakSolValue(pos.mint));
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
          if (pos.accountingMode === 'SHADOW') {
            try {
              await commitShadowExitFromQuote({ position: {
                mint: pos.mint, traceId: pos.traceId!, tokenAmount: pos.tokenAmount,
                highestTpStepReached: pos.highestTpStepReached,
                executablePeakSolValue: pos.executablePeakSolValue,
                observablePeakSolValue: pos.observablePeakSolValue,
                lastJupiterExecutableSolValue: pos.lastJupiterExecutableSolValue,
                lastHealthyExitRouteAt: pos.lastHealthyExitRouteAt
              }, exitTokenAmount: assertStoredAtomicNumberToNumber(exitSignal.exitTokenAmount || pos.tokenAmount),
              monitorQuote: executableQuote, quoteAt: exitQuoteRequestedAt, now: Date.now,
              getQuote: () => jupiterEngine.getQuote(pos.mint,
                'So11111111111111111111111111111111111111112',
                assertStoredAtomicNumberToNumber(exitSignal.exitTokenAmount || pos.tokenAmount),
                500, priorityForJupiterWork('PROTECTIVE_EXIT')),
              persist: fill => positionLedger.appendExitFill(fill),
              apply: result => {
                if (result.position.status === 'FULLY_CLOSED') positionEngine.removePosition(pos.mint);
                else restoreShadowPosition(result.position);
              } });
            } catch (error) {
              uncertainExitMints.add(pos.mint);
              executionUncertainReason = `SHADOW ledger commit uncertain for ${pos.mint}; reconcile before another fill.`;
              console.error(`[SHADOW_EXIT_UNCERTAIN] ${pos.mint}:`, error);
            }
          } else {
            await executeExitOrder(pos.mint, exitSignal.type, pnlPct, currentSolValue, {
              exitTokenAmount: exitSignal.exitTokenAmount,
              shouldCloseAta: exitSignal.shouldCloseAta
            });
          }

          // Se a posição permaneceu aberta (parcial confirmada ou saída falhou),
          // persiste o watermark já ajustado ao lote/custo remanescente.
          const remainingPosition = positionEngine.getPosition(pos.mint);
          if (remainingPosition) {
            const partialWasCommitted =
              exitSignal.type === 'PARTIAL_TAKE_PROFIT_50' && remainingPosition.partialTaken === true;
            if (remainingPosition.accountingMode !== 'SHADOW') persistPeakWatermark(
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
    // The poller owns the per-mint in-flight guard.
  }
}

const adaptiveExitPoller = new AdaptiveExitPoller(Date.now,
  async mint => runUltraFastExitMonitor(mint), event => {
    if (event.outcome === 'ERROR' || event.latencyMs > 2500)
      console.warn(`[ExitPoll] ${event.mint} ${event.outcome} latency=${event.latencyMs}ms ${event.error || ''}`);
  });

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

        const meta = { symbol: spl.mint.slice(0, 5) };
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

    // Macro Sentinel was retired. A local panic breaker still pauses entries.
    latestState.macroRegime = 'NOT_APPLICABLE';
    if (latestState.circuitBreakerActive) return;

    const discovered = await scanner.scanTrendingCandidates();
    latestState.incubator = { waiting: 0, mature: discovered.length,
      technicalDiscards: 0, entryEligible: 0 };
    for (const token of discovered.slice(0, 3)) {
      if (!token.symbol || !token.name || token.priceUsd === null ||
          token.liquidityUsd === null || !token.pairAddress) {
        antiSpamMemory.recordTechnicalDiscard(token.mint, 'DADOS_INSUFICIENTES', 0.05);
        latestState.incubator.technicalDiscards++;
        continue;
      }
      const classification = TokenClassifier.classify(token.mint, token.symbol, token.liquidityUsd);
      if (!classification.isEligibleForMemeScan || antiSpamMemory.shouldSkip(token.mint).skip) continue;
      latestState.incubator.entryEligible++;
      const candidate = { mint: token.mint, symbol: token.symbol, name: token.name,
        priceUsd: token.priceUsd, liquidityUsd: token.liquidityUsd, pairAddress: token.pairAddress };
      const stakeLamports = latestShadowEntryLadderLamports[0];
      if (!Number.isSafeInteger(stakeLamports) || stakeLamports <= 0) continue;
      let securityAudit: Awaited<ReturnType<typeof entryGatekeeper.auditToken>> | undefined;
      const decision = await entryAdmission.attempt({ candidate, stakeLamports,
        availableLamports: Math.floor(balanceSol * 1e9),
        reservedGasLamports: Math.ceil(capitalPolicy.gasReserveSol * 1e9),
        poolHints: [token.pairAddress],
        verifySecurity: async facts => {
          // Security still requires contract and pool facts from RugCheck. Historic M5
          // windows are not reused as a second momentum decision.
          securityAudit = await entryGatekeeper.auditToken({ mint: facts.mint,
            pairAddress: facts.pairAddress, liquidityUsd: facts.liquidityUsd,
            priceUsd: facts.priceUsd });
          return { safe: securityAudit.safe, reason: securityAudit.reason };
        } });
      if (!decision.accepted) {
        const durableSecurityVeto = securityAudit?.safe === false &&
          securityAudit.rugCheckReport?.factsComplete === true;
        if (durableSecurityVeto) antiSpamMemory.recordVeto(token.mint, decision.reason, 24 * 60 * 60 * 1000);
        else antiSpamMemory.recordTechnicalDiscard(token.mint, decision.reason, 0.05);
        journal.logDecision({ traceId: randomUUID(), decision: 'ENTRY_REJECTED',
          token: { mint: token.mint, tokenSymbol: token.symbol,
            poolAddress: token.pairAddress, liquidityUsd: token.liquidityUsd,
            priceUsd: token.priceUsd }, market: { sentinelRegime: null }, gateEvaluations: [],
          rejectionReason: decision.reason, metadata: { phase: 'TYPED_4D_PREFLIGHT',
            macroStatus: 'NOT_APPLICABLE', accountingMode: 'SHADOW' } });
        continue;
      }
      journal.logDecision({ traceId: decision.receipt.traceId, decision: 'ENTRY_APPROVED',
        token: { mint: token.mint, tokenSymbol: token.symbol,
          poolAddress: token.pairAddress, liquidityUsd: token.liquidityUsd,
          priceUsd: token.priceUsd }, market: { sentinelRegime: null }, gateEvaluations: [],
        metadata: { phase: 'DURABLE_SHADOW_ENTRY',
          entryIntentId: decision.receipt.entryIntentId, accountingMode: 'SHADOW' } });
      break;
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
  remainingTokenAmountAtomic: number;
  remainingCostSol: number;
  highestTpStepReached: number;
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
          o.entry_timestamp, o.status, o.accounting_mode, o.initial_capital_sol,
          o.remaining_cost_sol, o.remaining_token_amount, o.highest_tp_step, o.stop_loss_pct,
          o.peak_sol_value,
          o.observable_peak_sol_value, o.executable_peak_sol_value,
          o.last_jupiter_executable_sol_value, o.last_healthy_exit_route_at
        FROM decision_journal dj
        JOIN trade_outcomes o ON o.trace_id = dj.trace_id
        WHERE dj.decision = 'ENTRY_APPROVED'
          AND dj.metadata->>'phase' = 'ENTRY_EXECUTED'
          AND COALESCE(dj.metadata->>'txSignature', '') <> ''
          AND COALESCE(dj.metadata->>'isDryRun', 'false') = 'false'
          AND o.accounting_mode = 'LIVE'
        ORDER BY dj.mint, dj.created_at DESC
      )
      SELECT * FROM latest WHERE status IN ('OPEN', 'PARTIAL_CLOSED')
    `);

    for (const row of res.rows) {
      try {
        const metadata = row.metadata || {};
        const initialAtomic = assertAtomicAmountToNumber(String(metadata.outAmountAtomic || ''));
        if (row.status === 'PARTIAL_CLOSED' &&
            (row.initial_capital_sol == null || row.remaining_cost_sol == null ||
             row.remaining_token_amount == null)) throw new Error('LEGACY_PARTIAL_REQUIRES_RECONCILIATION');
        const remainingAtomic = row.remaining_token_amount == null ? initialAtomic :
          assertAtomicAmountToNumber(String(row.remaining_token_amount));
        if (remainingAtomic > initialAtomic) throw new Error('RECOVERY_AMOUNT_EXCEEDS_INITIAL');
        positions.set(row.mint, {
          traceId: String(row.trace_id),
          mint: String(row.mint),
          symbol: String(row.token_symbol || `${String(row.mint).slice(0, 4)}...${String(row.mint).slice(-4)}`),
          entryPriceUsd: Number(row.entry_price_usd),
          entrySizeSol: Number(row.initial_capital_sol ?? row.entry_size_sol),
          entryTimestamp: new Date(row.entry_timestamp).getTime(),
          initialTokenAmountAtomic: initialAtomic,
          remainingTokenAmountAtomic: remainingAtomic,
          remainingCostSol: Number(row.remaining_cost_sol ?? row.entry_size_sol),
          highestTpStepReached: Number(row.highest_tp_step ?? 0),
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
          stopLossPct: Number(row.stop_loss_pct ?? metadata.stopLossPct ?? PositionExitEngine.DEFAULT_STOP_LOSS_PCT),
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

      // Nunca adota unidades adicionadas manualmente; partial é o saldo durável
      // do fill confirmado, não uma fração presumida da entrada original.
      const expectedCapAtomic = recovery.remainingTokenAmountAtomic;
      const managedAtomic = Math.min(currentAtomic, expectedCapAtomic);
      if (managedAtomic <= 0) continue;

      const remainingRatio = managedAtomic / recovery.remainingTokenAmountAtomic;
      const remainingEntrySol = recovery.remainingCostSol * remainingRatio;
      const effectiveStopLossPct = recovery.stopLossPct;

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
        partialTaken: recovery.partialTaken,
        highestTpStepReached: recovery.highestTpStepReached
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
// PONTE SENTINEL HANDOFF — prova física e preflight pendente
// ============================================================
// O scanner só emite uma pool fisicamente confirmada. O índice aguarda
// metadados de mercado verificáveis da Task 3 antes de tentar entrada.
// ============================================================

const SOL_MINT_GLOBAL = 'So11111111111111111111111111111111111111112';
const sentinelActiveGraduations = new Set<string>(); // Impede processamento duplo do mesmo mint

async function handleSentinelGraduationDip(token: SentinelHandoffToken): Promise<void> {
  const { mint, symbol, leaseId, poolEvidence } = token;
  if (sentinelActiveGraduations.has(mint)) return;
  sentinelActiveGraduations.add(mint);
  latestState.sentinelHandoffQueue = sentinelActiveGraduations.size;
  try {
    await token.assertLeaseActive();
    if (poolEvidence?.kind !== 'PHYSICAL_POOL_CONFIRMED') {
      await sentinelHandoffScanner.release(mint, leaseId, 'INVALID_POOL_PROOF');
      return;
    }
    const discovered = await scanner.fetchCandidate(mint, token.leaseSignal);
    await token.assertLeaseActive();
    if (!discovered?.symbol || !discovered.name || discovered.priceUsd === null ||
        discovered.liquidityUsd === null) {
      await sentinelHandoffScanner.release(mint, leaseId, 'DADOS_INSUFICIENTES');
      return;
    }
    if (executionUncertainReason || latestState.circuitBreakerActive ||
        positionEngine.getAllPositions().length >= MAX_CONCURRENT_POSITIONS ||
        !exitPathHealth.snapshot().canOpenNewPosition) {
      await sentinelHandoffScanner.release(mint, leaseId, 'ENTRY_CAPACITY_UNAVAILABLE');
      return;
    }
    const balanceSol = await wallet.getBalanceSol();
    await token.assertLeaseActive();
    const activePositions = positionEngine.getAllPositions();
    const capitalPolicy = buildEquitySizingPolicy({
      cashBalanceSol: balanceSol,
      positions: activePositions.map(p => ({ costBasisSol: Math.max(0, p.entrySol || 0),
        executableValueSol: p.lastJupiterExecutableSolValue || p.entrySol })),
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
    if (!capitalPolicy.canOpenNextPosition || !capitalPolicy.ladderSol.length) {
      await sentinelHandoffScanner.release(mint, leaseId, 'ENTRY_CAPITAL_UNAVAILABLE');
      return;
    }
    const stakeLamports = Math.floor(capitalPolicy.ladderSol[0] * 1e9);
    const candidate = { mint, symbol: discovered.symbol, name: discovered.name,
      priceUsd: discovered.priceUsd, liquidityUsd: discovered.liquidityUsd,
      pairAddress: poolEvidence.poolAddress };
    const decision = await entryAdmission.attempt({ candidate, stakeLamports,
      availableLamports: Math.floor(balanceSol * 1e9),
      reservedGasLamports: Math.ceil(capitalPolicy.gasReserveSol * 1e9),
      poolHints: [poolEvidence.poolAddress, ...token.poolHints],
      signal: token.leaseSignal,
      lease: { mint, leaseId, sourceEventAt: token.createdAt.toISOString(),
        assertLeaseActive: token.assertLeaseActive },
      verifySecurity: async facts => {
        const audit = await entryGatekeeper.auditToken({ mint: facts.mint,
          pairAddress: facts.pairAddress, liquidityUsd: facts.liquidityUsd,
          priceUsd: facts.priceUsd });
        return { safe: audit.safe, reason: audit.reason };
      } });
    await token.assertLeaseActive();
    if (!decision.accepted) {
      await sentinelHandoffScanner.release(mint, leaseId, decision.reason);
      return;
    }
    // Acknowledgement is fenced and only follows a durable SHADOW entry receipt.
    await token.assertLeaseActive();
    if (!await sentinelHandoffScanner.acknowledgeAccepted(mint, leaseId))
      console.warn(`[SentinelHandoff] ${symbol}: durable registration complete, ACK failed.`);
  } catch (error) {
    const reason = token.leaseSignal.aborted ||
      (error instanceof Error && error.message === 'LEASE_LOST')
      ? 'LEASE_LOST' : 'HANDOFF_PROCESSING_FAILED';
    await sentinelHandoffScanner.release(mint, leaseId, reason);
  } finally {
    sentinelActiveGraduations.delete(mint);
    latestState.sentinelHandoffQueue = sentinelActiveGraduations.size;
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

  if (IS_DRY_RUN) {
    try {
      for (const state of await positionLedger.readOpenShadowPositions()) restoreShadowPosition(state);
    } catch (error) {
      executionUncertainReason = `SHADOW ledger unavailable: ${error instanceof Error ? error.message : String(error)}`;
      console.error(`[SHADOW_LEDGER_UNAVAILABLE] ${executionUncertainReason}`);
    }
  }

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
  if (resolveExecutionMode(process.env).canBroadcast) {
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
      if (resolveExecutionMode(process.env).canBroadcast) {
        rentRecovery.sweepOrphanAccounts().catch(() => {});
      }
    }, 2 * 60 * 60 * 1000);
  }

  // 2.3 Ponte Sentinel Handoff: ingere tokens pré-auditados da bonding curve
  //     com bypass cirúrgico da trava de 5 minutos.
  await sentinelHandoffScanner.start();
  sentinelHandoffScanner.on('sentinelGraduationToken', handleSentinelGraduationDip);

  // 3. One position: 1.5s. Two positions: 2.5s each, staggered 1.25s.
  setInterval(() => {
    try { adaptiveExitPoller.tick(positionEngine.getAllPositions().map(p => p.mint)); }
    catch (error) { console.error('[ExitPoll] scheduler rejected positions:', error); }
  }, 250);

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
