import { renderJournalSection } from './dashboardJournal.js';
import type { PumpObservatorySnapshot } from '../pump/pumpObservatory.js';

export interface ClosedTradeView {
  mint: string;
  symbol: string;
  tokenAmount: number;
  entryPriceUsd: number;
  exitPriceUsd: number;
  entryTimestamp: number;
  exitTimestamp: number;
  pnlPct: number;
  pnlSolEst: number;
  exitReason: 'TAKE_PROFIT' | 'PARTIAL_TAKE_PROFIT_50' | 'STOP_LOSS' | 'TRAILING_STOP' | 'TIME_STOP' | 'MANUAL' | 'LAYA_EXIT' | 'WATCHDOG_EXIT' | 'HOLD';
  txSignature?: string;
  dexScreenerUrl: string;
  solscanUrl: string;
  /** badge de origem — adicionado pelo handler Sentinel Handoff */
  isSentinelHandoff?: boolean;
}

export interface WalletHoldingView {
  mint: string;
  symbol: string;
  tokenAmount: number;
  decimals: number;
  ataAddress: string;
  solscanUrl: string;
  dexScreenerUrl: string;
}

export interface DashboardState {
  agent: string;
  wallet: string;
  balanceSol: number;
  initialDepositSol: number;
  vitalityState: string;
  dryRun: boolean;
  maintenanceMode?: boolean;
  macroRegime: string;
  circuitBreakerActive: boolean;
  activeRpcUrl: string;
  totalRealizedPnlSol: number;
  totalNetworkFeesSolEst: number;
  auth?: {
    configured: boolean;
    needsBootstrap: boolean;
  };
  rentRecovery?: {
    autoEnabled: boolean;
    intervalMs: number;
    inFlight: boolean;
    lastRunAt?: string;
    lastClosedCount: number;
    lastReclaimedSolEst: number;
    lastReclaimedSolActual: number;
    totalClosedCount: number;
    totalReclaimedSolEst: number;
    totalReclaimedSolActual: number;
    lastErrors: string[];
  };
  laya?: {
    tacticalMode: string;
    privateService: boolean;
    health: 'OK' | 'DEGRADED' | 'UNKNOWN';
    loaded: string[];
    latencyMs?: number;
    lastCheckedAt?: string;
  };
  incubator?: {
    waiting: number;
    mature: number;
    technicalDiscards: number;
    entryEligible: number;
  };
  /** Handlers Sentinel ativos: warm-up de rota, auditoria e tentativa de entrada. */
  sentinelHandoffQueue?: number;
  preFlightEngine?: {
    activeTarget?: string;
    samplesCollected: number;
    simulatedSpreadPct?: number;
    priceVariationPct?: number;
    verdict?: 'Aprovado' | 'Vetado' | 'Em Análise';
  };
  hubHealth?: {
    org1: { status: 'OK' | 'RATE_LIMITED' | 'ERROR'; requestsLeft: number };
    org2: { status: 'OK' | 'RATE_LIMITED' | 'ERROR'; requestsLeft: number };
    org3: { status: 'OK' | 'RATE_LIMITED' | 'ERROR'; requestsLeft: number };
    org4: { status: 'OK' | 'RATE_LIMITED' | 'ERROR'; requestsLeft: number };
    helius: { status: 'CRITICAL' | 'STATE' | 'OK'; requestsLeft: number };
  };
  /** Campos legados mantidos para compatibilidade com /api/status */
  pumpObservatory?: PumpObservatorySnapshot;
  pumpStrategyLab?: {
    mode: 'SHADOW';
    lastError?: string;
    totalSamples: number;
    preferredJupiterPlan?: string;
    preferredPlanNetAfterCostSol?: number;
    routeReadiness?: {
      maxSlippageBps: number;
      momentZeroWindowMs: number;
      probedMints: number;
      compliantRouteMints: number;
      compliantRouteRate: number;
      momentZeroMints: number;
      momentZeroRate: number;
      medianFirstCompliantRouteLagMs?: number;
      p90FirstCompliantRouteLagMs?: number;
      smallestFirstExecutableAmountLamports?: number;
      medianFirstExecutableAmountLamports?: number;
    };
    strategies: Array<{
      cohort: string;
      entryWindow?: string;
      horizon?: string;
      venue: string;
      state: string;
      sampleCount: number;
      meanNetReturnPct?: number;
      executableExitRate: number;
      exitPolicyReplays?: Array<{
        policy: string;
        meanNetReturnPct: number;
        meanMaxGiveBackFromPeakPct: number;
        prematureExitRate: number;
      }>;
    }>;
  };
  pumpDirectSellFallback?: {
    enabled: boolean;
    selectedPath: 'NONE' | 'JUPITER' | 'PUMP_DIRECT';
    confirmationState: 'IDLE' | 'PENDING' | 'CONFIRMED' | 'UNCERTAIN' | 'FAILED';
    estimatedCostSol: number | null;
    fallbackReason: string | null;
  };
  exitCapacity?: {
    admit: boolean;
    requiredRps: number;
    availableRps: number;
    reason?: string;
  };
  exitPathHealth?: {
    state: 'HEALTHY' | 'DEGRADED' | 'EMERGENCY';
    canOpenNewPosition: boolean;
    canRunResearch: boolean;
    maxFailures: number;
    affectedMints: string[];
    reason?: string;
    lastChangedAt: string;
  };
  positions: Array<{
    mint: string;
    symbol: string;
    tokenAmount: number;
    entryPriceUsd: number;
    currentPriceUsd: number;
    pnlPct: number;
    stopLossPct: number;
    takeProfitPct: number;
    entryTimestamp: number;
    dexScreenerUrl: string;
    solscanUrl: string;
    trailingActive?: boolean;
    stopStatusText?: string;
    trailingStopSolValue?: number;
    peakSolValue?: number;
    /** Se true, posição aberta via Sentinel Handoff (Graduation Dip) */
    isSentinelHandoff?: boolean;
  }>;
  walletHoldings?: WalletHoldingView[];
  closedTrades: ClosedTradeView[];
  recentAudits: Array<{
    mint: string;
    symbol: string;
    isSafe: boolean;
    score: number;
    reason?: string;
    swapFailReason?: string;
    timestamp: number;
  }>;
  quarantineCount: number;
  scannerLogs?: Array<{ timestamp: string; message: string; type?: 'info' | 'warn' | 'success' | 'fallback' }>;
  lastUpdated: string;
}


function escapeDashboardHtml(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

const EXIT_REASON_LABELS: Record<string, { label: string; cls: string }> = {
  STOP_LOSS: { label: 'Stop Loss', cls: 'bg-rose-500/15 text-rose-300 border-rose-500/30' },
  WATCHDOG_EXIT: { label: 'Watchdog Exit', cls: 'bg-rose-500/15 text-rose-300 border-rose-500/30' },
  PARTIAL_TAKE_PROFIT_50: { label: 'Colheita Parcial +35%', cls: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30' },
  TRAILING_STOP: { label: 'Trailing Stop', cls: 'bg-amber-500/15 text-amber-300 border-amber-500/30' },
  TIME_STOP: { label: 'Time-Stop', cls: 'bg-slate-500/15 text-slate-300 border-slate-500/30' },
  TAKE_PROFIT: { label: 'Take Profit', cls: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30' },
  MANUAL: { label: 'Manual / Pânico', cls: 'bg-purple-500/15 text-purple-300 border-purple-500/30' },
  LAYA_EXIT: { label: 'Saída Tática Laya', cls: 'bg-cyan-500/15 text-cyan-300 border-cyan-500/30' }
};

function renderClosedTradesSection(state: DashboardState): string {
  const trades = state.closedTrades || [];
  const realizedPnl = trades.reduce((acc, t) => acc + (t.pnlSolEst || 0), 0);
  const wins = trades.filter(t => (t.pnlPct || 0) > 0).length;

  // PnL por origem
  const sentinelTrades = trades.filter(t => t.isSentinelHandoff);
  const dexTrades = trades.filter(t => !t.isSentinelHandoff);
  const sentinelPnl = sentinelTrades.reduce((a, t) => a + (t.pnlSolEst || 0), 0);
  const dexPnl = dexTrades.reduce((a, t) => a + (t.pnlSolEst || 0), 0);
  const sentinelWins = sentinelTrades.filter(t => (t.pnlPct || 0) > 0).length;
  const dexWins = dexTrades.filter(t => (t.pnlPct || 0) > 0).length;

  const rows = trades.slice().reverse().map(t => {
    const pnlPct = Number(t.pnlPct || 0) * 100;
    const pnlSol = Number(t.pnlSolEst || 0);
    const isProfit = pnlPct >= 0;
    const reason = EXIT_REASON_LABELS[t.exitReason] || { label: t.exitReason, cls: 'bg-slate-500/15 text-slate-300 border-slate-500/30' };
    const closedAt = new Date(t.exitTimestamp).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    const txLink = t.txSignature
      ? `<a href="https://solscan.io/tx/${t.txSignature}" target="_blank" class="text-cyan-400 hover:underline font-mono text-[11px]">${t.txSignature.slice(0, 10)}...↗</a>`
      : '<span class="text-slate-600 text-[11px]">sem tx</span>';
    const originBadge = t.isSentinelHandoff
      ? `<span class="ml-1 text-[9px] px-1.5 py-0.5 rounded bg-violet-500/20 text-violet-300 border border-violet-500/30 font-mono">⚡ Sentinel</span>`
      : `<span class="ml-1 text-[9px] px-1.5 py-0.5 rounded bg-blue-500/15 text-blue-300 border border-blue-500/30 font-mono">🎯 Jupiter V2 Discovery</span>`;

    return `
      <tr class="border-b border-slate-800/60 hover:bg-slate-800/30">
        <td class="py-3 px-4 text-slate-400 text-xs font-mono whitespace-nowrap">${closedAt}</td>
        <td class="py-3 px-4">
          <div class="flex items-center gap-2 flex-wrap">
            <span class="font-semibold text-slate-200">${t.symbol}</span>
            ${originBadge}
            <a href="https://solscan.io/token/${t.mint}" target="_blank" class="text-xs text-cyan-400 hover:underline">↗</a>
          </div>
          <div class="text-[11px] text-slate-500 font-mono">${t.mint.slice(0, 6)}...${t.mint.slice(-4)}</div>
        </td>
        <td class="py-3 px-4 text-slate-300 font-mono text-xs">$${Number(t.entryPriceUsd).toFixed(8)}</td>
        <td class="py-3 px-4 text-slate-200 font-mono text-xs">$${Number(t.exitPriceUsd).toFixed(8)}</td>
        <td class="py-3 px-4 font-mono text-xs ${isProfit ? 'text-emerald-400' : 'text-rose-400'}">
          ${isProfit ? '+' : ''}${pnlSol.toFixed(6)} SOL
          <div class="text-[10px] opacity-80">${isProfit ? '+' : ''}${pnlPct.toFixed(2)}%</div>
        </td>
        <td class="py-3 px-4">
          <span class="inline-block px-2 py-0.5 rounded text-[10px] border ${reason.cls}">${reason.label}</span>
        </td>
        <td class="py-3 px-4">${txLink}</td>
      </tr>
    `;
  }).join('');

  const body = trades.length === 0
    ? `<tr><td colspan="7" class="py-10 text-center text-slate-500 text-sm">Nenhum trade encerrado ainda. O histórico aparece após o primeiro fechamento confirmado on-chain.</td></tr>`
    : rows;

  const originBreakdown = trades.length > 0 ? `
    <div class="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
      <div class="bg-slate-950/60 border border-blue-900/30 rounded-xl p-3">
        <div class="text-[10px] uppercase text-slate-500">Jupiter V2 Discovery — PnL</div>
        <div class="font-mono text-sm font-bold ${dexPnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}">${dexPnl >= 0 ? '+' : ''}${dexPnl.toFixed(6)} SOL</div>
        <div class="text-[10px] text-slate-500">Acerto: ${dexWins}/${dexTrades.length}</div>
      </div>
      <div class="bg-slate-950/60 border border-violet-900/30 rounded-xl p-3">
        <div class="text-[10px] uppercase text-slate-500">⚡ Sentinel — PnL</div>
        <div class="font-mono text-sm font-bold ${sentinelPnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}">${sentinelPnl >= 0 ? '+' : ''}${sentinelPnl.toFixed(6)} SOL</div>
        <div class="text-[10px] text-slate-500">Acerto: ${sentinelWins}/${sentinelTrades.length}</div>
      </div>
      <div class="bg-slate-950/60 border border-emerald-900/30 rounded-xl p-3">
        <div class="text-[10px] uppercase text-slate-500">PnL Total Realizado</div>
        <div id="closed-trades-pnl" class="font-mono text-sm font-bold ${realizedPnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}">${realizedPnl >= 0 ? '+' : ''}${realizedPnl.toFixed(6)} SOL</div>
      </div>
      <div class="bg-slate-950/60 border border-cyan-900/30 rounded-xl p-3">
        <div class="text-[10px] uppercase text-slate-500">Taxa de Acerto Global</div>
        <div id="closed-trades-win" class="font-mono text-sm font-bold text-cyan-400">${wins}/${trades.length}</div>
      </div>
    </div>` : '';

  return `
    <section class="bg-slate-900/70 border border-slate-800 rounded-2xl p-4 md:p-6 shadow-xl">
      <div class="flex items-center justify-between mb-4 flex-wrap gap-2">
        <h2 class="text-sm md:text-base font-bold text-white flex items-center gap-2">
          <span>📜 Histórico de Trades Fechados</span>
          <span id="closed-trades-badge" class="text-[10px] font-mono px-2 py-0.5 rounded bg-slate-800 text-slate-400">${trades.length} trade(s)</span>
        </h2>
      </div>
      ${originBreakdown}
      <div class="overflow-x-auto">
        <table class="w-full text-left">
          <thead>
            <tr class="border-b border-slate-700 text-[10px] uppercase tracking-wider text-slate-500">
              <th class="py-2 px-4 font-semibold">Encerramento</th>
              <th class="py-2 px-4 font-semibold">Token / Origem</th>
              <th class="py-2 px-4 font-semibold">Preço Entrada</th>
              <th class="py-2 px-4 font-semibold">Preço Saída</th>
              <th class="py-2 px-4 font-semibold">PnL Realizado</th>
              <th class="py-2 px-4 font-semibold">Motivo</th>
              <th class="py-2 px-4 font-semibold">TX de Saída</th>
            </tr>
          </thead>
          <tbody id="closed-trades-tbody">${body}</tbody>
        </table>
      </div>
      <p class="text-[10px] text-slate-600 mt-3 font-mono">
        Nota: o histórico vive em memória e é zerado a cada redeploy. Agregados persistidos ficam no Decision Journal.
      </p>
    </section>
  `;
}

export function renderDashboardHtml(state: DashboardState): string {
  const waitingCount = state.incubator?.waiting ?? 0;
  const matureCount = state.incubator?.mature ?? 0;
  const discardsCount = state.incubator?.technicalDiscards ?? 0;
  const entryEligibleCount = state.incubator?.entryEligible ?? 0;
  const sentinelQueueCount = state.sentinelHandoffQueue ?? 0;

  return `<!DOCTYPE html>
<html lang="pt-BR" class="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>NEXUS QUANT SOLANA | SISTEMA 24/7</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script>
    tailwind.config = {
      darkMode: 'class',
      theme: { extend: { colors: { brand: { 50: '#F0F9FF', 500: '#0284C7', 600: '#0369A1', 900: '#0C4A6E' } } } }
    }
  </script>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&family=Inter:wght@400;500;600;700;800&display=swap');
    body { font-family: 'Inter', sans-serif; }
    .font-mono { font-family: 'JetBrains Mono', monospace; }
  </style>
</head>
<body class="bg-slate-950 text-slate-100 min-h-screen p-4 md:p-6 lg:p-8 antialiased">
  <div class="max-w-7xl mx-auto space-y-6">

    <!-- ═══════ HEADER EXECUTIVO ═══════ -->
    <header class="bg-slate-900/80 border border-slate-800 rounded-2xl p-4 md:p-6 shadow-2xl backdrop-blur-md flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
      <div class="space-y-1">
        <div class="flex items-center gap-3">
          <div class="h-3 w-3 rounded-full bg-emerald-500 animate-ping"></div>
          <h1 class="text-xl md:text-2xl font-black tracking-tight text-white flex items-center gap-2">
            NEXUS QUANT SOLANA <span class="text-xs font-semibold px-2 py-0.5 rounded-full bg-cyan-500/20 text-cyan-400 border border-cyan-500/30">SISTEMA 24/7</span>
          </h1>
        </div>
        <div class="flex flex-wrap items-center gap-2 text-xs text-slate-400">
          <span>Carteira:</span>
          <a href="https://solscan.io/account/${state.wallet}" target="_blank" class="font-mono text-cyan-400 hover:underline flex items-center gap-1">
            ${state.wallet.slice(0, 6)}...${state.wallet.slice(-6)}
            <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"/></svg>
          </a>
          <span class="text-slate-600">|</span>
          <span>Modo: <strong class="${state.dryRun ? 'text-amber-400' : 'text-emerald-400'}">${state.dryRun ? 'DRY-RUN (Simulação)' : 'EXECUÇÃO REAL ON-CHAIN'}</strong></span>
          <span class="text-slate-600">|</span>
          <span>Infraestrutura: <span class="font-mono text-slate-300 text-[11px]">Jupiter Multi-Org (4 Orgs) + Helius RPC Hub (6 Chaves)</span></span>
          <span class="text-slate-600">|</span>
          <span>Atualizado: <span id="last-updated" class="font-mono text-slate-300">${new Date(state.lastUpdated || Date.now()).toLocaleTimeString()}</span></span>
        </div>
      </div>

      <div class="flex flex-wrap items-center gap-3 w-full md:w-auto justify-end">
        <!-- Saldo -->
        <div class="bg-slate-800/80 border border-slate-700/80 rounded-xl px-4 py-2 flex items-center gap-3 shadow-inner">
          <div class="text-xs text-slate-400 uppercase tracking-wider font-semibold">Saldo</div>
          <div id="wallet-balance" class="text-lg md:text-xl font-bold font-mono text-emerald-400">${Number(state.balanceSol || 0).toFixed(4)} SOL</div>
        </div>

        <!-- Sentinel State Badge -->
        <div class="bg-slate-800/80 border border-slate-700/80 rounded-xl px-3 py-2 flex items-center gap-2">
          <span id="sentinel-dot" class="h-2.5 w-2.5 rounded-full ${state.circuitBreakerActive ? 'bg-rose-500 animate-pulse' : 'bg-emerald-500 animate-pulse'}"></span>
          <div class="text-xs">
            <span class="text-slate-400 font-medium">Sentinel:</span>
            <strong id="sentinel-text" class="${state.circuitBreakerActive ? 'text-rose-400' : 'text-emerald-400'} ml-1 font-mono">${state.circuitBreakerActive ? 'DISJUNTOR ATIVO' : (state.macroRegime || 'SEGURO')}</strong>
          </div>
        </div>

        <!-- Laya Live Gatekeeper Badge -->
        <div class="bg-slate-800/80 border border-slate-700/80 rounded-xl px-3 py-2 flex items-center gap-2">
          <span class="h-2 w-2 rounded-full ${state.laya?.health === 'OK' ? 'bg-cyan-400' : 'bg-amber-400'}"></span>
          <div class="text-xs">
            <span class="text-slate-400">Laya:</span>
            <span id="op-laya-status" class="${state.laya?.health === 'OK' ? 'text-cyan-300' : 'text-amber-300'} ml-1 font-mono font-bold">${(state.laya?.tacticalMode || 'LIVE') === 'LIVE' ? (state.laya?.health === 'OK' ? 'LIVE GATEKEEPER' : 'DEGRADED · LIVE GATEKEEPER') : ((state.laya?.health || 'UNKNOWN') + ' · ' + (state.laya?.tacticalMode || 'OFF'))}</span>
          </div>
        </div>


      </div>
    </header>

    <!-- ═══════ TELEMETRIA MULTI-ORG & PRE-FLIGHT ═══════ -->
    <section class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-3">
      <div class="bg-slate-900/70 border border-slate-800 rounded-xl p-3 col-span-1 lg:col-span-2">
        <div class="text-[10px] uppercase tracking-wider text-slate-500">Hub Health (Quotas)</div>
        <div class="grid grid-cols-2 gap-2 mt-2">
          <div class="text-[10px]">Org 1 (Proteção): <span class="font-mono text-emerald-400">${state.hubHealth?.org1?.status || 'OK'}</span></div>
          <div class="text-[10px]">Org 2 (Entry): <span class="font-mono text-emerald-400">${state.hubHealth?.org2?.status || 'OK'}</span></div>
          <div class="text-[10px]">Org 3 (Entry): <span class="font-mono text-emerald-400">${state.hubHealth?.org3?.status || 'OK'}</span></div>
          <div class="text-[10px]">Org 4 (Discovery): <span class="font-mono text-emerald-400">${state.hubHealth?.org4?.status || 'OK'}</span></div>
        </div>
      </div>
      <div class="bg-slate-900/70 border border-slate-800 rounded-xl p-3">
        <div class="text-[10px] uppercase tracking-wider text-slate-500">Helius RPC</div>
        <div class="mt-1 font-bold ${state.hubHealth?.helius?.status === 'CRITICAL' ? 'text-rose-400' : 'text-emerald-400'}">${state.hubHealth?.helius?.status || 'OK'}</div>
        <div class="text-[10px] text-slate-500 mt-1">Pool de 6 chaves</div>
      </div>
      <div class="bg-slate-900/70 border border-slate-800 rounded-xl p-3 col-span-1 lg:col-span-3">
        <div class="text-[10px] uppercase tracking-wider text-slate-500">Pre-Flight Engine (Micro-Momentum)</div>
        <div class="mt-1 grid grid-cols-3 gap-2">
          <div>
            <div class="text-[10px] text-slate-400">Alvo Atual</div>
            <div class="font-mono text-xs text-cyan-400 truncate">${state.preFlightEngine?.activeTarget ? state.preFlightEngine.activeTarget.slice(0, 12) + '...' : 'Aguardando'}</div>
          </div>
          <div>
            <div class="text-[10px] text-slate-400">Spread / Var</div>
            <div class="font-mono text-xs text-white">${state.preFlightEngine?.simulatedSpreadPct ? state.preFlightEngine.simulatedSpreadPct.toFixed(2) + '%' : '-'} / ${state.preFlightEngine?.priceVariationPct ? state.preFlightEngine.priceVariationPct.toFixed(2) + '%' : '-'}</div>
          </div>
          <div>
            <div class="text-[10px] text-slate-400">Veredito</div>
            <div class="font-bold text-xs ${state.preFlightEngine?.verdict === 'Aprovado' ? 'text-emerald-400' : state.preFlightEngine?.verdict === 'Vetado' ? 'text-rose-400' : 'text-amber-400'}">${state.preFlightEngine?.verdict || 'Ocioso'}</div>
          </div>
        </div>
      </div>
    </section>

    <!-- ═══════ FUNIL DE MERCADO — 5 CARDS (inclui Sentinel Handoff) ═══════ -->
    <section class="grid grid-cols-2 lg:grid-cols-5 gap-4">
      <!-- Card 1: Incubadora -->
      <div class="bg-slate-900/60 border border-slate-800/90 rounded-2xl p-4 shadow-lg flex flex-col justify-between hover:border-slate-700 transition">
        <div class="flex items-center justify-between text-slate-400 text-xs font-medium">
          <span>🕒 Incubadora</span>
          <span class="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-400">&lt; 5 min</span>
        </div>
        <div id="metric-incubator-waiting" class="text-2xl md:text-3xl font-black font-mono text-cyan-400 mt-2">${waitingCount}</div>
        <div class="text-[11px] text-slate-500 mt-1">Pools aguardando maturidade mínima</div>
      </div>

      <!-- Card 2: Maturos -->
      <div class="bg-slate-900/60 border border-slate-800/90 rounded-2xl p-4 shadow-lg flex flex-col justify-between hover:border-slate-700 transition">
        <div class="flex items-center justify-between text-slate-400 text-xs font-medium">
          <span>🎯 Maturos para Análise</span>
          <span class="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400">5-60 min</span>
        </div>
        <div id="metric-incubator-mature" class="text-2xl md:text-3xl font-black font-mono text-amber-400 mt-2">${matureCount}</div>
        <div class="text-[11px] text-slate-500 mt-1">Descoberta Jupiter Tokens V2 (Org 4)</div>
      </div>

      <!-- Card 3: Descartes Técnicos -->
      <div class="bg-slate-900/60 border border-slate-800/90 rounded-2xl p-4 shadow-lg flex flex-col justify-between hover:border-slate-700 transition">
        <div class="flex items-center justify-between text-slate-400 text-xs font-medium">
          <span>🛡️ Descartes Técnicos</span>
          <span class="text-[10px] px-1.5 py-0.5 rounded bg-slate-500/10 text-slate-400">$15k / M5</span>
        </div>
        <div id="metric-technical-discards" class="text-2xl md:text-3xl font-black font-mono text-rose-400 mt-2">${discardsCount}</div>
        <div class="text-[11px] text-slate-500 mt-1">Barrados por liquidez ou momentum</div>
      </div>

      <!-- Card 4: Elegíveis para Auditoria -->
      <div class="bg-slate-900/60 border border-slate-800/90 rounded-2xl p-4 shadow-lg flex flex-col justify-between hover:border-slate-700 transition">
        <div class="flex items-center justify-between text-slate-400 text-xs font-medium">
          <span>🧠 Elegíveis</span>
          <span class="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400">Pré-filtro</span>
        </div>
        <div id="metric-entry-eligible" class="text-2xl md:text-3xl font-black font-mono text-emerald-400 mt-2">${entryEligibleCount}</div>
        <div class="text-[11px] text-slate-500 mt-1">Candidatos aguardando auditoria de risco</div>
      </div>

      <!-- Card 5: ⚡ Fila Sentinel Handoff -->
      <div class="bg-slate-900/60 border border-violet-900/50 rounded-2xl p-4 shadow-lg flex flex-col justify-between hover:border-violet-700/60 transition">
        <div class="flex items-center justify-between text-slate-400 text-xs font-medium">
          <span class="text-violet-300 font-semibold">⚡ Fila Sentinel</span>
          <span class="text-[10px] px-1.5 py-0.5 rounded bg-violet-500/15 text-violet-300 border border-violet-500/30">Raydium</span>
        </div>
        <div id="metric-sentinel-queue" class="text-2xl md:text-3xl font-black font-mono text-violet-400 mt-2">${sentinelQueueCount}</div>
        <div class="text-[11px] text-slate-500 mt-1">Tokens graduados aguardando rota Jupiter</div>
      </div>
    </section>

    <!-- ═══════ POSIÇÕES ATIVAS SOB GESTÃO ═══════ -->
    <section class="bg-slate-900/70 border border-slate-800 rounded-2xl overflow-hidden shadow-xl">
      <div class="p-4 md:px-6 border-b border-slate-800/80 flex items-center justify-between bg-slate-900/90">
        <div>
          <h2 class="text-base md:text-lg font-bold text-white flex items-center gap-2">
            <span>⚡ Posições Ativas sob Gestão</span>
            <span id="active-positions-badge" class="text-xs px-2 py-0.5 rounded-full bg-slate-800 text-slate-300 font-mono">${state.positions.length} / 2 (Teto Seguro Org 1)</span>
          </h2>
          <p class="text-xs text-slate-400 mt-0.5">PnL/Stop Jupiter executável 1.5s · SL inicial: -12.5% · Trailing momentum: +8%/-6% do topo · Runner pós-parcial: -10% do topo</p>
        </div>

      </div>

      <div class="overflow-x-auto">
        <table class="w-full text-left text-sm">
          <thead class="bg-slate-950/60 text-slate-400 text-xs uppercase tracking-wider font-semibold border-b border-slate-800">
            <tr>
              <th class="py-3 px-4 md:px-6">Token / Origem</th>
              <th class="py-3 px-4">Preço Entrada</th>
              <th class="py-3 px-4">Preço Atual</th>
              <th class="py-3 px-4">PnL Líquido</th>
              <th class="py-3 px-4">Break-Even / SL</th>
              <th class="py-3 px-4">Trailing Stop</th>
              <th class="py-3 px-4 md:px-6 text-right">Ação</th>
            </tr>
          </thead>
          <tbody id="positions-tbody" class="divide-y divide-slate-800/60 font-mono">
            ${state.positions.length === 0 ? `
              <tr>
                <td colspan="7" class="py-8 text-center text-slate-500 font-sans">
                  Varredura ativa. Aguardando candidato aprovado pelos filtros determinísticos (Jupiter V2) ou Sentinel Handoff (Graduation Dip)...
                </td>
              </tr>
            ` : state.positions.map(p => {
              const pnlVal = Number(p.pnlPct || 0);
              const isProfit = pnlVal >= 0;
              const originBadge = p.isSentinelHandoff
                ? `<span class="text-[9px] px-1.5 py-0.5 rounded bg-violet-500/20 text-violet-300 border border-violet-500/30 font-sans">⚡ Sentinel</span>`
                : `<span class="text-[9px] px-1.5 py-0.5 rounded bg-blue-500/15 text-blue-300 border border-blue-500/30 font-sans">🎯 Jupiter V2</span>`;
              const breakEvenPct = p.stopLossPct ? (Number(p.stopLossPct) * 100).toFixed(1) + '%' : 'N/D';
              return `
              <tr id="pos-row-${p.mint}" class="hover:bg-slate-800/30 transition">
                <td class="py-4 px-4 md:px-6 font-sans">
                  <div class="font-bold text-white flex items-center gap-2 flex-wrap">
                    <span>${p.symbol}</span>
                    ${originBadge}
                    <a href="https://solscan.io/token/${p.mint}" target="_blank" class="text-xs text-cyan-400 hover:underline">↗</a>
                  </div>
                  <div class="text-[11px] text-slate-400 font-mono">${p.mint.slice(0, 6)}...${p.mint.slice(-4)}</div>
                </td>
                <td class="py-4 px-4 text-slate-300">$${Number(p.entryPriceUsd).toFixed(6)}</td>
                <td id="price-${p.mint}" class="py-4 px-4 text-slate-200">$${Number(p.currentPriceUsd).toFixed(6)}</td>
                <td id="pnl-${p.mint}" class="py-4 px-4 font-bold ${isProfit ? 'text-emerald-400' : 'text-rose-400'}">
                  ${isProfit ? '+' : ''}${(pnlVal * 100).toFixed(2)}%
                </td>
                <td class="py-4 px-4 text-xs text-slate-400">${breakEvenPct}</td>
                <td class="py-4 px-4 text-xs">
                  <span class="${p.trailingActive ? 'text-emerald-400 font-semibold' : 'text-slate-500'}">
                    ${p.stopStatusText || (p.trailingActive ? 'ATIVO (proteção dinâmica)' : 'INATIVO (ativa a partir de +8%)')}
                  </span>
                </td>
                <td class="py-4 px-4 md:px-6 text-right font-sans">

                </td>
              </tr>
            `; }).join('')}
          </tbody>
        </table>
      </div>
    </section>

    <!-- ═══════ HISTÓRICO DE TRADES FECHADOS (com breakdown por origem) ═══════ -->
    ${renderClosedTradesSection(state)}

    <!-- ═══════ DECISION JOURNAL & CALIBRAÇÃO DE EV v2.5.0 ═══════ -->
    ${renderJournalSection()}

    <!-- ═══════ TELEMETRIA & LOGS EM TEMPO REAL ═══════ -->
    <section class="bg-slate-900/70 border border-slate-800 rounded-2xl p-4 md:p-6 shadow-xl space-y-3">
      <div class="flex items-center justify-between">
        <h2 class="text-sm md:text-base font-bold text-white flex items-center gap-2">
          <span>📡 Telemetria &amp; Logs em Tempo Real</span>
          <span class="h-2 w-2 rounded-full bg-cyan-400 animate-ping"></span>
        </h2>
        <span class="text-xs text-slate-500 font-mono">Auto-scroll ativo</span>
      </div>
      <div id="logs-container" class="bg-black/90 border border-slate-800/80 rounded-xl p-4 font-mono text-xs text-slate-300 h-64 overflow-y-auto space-y-1.5">
        ${(state.scannerLogs || []).map(l => {
          const text = typeof l === 'string' ? l : `[${l.timestamp}] ${l.message}`;
          const colorClass = text.includes('APROVADO') || text.includes('Graduation Dip') ? 'text-emerald-400'
            : text.includes('⚠️') || text.includes('VETADO') ? 'text-amber-400'
            : text.includes('🚨') || text.includes('Erro') ? 'text-rose-400'
            : text.includes('SentinelHandoff') ? 'text-violet-300'
            : 'text-slate-300';
          return `<div class="${colorClass}">${text}</div>`;
        }).join('')}
      </div>
    </section>

  </div>

  <!-- MODAL ADMIN -->
  <div id="admin-auth-modal" class="hidden fixed inset-0 z-50 bg-black/80 backdrop-blur-sm items-center justify-center p-4">
    <div class="w-full max-w-md bg-slate-950 border border-slate-700 rounded-2xl shadow-2xl p-5 space-y-4">
      <div class="flex items-center justify-between">
        <div>
          <h3 class="text-white font-black text-lg">Admin Nexus Solana</h3>
          <p id="admin-modal-subtitle" class="text-xs text-slate-400 mt-1">Autenticação obrigatória para ações on-chain manuais.</p>
        </div>
        <button onclick="closeAdminModal()" class="text-slate-400 hover:text-white text-xl">×</button>
      </div>
      <div id="admin-login-panel" class="space-y-3">
        <input id="admin-login-email" type="email" autocomplete="username" placeholder="Email admin" class="w-full bg-slate-900 border border-slate-700 rounded-xl px-3 py-2.5 text-sm text-white outline-none focus:border-cyan-500">
        <input id="admin-login-password" type="password" autocomplete="current-password" placeholder="Senha" class="w-full bg-slate-900 border border-slate-700 rounded-xl px-3 py-2.5 text-sm text-white outline-none focus:border-cyan-500">
        <button onclick="submitAdminLogin()" class="w-full bg-cyan-600 hover:bg-cyan-500 text-white font-bold rounded-xl py-2.5">ENTRAR</button>
      </div>
      <div id="admin-register-panel" class="hidden space-y-3 border-t border-slate-800 pt-4">
        <div class="text-xs text-amber-300">Primeiro acesso: crie o administrador. O código mestre é usado uma única vez.</div>
        <input id="admin-register-name" type="text" autocomplete="name" placeholder="Nome do administrador" class="w-full bg-slate-900 border border-slate-700 rounded-xl px-3 py-2.5 text-sm text-white outline-none focus:border-cyan-500">
        <input id="admin-register-email" type="email" autocomplete="username" placeholder="Email admin" class="w-full bg-slate-900 border border-slate-700 rounded-xl px-3 py-2.5 text-sm text-white outline-none focus:border-cyan-500">
        <input id="admin-register-password" type="password" autocomplete="new-password" placeholder="Senha (mín. 8 caracteres)" class="w-full bg-slate-900 border border-slate-700 rounded-xl px-3 py-2.5 text-sm text-white outline-none focus:border-cyan-500">
        <input id="admin-register-bootstrap" type="password" autocomplete="off" placeholder="Código mestre NEXUS_ADMIN_TOKEN" class="w-full bg-slate-900 border border-amber-700/60 rounded-xl px-3 py-2.5 text-sm text-white outline-none focus:border-amber-500">
        <button onclick="submitAdminRegistration()" class="w-full bg-amber-600 hover:bg-amber-500 text-white font-bold rounded-xl py-2.5">CADASTRAR ADMIN</button>
      </div>
      <div id="admin-auth-message" class="hidden text-xs rounded-lg p-2.5"></div>
    </div>
  </div>

  <!-- ═══════ SCRIPT DE AÇÕES & POLLING NATIVO A CADA 2.5s ═══════ -->
  <script>
    let adminSession = null;
    let adminAuthStatus = { configured: false, needsBootstrap: false };
    const POLL_INTERVAL_MS = 2500;

    function escapePumpHtml(value) {
      return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) {
        return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[ch];
      });
    }

    function setAdminMessage(message, isError) {
      const el = document.getElementById('admin-auth-message');
      if (!el) return;
      el.textContent = message || '';
      el.className = message
        ? 'text-xs rounded-lg p-2.5 ' + (isError ? 'bg-rose-500/10 text-rose-300 border border-rose-500/30' : 'bg-emerald-500/10 text-emerald-300 border border-emerald-500/30')
        : 'hidden';
    }

    function applyAdminUi() {
      const logged = Boolean(adminSession && adminSession.role === 'ADMIN');
      const loginButton = document.getElementById('admin-login-button');
      const controls = document.getElementById('admin-session-controls');
      const nameEl = document.getElementById('admin-session-name');
      if (loginButton) loginButton.classList.toggle('hidden', logged);
      if (controls) {
        controls.classList.toggle('hidden', !logged);
        controls.classList.toggle('flex', logged);
      }
      if (nameEl) nameEl.textContent = logged ? (adminSession.name || adminSession.email || 'ADMIN') : '';
      document.querySelectorAll('.admin-action').forEach(function (button) {
        button.disabled = !logged;
        button.classList.toggle('cursor-not-allowed', !logged);
        button.classList.toggle('text-slate-600', !logged);
        button.classList.toggle('bg-slate-800', !logged);
        if (logged) {
          button.classList.add('text-white', 'bg-cyan-700', 'hover:bg-cyan-600');
        } else {
          button.classList.remove('text-white', 'bg-cyan-700', 'hover:bg-cyan-600');
        }
      });
    }

    async function adminFetch(url, options) {
      if (!adminSession || adminSession.role !== 'ADMIN') throw new Error('Faça login como ADMIN para executar esta ação.');
      const opts = Object.assign({ credentials: 'same-origin' }, options || {});
      const res = await fetch(url, opts);
      if (res.status === 401) { await logoutAdmin(false); throw new Error('Sessão administrativa expirada. Faça login novamente.'); }
      return res;
    }

    function openAdminModal() {
      const modal = document.getElementById('admin-auth-modal');
      if (!modal) return;
      modal.classList.remove('hidden'); modal.classList.add('flex');
      const registerPanel = document.getElementById('admin-register-panel');
      const loginPanel = document.getElementById('admin-login-panel');
      if (registerPanel) registerPanel.classList.toggle('hidden', !adminAuthStatus.needsBootstrap);
      if (loginPanel) loginPanel.classList.toggle('hidden', adminAuthStatus.needsBootstrap);
      setAdminMessage('', false);
    }

    function closeAdminModal() {
      const modal = document.getElementById('admin-auth-modal');
      if (!modal) return;
      modal.classList.add('hidden'); modal.classList.remove('flex');
    }

    async function submitAdminLogin() {
      try {
        setAdminMessage('Validando credenciais...', false);
        const email = document.getElementById('admin-login-email')?.value || '';
        const password = document.getElementById('admin-login-password')?.value || '';
        const res = await fetch('/api/auth/login', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
        const data = await res.json();
        if (!res.ok || !data.success || !data.user) throw new Error(data.error || 'Falha no login.');
        adminSession = data.user;
        const pwd = document.getElementById('admin-login-password'); if (pwd) pwd.value = '';
        closeAdminModal(); applyAdminUi();
      } catch (err) { setAdminMessage(err.message || String(err), true); }
    }

    async function submitAdminRegistration() {
      try {
        setAdminMessage('Criando administrador...', false);
        const name = document.getElementById('admin-register-name')?.value || '';
        const email = document.getElementById('admin-register-email')?.value || '';
        const password = document.getElementById('admin-register-password')?.value || '';
        const bootstrapToken = document.getElementById('admin-register-bootstrap')?.value || '';
        const res = await fetch('/api/auth/register-admin', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, email, password, bootstrapToken }) });
        const data = await res.json();
        if (!res.ok || !data.success || !data.user) throw new Error(data.error || 'Falha no cadastro.');
        adminSession = data.user; adminAuthStatus.needsBootstrap = false;
        ['admin-register-password', 'admin-register-bootstrap'].forEach(function (id) { const el = document.getElementById(id); if (el) el.value = ''; });
        closeAdminModal(); applyAdminUi();
      } catch (err) { setAdminMessage(err.message || String(err), true); }
    }

    async function logoutAdmin(showMessage) {
      try { await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }); } catch (_) {}
      adminSession = null; applyAdminUi();
      if (showMessage !== false) alert('Sessão administrativa encerrada.');
    }

    async function refreshAuthState() {
      try { const statusRes = await fetch('/api/auth/status', { credentials: 'same-origin' }); if (statusRes.ok) adminAuthStatus = await statusRes.json(); } catch (_) {}
      try {
        const meRes = await fetch('/api/auth/me', { credentials: 'same-origin' });
        const me = await meRes.json();
        adminSession = (meRes.ok && me.success && me.user?.role === 'ADMIN') ? me.user : null;
      } catch (_) { adminSession = null; }
      applyAdminUi();
    }

    async function panicToken(mint, symbol) {
      if (!confirm('⚡ CONFIRMAR LIQUIDAÇÃO ADMIN:\\nLiquidar 100% da posição ' + (symbol || mint) + ' pelo executor seguro.')) return;
      try {
        const res = await adminFetch('/api/positions/' + encodeURIComponent(mint) + '/exit', { method: 'POST' });
        const data = await res.json();
        data.success ? alert('✅ ' + (data.message || 'Posição liquidada com sucesso!')) : alert('❌ Falha: ' + (data.error || 'Erro desconhecido'));
        pollDashboard();
      } catch (err) { alert('❌ Erro: ' + err.message); }
    }

    async function panicAll() {
      if (!confirm('🚨 PÂNICO GERAL ADMIN\\n\\nEsta ação arma o circuit breaker, liquida posições rastreadas e holdings SPL positivos não-base, depois varre contas SPL vazias.\\n\\nDeseja prosseguir?')) return;
      try {
        const res = await adminFetch('/api/positions/liquidate-all', { method: 'POST' });
        const data = await res.json();
        data.success ? alert('🚨 PÂNICO GERAL EXECUTADO!\\n' + (data.message || '')) : alert('❌ Falha: ' + (data.error || 'Erro desconhecido'));
        pollDashboard();
      } catch (err) { alert('❌ Erro: ' + err.message); }
    }

    async function sweepRentManual() {
      try {
        const res = await adminFetch('/api/wallet/sweep-rent', { method: 'POST' });
        const data = await res.json();
        data.success
          ? alert('🧹 Rent recovery concluído. Contas fechadas: ' + data.closedCount + ' | Rent bruto: ' + Number(data.reclaimedSolActual || 0).toFixed(9) + ' SOL')
          : alert('⚠️ Erro: ' + (data.error || 'Falha'));
        pollDashboard();
      } catch (err) { alert('Erro: ' + err.message); }
    }

    // Polling nativo a cada 2.5s (sem piscar a tela)
    async function pollDashboard() {
      try {
        const res = await fetch('/api/status');
        if (!res.ok) return;
        const data = await res.json();

        // 1. Timestamp e saldo
        const tsEl = document.getElementById('last-updated');
        if (tsEl) tsEl.textContent = new Date().toLocaleTimeString();
        const bal = data.wallet?.balanceSol ?? data.balanceSol;
        const balEl = document.getElementById('wallet-balance');
        if (balEl && bal !== undefined) balEl.textContent = Number(bal).toFixed(4) + ' SOL';

        // 2. Sentinel
        const sentinelStatus = data.sentinel?.status ?? data.macroRegime ?? 'NORMAL';
        const isBreaker = data.sentinel?.circuitBreaker === 'ENGAGED' || Boolean(data.circuitBreakerActive);
        const sentinelTextEl = document.getElementById('sentinel-text');
        const sentinelDotEl = document.getElementById('sentinel-dot');
        if (sentinelTextEl) { sentinelTextEl.textContent = isBreaker ? 'DISJUNTOR ATIVO' : sentinelStatus; sentinelTextEl.className = (isBreaker ? 'text-rose-400' : 'text-emerald-400') + ' ml-1 font-mono'; }
        if (sentinelDotEl) sentinelDotEl.className = 'h-2.5 w-2.5 rounded-full ' + (isBreaker ? 'bg-rose-500 animate-pulse' : 'bg-emerald-500 animate-pulse');

        // 3. Estado operacional
        const operational = data.operational || {};
        const auth = operational.adminAuth || {};
        const rent = operational.rentRecovery || {};
        const laya = operational.laya || {};
        const exitHealth = operational.exitPathHealth || {};
        adminAuthStatus.configured = Boolean(auth.configured);
        adminAuthStatus.needsBootstrap = Boolean(auth.needsBootstrap);

        const execEl = document.getElementById('op-execution-mode');
        if (execEl) { execEl.textContent = operational.maintenanceMode ? 'MODO MANUTENÇÃO' : (operational.executionMode === 'REAL_ON_CHAIN' ? 'REAL ON-CHAIN' : 'DRY-RUN'); execEl.className = 'mt-1 font-bold ' + (operational.maintenanceMode ? 'text-amber-300' : (operational.executionMode === 'REAL_ON_CHAIN' ? 'text-emerald-400' : 'text-amber-400')); }
        const layaEl = document.getElementById('op-laya-status');
        const layaCardEl = document.getElementById('op-laya-card-status');
        const layaDetail = document.getElementById('op-laya-detail');
        const isLayaLive = (laya.tacticalMode || 'LIVE') === 'LIVE';
        const layaText = isLayaLive
          ? (laya.health === 'OK' ? 'LIVE GATEKEEPER' : ((laya.health || 'UNKNOWN') + ' · LIVE GATEKEEPER'))
          : ((laya.health || 'UNKNOWN') + ' · ' + (laya.tacticalMode || 'OFF'));
        if (layaEl) {
          layaEl.textContent = layaText;
          layaEl.className = 'text-xs ' + (laya.health === 'OK' ? 'text-cyan-300 font-bold' : 'text-amber-300 font-bold');
        }
        if (layaCardEl) {
          layaCardEl.textContent = layaText;
          layaCardEl.className = 'mt-1 font-bold ' + (laya.health === 'OK' ? 'text-emerald-400' : 'text-amber-400');
        }
        if (layaDetail) layaDetail.textContent = (laya.loaded || []).join(',') || 'checkpoint nao confirmado';
        const exitHealthEl = document.getElementById('op-exit-health-status');
        const exitHealthDetail = document.getElementById('op-exit-health-detail');
        if (exitHealthEl) { const s = exitHealth.state || 'HEALTHY'; exitHealthEl.textContent = s; exitHealthEl.className = 'mt-1 font-bold ' + (s === 'HEALTHY' ? 'text-emerald-400' : s === 'EMERGENCY' ? 'text-rose-400' : 'text-amber-400'); }
        if (exitHealthDetail) exitHealthDetail.textContent = exitHealth.reason || ('Falhas: ' + Number(exitHealth.maxFailures || 0) + ' · novas entradas ' + (exitHealth.canOpenNewPosition === false ? 'PAUSADAS' : 'LIBERADAS'));
        const rentEl = document.getElementById('op-rent-status');
        const rentDetail = document.getElementById('op-rent-detail');
        if (rentEl) { rentEl.textContent = rent.autoEnabled ? (rent.inFlight ? 'AUTO EXECUTANDO' : 'AUTO ATIVO') : 'AUTO DESLIGADO'; rentEl.className = 'mt-1 font-bold ' + (rent.autoEnabled ? 'text-emerald-400' : 'text-slate-400'); }
        if (rentDetail) rentDetail.textContent = Number(rent.totalReclaimedSolActual || 0).toFixed(9) + ' SOL rent observado · ' + Number(rent.totalClosedCount || 0) + ' conta(s) fechada(s)';
        const authEl = document.getElementById('op-auth-status');
        if (authEl) { authEl.textContent = auth.configured ? (auth.needsBootstrap ? 'CADASTRO NECESSÁRIO' : (adminSession ? 'SESSÃO ADMIN ATIVA' : 'LOGIN DISPONÍVEL')) : 'AUTH INDISPONÍVEL'; authEl.className = 'mt-1 font-bold ' + (auth.configured ? 'text-cyan-400' : 'text-rose-400'); }

        // 4. Cards do Funil (incluindo Sentinel Handoff)
        const incubator = data.incubator || {};
        const elWaiting = document.getElementById('metric-incubator-waiting');
        const elMature = document.getElementById('metric-incubator-mature');
        const elDiscards = document.getElementById('metric-technical-discards');
        const elEligible = document.getElementById('metric-entry-eligible');
        const elSentinel = document.getElementById('metric-sentinel-queue');
        if (elWaiting && incubator.waiting !== undefined) elWaiting.textContent = incubator.waiting;
        if (elMature && incubator.mature !== undefined) elMature.textContent = incubator.mature;
        if (elDiscards && incubator.technicalDiscards !== undefined) elDiscards.textContent = incubator.technicalDiscards;
        if (elEligible && incubator.entryEligible !== undefined) elEligible.textContent = incubator.entryEligible;
        if (elSentinel && data.sentinelHandoffQueue !== undefined) elSentinel.textContent = data.sentinelHandoffQueue;

        // 5. Posições Ativas
        const positions = data.positions || [];
        const posTbody = document.getElementById('positions-tbody');
        const posBadge = document.getElementById('active-positions-badge');
        if (posBadge) posBadge.textContent = positions.length + ' / 2';
        if (posTbody) {
          if (positions.length === 0) {
            posTbody.innerHTML = '<tr><td colspan="7" class="py-8 text-center text-slate-500 font-sans">Varredura ativa. Aguardando candidato aprovado pelos filtros determinísticos (DEX 5m) ou Sentinel Handoff (Graduation Dip)...</td></tr>';
          } else {
            var reasonLabels = { STOP_LOSS: ['Stop Loss', 'bg-rose-500/15 text-rose-300 border-rose-500/30'], PARTIAL_TAKE_PROFIT_50: ['Colheita Parcial +35%', 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'], TRAILING_STOP: ['Trailing Stop', 'bg-amber-500/15 text-amber-300 border-amber-500/30'], TIME_STOP: ['Time-Stop', 'bg-slate-500/15 text-slate-300 border-slate-500/30'], TAKE_PROFIT: ['Take Profit', 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'], MANUAL: ['Manual / Pânico', 'bg-purple-500/15 text-purple-300 border-purple-500/30'], LAYA_EXIT: ['Saída Tática Laya', 'bg-cyan-500/15 text-cyan-300 border-cyan-500/30'] };
            posTbody.innerHTML = positions.map(function(p) {
              const pnlPct = p.pnlPercent !== undefined ? p.pnlPercent : (p.pnlPct ? p.pnlPct * 100 : 0);
              const isProfit = pnlPct >= 0;
              const stopLoss = p.stopLossPercent !== undefined ? p.stopLossPercent : (p.stopLossPct !== undefined ? p.stopLossPct : -6);
              const originBadge = p.isSentinelHandoff
                ? '<span class="text-[9px] px-1.5 py-0.5 rounded bg-violet-500/20 text-violet-300 border border-violet-500/30 font-sans">⚡ Sentinel</span>'
                : '<span class="text-[9px] px-1.5 py-0.5 rounded bg-blue-500/15 text-blue-300 border border-blue-500/30 font-sans">🎯 DEX 5m</span>';
              return '<tr id="pos-row-' + p.mint + '" class="hover:bg-slate-800/30 transition">' +
                '<td class="py-4 px-4 md:px-6 font-sans">' +
                  '<div class="font-bold text-white flex items-center gap-2 flex-wrap"><span>' + p.symbol + '</span>' + originBadge +
                  '<a href="https://solscan.io/token/' + p.mint + '" target="_blank" class="text-xs text-cyan-400 hover:underline">↗</a></div>' +
                  '<div class="text-[11px] text-slate-400 font-mono">' + p.mint.slice(0, 6) + '...' + p.mint.slice(-4) + '</div>' +
                '</td>' +
                '<td class="py-4 px-4 text-slate-300">$' + Number(p.entryPriceUsd || 0).toFixed(6) + '</td>' +
                '<td id="price-' + p.mint + '" class="py-4 px-4 text-slate-200">$' + Number(p.currentPriceUsd || 0).toFixed(6) + '</td>' +
                '<td id="pnl-' + p.mint + '" class="py-4 px-4 font-bold ' + (isProfit ? 'text-emerald-400' : 'text-rose-400') + '">' + (isProfit ? '+' : '') + Number(pnlPct).toFixed(2) + '%</td>' +
                '<td class="py-4 px-4 text-xs text-slate-400">' + Number(stopLoss).toFixed(1) + '%</td>' +
                '<td class="py-4 px-4 text-xs">' + (p.stopStatusText ? '<span class="' + ((p.trailingStopActive || p.trailingActive) ? 'text-emerald-400 font-semibold' : 'text-slate-400') + '">' + p.stopStatusText + '</span>' : '<span class="' + ((p.trailingStopActive || p.trailingActive) ? 'text-emerald-400 font-semibold' : 'text-slate-500') + '">' + ((p.trailingStopActive || p.trailingActive) ? 'ATIVO (proteção dinâmica)' : 'INATIVO (ativa a partir de +8%)') + '</span>') + '</td>' +
                '<td class="py-4 px-4 md:px-6 text-right font-sans"><button disabled data-admin-action="true" onclick="panicToken(&quot;' + p.mint + '&quot;)" title="Requer sessão ADMIN." class="admin-action bg-slate-800 text-slate-600 font-bold text-xs px-3 py-1.5 rounded-lg border border-slate-700 cursor-not-allowed">LIQUIDAR POSIÇÃO</button></td>' +
              '</tr>';
            }).join('');
          }
        }

        // 6. Trades Fechados
        const closed = (data.closedTrades || []).slice().reverse();
        const tradesTbody = document.getElementById('closed-trades-tbody');
        const tradesBadge = document.getElementById('closed-trades-badge');
        const tradesPnl = document.getElementById('closed-trades-pnl');
        const tradesWin = document.getElementById('closed-trades-win');
        if (tradesBadge) tradesBadge.textContent = closed.length + ' trade(s)';
        if (closed.length > 0) {
          const totalPnl = closed.reduce(function(a, t) { return a + Number(t.realizedPnlSol || 0); }, 0);
          const wins = closed.filter(function(t) { return Number(t.pnlPct || 0) > 0; }).length;
          if (tradesPnl) { tradesPnl.textContent = (totalPnl >= 0 ? '+' : '') + totalPnl.toFixed(6) + ' SOL'; tradesPnl.className = (totalPnl >= 0 ? 'text-emerald-400' : 'text-rose-400') + ' font-mono text-sm font-bold'; }
          if (tradesWin) { tradesWin.textContent = wins + '/' + closed.length; }
        }
        if (tradesTbody) {
          if (closed.length === 0) {
            tradesTbody.innerHTML = '<tr><td colspan="7" class="py-10 text-center text-slate-500 font-sans text-sm">Nenhum trade encerrado ainda.</td></tr>';
          } else {
            var rLabels = { STOP_LOSS: ['Stop Loss', 'bg-rose-500/15 text-rose-300 border-rose-500/30'], PARTIAL_TAKE_PROFIT_50: ['Colheita Parcial +35%', 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'], TRAILING_STOP: ['Trailing Stop', 'bg-amber-500/15 text-amber-300 border-amber-500/30'], TIME_STOP: ['Time-Stop', 'bg-slate-500/15 text-slate-300 border-slate-500/30'], TAKE_PROFIT: ['Take Profit', 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'], MANUAL: ['Manual / Pânico', 'bg-purple-500/15 text-purple-300 border-purple-500/30'], LAYA_EXIT: ['Saída Tática Laya', 'bg-cyan-500/15 text-cyan-300 border-cyan-500/30'] };
            tradesTbody.innerHTML = closed.map(function(t) {
              var pnlPct = Number(t.pnlPct || 0);
              var pnlSol = Number(t.realizedPnlSol || 0);
              var isProfit = pnlPct >= 0;
              var r = rLabels[t.exitReason] || [t.exitReason, 'bg-slate-500/15 text-slate-300 border-slate-500/30'];
              var tx = t.txSignature ? '<a href="https://solscan.io/tx/' + t.txSignature + '" target="_blank" class="text-cyan-400 hover:underline font-mono text-[11px]">' + String(t.txSignature).slice(0, 10) + '...↗</a>' : '<span class="text-slate-600 text-[11px]">sem tx</span>';
              var d = new Date(t.closedAt || t.exitTimestamp);
              var when = isNaN(d.getTime()) ? '-' : d.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
              var originBadge = t.isSentinelHandoff ? '<span class="ml-1 text-[9px] px-1.5 py-0.5 rounded bg-violet-500/20 text-violet-300 border border-violet-500/30">⚡ Sentinel</span>' : '<span class="ml-1 text-[9px] px-1.5 py-0.5 rounded bg-blue-500/15 text-blue-300 border border-blue-500/30">🎯 DEX 5m</span>';
              return '<tr class="border-b border-slate-800/60 hover:bg-slate-800/30">' +
                '<td class="py-3 px-4 text-slate-400 text-xs font-mono whitespace-nowrap">' + when + '</td>' +
                '<td class="py-3 px-4"><div class="flex items-center gap-2 flex-wrap"><span class="font-semibold text-slate-200">' + t.symbol + '</span>' + originBadge + '<a href="https://solscan.io/token/' + t.mint + '" target="_blank" class="text-xs text-cyan-400 hover:underline">↗</a></div><div class="text-[11px] text-slate-500 font-mono">' + String(t.mint).slice(0, 6) + '...' + String(t.mint).slice(-4) + '</div></td>' +
                '<td class="py-3 px-4 text-slate-300 font-mono text-xs">$' + Number(t.entryPriceUsd || 0).toFixed(8) + '</td>' +
                '<td class="py-3 px-4 text-slate-200 font-mono text-xs">$' + Number(t.exitPriceUsd || 0).toFixed(8) + '</td>' +
                '<td class="py-3 px-4 font-mono text-xs ' + (isProfit ? 'text-emerald-400' : 'text-rose-400') + '">' + (isProfit ? '+' : '') + pnlSol.toFixed(6) + ' SOL<div class="text-[10px] opacity-80">' + (isProfit ? '+' : '') + pnlPct.toFixed(2) + '%</div></td>' +
                '<td class="py-3 px-4"><span class="inline-block px-2 py-0.5 rounded text-[10px] border ' + r[1] + '">' + r[0] + '</span></td>' +
                '<td class="py-3 px-4">' + tx + '</td>' +
              '</tr>';
            }).join('');
          }
        }

        // 7. Logs
        const logs = data.recentLogs || (data.scannerLogs ? data.scannerLogs.map(function(l) { return typeof l === 'string' ? l : '[' + l.timestamp + '] ' + l.message; }) : []);
        const logsContainer = document.getElementById('logs-container');
        if (logsContainer && logs.length > 0) {
          logsContainer.innerHTML = logs.map(function(text) {
            const colorClass = text.includes('APROVADO') || text.includes('Graduation Dip') ? 'text-emerald-400' : text.includes('SentinelHandoff') ? 'text-violet-300' : text.includes('⚠️') || text.includes('VETADO') ? 'text-amber-400' : text.includes('🚨') || text.includes('Erro') ? 'text-rose-400' : 'text-slate-300';
            return '<div class="' + colorClass + '">' + text + '</div>';
          }).join('');
          logsContainer.scrollTop = logsContainer.scrollHeight;
        }

        applyAdminUi();
      } catch (err) {
        // Silencioso em caso de latência momentânea
      }
    }

    void refreshAuthState();
    void pollDashboard();
    setInterval(pollDashboard, POLL_INTERVAL_MS);
  </script>
</body>
</html>`;
}
