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

function formatPumpLag(ms?: number): string {
  if (ms == null || !Number.isFinite(ms)) return '—';
  if (Math.abs(ms) < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

function renderPumpObservatorySection(state: DashboardState): string {
  const pump = state.pumpObservatory;
  const recent = pump?.recent || [];
  const rows = recent.slice(0, 12).map(token => {
    const progress = token.progressPct == null ? '—' : `${token.progressPct.toFixed(2)}%`;
    const status = token.complete ? 'GRADUADA' : 'CURVA ATIVA';
    return `
      <tr class="border-b border-slate-800/60 hover:bg-slate-800/30">
        <td class="py-3 px-4">
          <div class="font-semibold text-slate-200 flex items-center gap-2">
            <span>${escapeDashboardHtml(token.symbol || 'UNKNOWN')}</span>
            <a href="${escapeDashboardHtml(token.solscanUrl)}" target="_blank" rel="noopener" class="text-cyan-400 hover:underline text-xs">Solscan↗</a>
            <a href="${escapeDashboardHtml(token.pumpUrl)}" target="_blank" rel="noopener" class="text-fuchsia-400 hover:underline text-xs">Pump↗</a>
          </div>
          <div class="text-[10px] text-slate-500 font-mono">${escapeDashboardHtml(token.mint.slice(0, 8))}...${escapeDashboardHtml(token.mint.slice(-6))}</div>
        </td>
        <td class="py-3 px-4 font-mono text-xs text-slate-300">${progress}</td>
        <td class="py-3 px-4 text-xs ${token.complete ? 'text-emerald-400' : 'text-amber-300'}">${status}</td>
        <td class="py-3 px-4 font-mono text-xs text-slate-400">${formatPumpLag(token.createToObserverLagMs)}</td>
        <td class="py-3 px-4 font-mono text-xs text-slate-400">${token.slot}</td>
        <td class="py-3 px-4">
          <a href="${escapeDashboardHtml(token.transactionUrl)}" target="_blank" rel="noopener" class="text-cyan-400 hover:underline font-mono text-[11px]">${escapeDashboardHtml(token.signature.slice(0, 10))}...↗</a>
        </td>
      </tr>`;
  }).join('');

  return `
    <section class="bg-slate-900/70 border border-fuchsia-900/40 rounded-2xl overflow-hidden shadow-xl">
      <div class="p-4 md:px-6 border-b border-slate-800/80 bg-slate-900/90 flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h2 class="text-base md:text-lg font-bold text-white">🧪 Pump.fun Observatory <span class="text-[10px] px-2 py-0.5 rounded bg-fuchsia-500/15 text-fuchsia-300 border border-fuchsia-500/30">READ-ONLY</span></h2>
          <p class="text-xs text-slate-400 mt-1">Nascimento on-chain → bonding curve → graduação. Sensor informacional; não envia ordens Pump.</p>
        </div>
        <div id="pump-observatory-status" class="text-xs font-mono ${pump?.running ? 'text-emerald-400' : 'text-slate-500'}">${pump?.running ? 'STREAM ATIVO' : pump?.enabled ? 'AGUARDANDO STREAM' : 'DESABILITADO'}</div>
      </div>
      <div class="grid grid-cols-2 lg:grid-cols-4 gap-3 p-4">
        <div class="bg-slate-950/50 border border-slate-800 rounded-xl p-3"><div class="text-[10px] uppercase text-slate-500">Criações observadas</div><div id="pump-created-count" class="text-xl font-black font-mono text-fuchsia-300">${pump?.totalCreatedObserved ?? 0}</div></div>
        <div class="bg-slate-950/50 border border-slate-800 rounded-xl p-3"><div class="text-[10px] uppercase text-slate-500">Curvas ativas</div><div id="pump-active-count" class="text-xl font-black font-mono text-amber-300">${pump?.activeCurves ?? 0}</div></div>
        <div class="bg-slate-950/50 border border-slate-800 rounded-xl p-3"><div class="text-[10px] uppercase text-slate-500">Graduações</div><div id="pump-graduated-count" class="text-xl font-black font-mono text-emerald-300">${pump?.graduatedCount ?? 0}</div></div>
        <div class="bg-slate-950/50 border border-slate-800 rounded-xl p-3"><div class="text-[10px] uppercase text-slate-500">Create → Nexus</div><div id="pump-last-lag" class="text-xl font-black font-mono text-cyan-300">${formatPumpLag(pump?.lastCreateToObserverLagMs)}</div></div>
      </div>
      <div class="overflow-x-auto">
        <table class="w-full text-left">
          <thead><tr class="border-y border-slate-800 text-[10px] uppercase tracking-wider text-slate-500"><th class="py-2 px-4">Token</th><th class="py-2 px-4">Curva</th><th class="py-2 px-4">Estado</th><th class="py-2 px-4">Lag</th><th class="py-2 px-4">Slot</th><th class="py-2 px-4">TX</th></tr></thead>
          <tbody id="pump-observatory-tbody">${rows || '<tr><td colspan="6" class="py-8 text-center text-slate-500 text-sm">Aguardando CreateEvent oficial da Pump.fun...</td></tr>'}</tbody>
        </table>
      </div>
      ${pump?.lastError ? `<div class="p-3 text-xs text-amber-300 border-t border-slate-800">Último erro de leitura: ${escapeDashboardHtml(pump.lastError)}</div>` : ''}
    </section>`;
}

function renderPumpStrategyLabSection(state: DashboardState): string {
  const lab = state.pumpStrategyLab;
  const readiness = lab?.routeReadiness;
  const routeRate = readiness ? `${(readiness.compliantRouteRate * 100).toFixed(1)}% (${readiness.compliantRouteMints}/${readiness.probedMints})` : '—';
  const momentZeroRate = readiness ? `${(readiness.momentZeroRate * 100).toFixed(1)}% (${readiness.momentZeroMints}/${readiness.probedMints})` : '—';
  const medianLag = readiness?.medianFirstCompliantRouteLagMs == null
    ? '—'
    : `${(readiness.medianFirstCompliantRouteLagMs / 1000).toFixed(1)}s`;
  const rows = (lab?.strategies || []).map(item => {
    const replayText = (item.exitPolicyReplays || [])
      .map(replay =>
        `${escapeDashboardHtml(replay.policy)}: ${Number(replay.meanNetReturnPct).toFixed(2)}% | giveback ${Number(replay.meanMaxGiveBackFromPeakPct).toFixed(1)}%`
      )
      .join('<br>');
    return `
    <tr class="border-b border-slate-800/60">
      <td class="py-2 px-3 font-mono text-xs text-fuchsia-300">${escapeDashboardHtml(item.entryWindow || item.cohort)}</td>
      <td class="py-2 px-3 font-mono text-xs text-amber-300">${escapeDashboardHtml(item.horizon || '—')}</td>
      <td class="py-2 px-3 font-mono text-xs text-slate-300">${escapeDashboardHtml(item.cohort)}</td>
      <td class="py-2 px-3 text-xs text-slate-300">${escapeDashboardHtml(item.venue)}</td>
      <td class="py-2 px-3 text-xs text-cyan-300">${escapeDashboardHtml(item.state)}</td>
      <td class="py-2 px-3 font-mono text-xs text-slate-400">${item.sampleCount}</td>
      <td class="py-2 px-3 font-mono text-xs text-slate-400">${item.meanNetReturnPct == null ? '—' : item.meanNetReturnPct.toFixed(2) + '%'}</td>
      <td class="py-2 px-3 font-mono text-xs text-slate-400">${(item.executableExitRate * 100).toFixed(1)}%</td>
      <td class="py-2 px-3 font-mono text-[10px] text-slate-400">${replayText || '—'}</td>
    </tr>`;
  }).join('');

  return `
    <section class="bg-slate-900/70 border border-cyan-900/40 rounded-2xl overflow-hidden shadow-xl">
      <div class="p-4 md:px-6 border-b border-slate-800/80 bg-slate-900/90 flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h2 class="text-base md:text-lg font-bold text-white">📐 Pump Strategy Lab <span class="text-[10px] px-2 py-0.5 rounded bg-cyan-500/15 text-cyan-300 border border-cyan-500/30">SHADOW</span></h2>
          <p class="text-xs text-slate-400 mt-1">Compara cohort, venue, custos e saída executável. Nenhuma estratégia é promovida sem evidência suficiente.</p>
          <p class="text-xs text-slate-400 mt-1">Replays sobre cotações amostradas, com custos de rede/prioridade estimados por transação.</p>
        </div>
        <div id="pump-strategy-lab-samples" class="text-xs font-mono text-slate-400">Amostras: ${lab?.totalSamples ?? 0}</div>
      </div>
      <div id="pump-strategy-lab-error" ${lab?.lastError ? '' : 'hidden'} class="p-3 text-xs text-amber-300 border-b border-slate-800">${lab?.lastError ? 'Coleta temporariamente indisponível; aguardando recuperação.' : ''}</div>
      <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3 p-4">
        <div class="bg-slate-950/50 border border-slate-800 rounded-xl p-3">
          <div class="text-[10px] uppercase text-slate-500">Jupiter economicamente preferido</div>
          <div id="pump-strategy-lab-plan" class="text-lg font-black font-mono text-cyan-300">${escapeDashboardHtml(lab?.preferredJupiterPlan || 'INSUFFICIENT_DATA')}</div>
        </div>
        <div class="bg-slate-950/50 border border-slate-800 rounded-xl p-3">
          <div class="text-[10px] uppercase text-slate-500">Resultado líquido após custo do plano</div>
          <div id="pump-strategy-lab-net" class="text-lg font-black font-mono text-emerald-300">${lab?.preferredPlanNetAfterCostSol == null ? '—' : lab.preferredPlanNetAfterCostSol.toFixed(6) + ' SOL'}</div>
        </div>
        <div class="bg-slate-950/50 border border-slate-800 rounded-xl p-3">
          <div class="text-[10px] uppercase text-slate-500">Primeira rota ≤ 750 bps</div>
          <div id="pump-strategy-route-rate" class="text-lg font-black font-mono text-cyan-300">${routeRate}</div>
          <div id="pump-strategy-route-lag" class="text-[10px] font-mono text-slate-500">latência mediana: ${medianLag}</div>
        </div>
        <div class="bg-slate-950/50 border border-slate-800 rounded-xl p-3">
          <div class="text-[10px] uppercase text-slate-500">Entrada executável até 15s</div>
          <div id="pump-strategy-moment-zero" class="text-lg font-black font-mono text-fuchsia-300">${momentZeroRate}</div>
          <div class="text-[10px] text-slate-500">Proxy SHADOW de momento 0; usa o horário concluído da cotação.</div>
        </div>
      </div>
      <div class="overflow-x-auto">
        <table class="w-full text-left">
          <thead><tr class="border-y border-slate-800 text-[10px] uppercase tracking-wider text-slate-500"><th class="py-2 px-3">Janela</th><th class="py-2 px-3">Horizonte</th><th class="py-2 px-3">Cohort</th><th class="py-2 px-3">Venue</th><th class="py-2 px-3">Estado</th><th class="py-2 px-3">N</th><th class="py-2 px-3">Retorno líquido</th><th class="py-2 px-3">Saída executável</th><th class="py-2 px-3">Replay de saída</th></tr></thead>
          <tbody id="pump-strategy-lab-tbody">${rows || '<tr><td colspan="9" class="py-6 text-center text-slate-500 text-sm">INSUFFICIENT_DATA — coletando evidência shadow.</td></tr>'}</tbody>
        </table>
      </div>
    </section>`;
}

function renderPumpSellFallbackSection(state: DashboardState): string {
  const fallback = state.pumpDirectSellFallback || {
    enabled: false,
    selectedPath: 'NONE' as const,
    confirmationState: 'IDLE' as const,
    estimatedCostSol: null,
    fallbackReason: null
  };
  const status = fallback.enabled ? 'ARMADO' : 'DESABILITADO';
  const cost = fallback.estimatedCostSol == null ? 'N/D' : fallback.estimatedCostSol.toFixed(9) + ' SOL';
  return `
    <section class="bg-slate-900/70 border border-rose-900/40 rounded-2xl p-4 shadow-xl">
      <div class="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h2 class="text-base font-bold text-white">🛟 Pump SELL Fallback <span class="text-[10px] px-2 py-0.5 rounded bg-rose-500/15 text-rose-300 border border-rose-500/30">SELL-only</span></h2>
          <p class="text-xs text-slate-400 mt-1">Fallback direto de proteção; nunca autoriza BUY direto.</p>
        </div>
        <div id="pump-sell-fallback-enabled" class="text-xs font-mono ${fallback.enabled ? 'text-emerald-400' : 'text-slate-500'}">${status}</div>
      </div>
      <div class="grid grid-cols-2 lg:grid-cols-4 gap-3 mt-4">
        <div><div class="text-[10px] uppercase text-slate-500">Última rota</div><div id="pump-sell-fallback-path" class="font-mono text-sm text-cyan-300">${escapeDashboardHtml(fallback.selectedPath)}</div></div>
        <div><div class="text-[10px] uppercase text-slate-500">Confirmação</div><div id="pump-sell-fallback-confirmation" class="font-mono text-sm text-amber-300">${escapeDashboardHtml(fallback.confirmationState)}</div></div>
        <div><div class="text-[10px] uppercase text-slate-500">Custo estimado</div><div id="pump-sell-fallback-cost" class="font-mono text-sm text-slate-300">${cost}</div></div>
        <div><div class="text-[10px] uppercase text-slate-500">Motivo fallback</div><div id="pump-sell-fallback-reason" class="font-mono text-xs text-slate-400">${escapeDashboardHtml(fallback.fallbackReason || '—')}</div></div>
      </div>
    </section>`;
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

  const rows = trades.slice().reverse().map(t => {
    const pnlPct = Number(t.pnlPct || 0) * 100;
    const pnlSol = Number(t.pnlSolEst || 0);
    const isProfit = pnlPct >= 0;
    const reason = EXIT_REASON_LABELS[t.exitReason] || { label: t.exitReason, cls: 'bg-slate-500/15 text-slate-300 border-slate-500/30' };
    const closedAt = new Date(t.exitTimestamp).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    const txLink = t.txSignature
      ? `<a href="https://solscan.io/tx/${t.txSignature}" target="_blank" class="text-cyan-400 hover:underline font-mono text-[11px]">${t.txSignature.slice(0, 10)}...↗</a>`
      : '<span class="text-slate-600 text-[11px]">sem tx</span>';

    return `
      <tr class="border-b border-slate-800/60 hover:bg-slate-800/30">
        <td class="py-3 px-4 text-slate-400 text-xs font-mono whitespace-nowrap">${closedAt}</td>
        <td class="py-3 px-4">
          <div class="flex items-center gap-2">
            <span class="font-semibold text-slate-200">${t.symbol}</span>
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

  return `
    <section class="bg-slate-900/70 border border-slate-800 rounded-2xl p-4 md:p-6 shadow-xl">
      <div class="flex items-center justify-between mb-4 flex-wrap gap-2">
        <h2 class="text-sm md:text-base font-bold text-white flex items-center gap-2">
          <span>📜 Histórico de Trades Fechados</span>
          <span id="closed-trades-badge" class="text-[10px] font-mono px-2 py-0.5 rounded bg-slate-800 text-slate-400">${trades.length} trade(s)</span>
        </h2>
        <div class="flex items-center gap-4 text-xs font-mono">
          <span class="text-slate-400">PnL realizado:
            <span id="closed-trades-pnl" class="${realizedPnl >= 0 ? 'text-emerald-400' : 'text-rose-400'} font-bold">${realizedPnl >= 0 ? '+' : ''}${realizedPnl.toFixed(6)} SOL</span>
          </span>
          <span class="text-slate-400">Acerto: <span id="closed-trades-win" class="text-cyan-400 font-bold">${wins}/${trades.length}</span></span>
        </div>
      </div>
      <div class="overflow-x-auto">
        <table class="w-full text-left">
          <thead>
            <tr class="border-b border-slate-700 text-[10px] uppercase tracking-wider text-slate-500">
              <th class="py-2 px-4 font-semibold">Encerramento</th>
              <th class="py-2 px-4 font-semibold">Token / Mint</th>
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
      theme: {
        extend: {
          colors: {
            brand: {
              50: '#F0F9FF',
              500: '#0284C7',
              600: '#0369A1',
              900: '#0C4A6E'
            }
          }
        }
      }
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

    <!-- CABEÇALHO SUPERIOR INSTITUCIONAL -->
    <header class="bg-slate-900/80 border border-slate-800 rounded-2xl p-4 md:p-6 shadow-2xl backdrop-blur-md flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
      <div class="space-y-1">
        <div class="flex items-center gap-3">
          <div class="h-3 w-3 rounded-full bg-emerald-500 animate-ping"></div>
          <h1 class="text-xl md:text-2xl font-black tracking-tight text-white flex items-center gap-2">
            NEXUS QUANT SOLANA <span class="text-xs font-semibold px-2 py-0.5 rounded-full bg-cyan-500/20 text-cyan-400 border border-cyan-500/30">SISTEMA 24/7</span>
          </h1>
        </div>
        <div class="flex flex-wrap items-center gap-2 text-xs text-slate-400">
          <span>Carteira Phantom:</span>
          <a href="https://solscan.io/account/${state.wallet}" target="_blank" class="font-mono text-cyan-400 hover:underline flex items-center gap-1">
            ${state.wallet.slice(0, 6)}...${state.wallet.slice(-6)}
            <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"/></svg>
          </a>
          <span class="text-slate-600">|</span>
          <span>Modo: <strong class="${state.dryRun ? 'text-amber-400' : 'text-emerald-400'}">${state.dryRun ? 'DRY-RUN (Simulação)' : 'EXECUÇÃO REAL ON-CHAIN'}</strong></span>
          <span class="text-slate-600">|</span>
          <span>Atualizado: <span id="last-updated" class="font-mono text-slate-300">${new Date(state.lastUpdated || Date.now()).toLocaleTimeString()}</span></span>
        </div>
      </div>

      <div class="flex flex-wrap items-center gap-3 w-full md:w-auto justify-end">
        <!-- Saldo Carteira Badge -->
        <div class="bg-slate-800/80 border border-slate-700/80 rounded-xl px-4 py-2 flex items-center gap-3 shadow-inner">
          <div class="text-xs text-slate-400 uppercase tracking-wider font-semibold">Saldo</div>
          <div id="wallet-balance" class="text-lg md:text-xl font-bold font-mono text-emerald-400">
            ${Number(state.balanceSol || 0).toFixed(4)} SOL
          </div>
        </div>

        <!-- Sentinel Status Badge -->
        <div class="bg-slate-800/80 border border-slate-700/80 rounded-xl px-3 py-2 flex items-center gap-2">
          <span id="sentinel-dot" class="h-2.5 w-2.5 rounded-full ${state.circuitBreakerActive ? 'bg-rose-500 animate-pulse' : 'bg-emerald-500 animate-pulse'}"></span>
          <div class="text-xs">
            <span class="text-slate-400 font-medium">Sentinel:</span>
            <strong id="sentinel-text" class="${state.circuitBreakerActive ? 'text-rose-400' : 'text-emerald-400'} ml-1 font-mono">
              ${state.circuitBreakerActive ? 'DISJUNTOR ATIVO' : (state.macroRegime || 'SEGURO')}
            </strong>
          </div>
        </div>

        <button id="admin-login-button" onclick="openAdminModal()" class="bg-cyan-500/15 hover:bg-cyan-500/25 text-cyan-300 font-bold text-xs md:text-sm px-4 py-2.5 rounded-xl border border-cyan-500/30 flex items-center gap-2 transition">
          <span class="text-base">🔐</span>
          <span id="admin-login-label">ENTRAR ADMIN</span>
        </button>
        <div id="admin-session-controls" class="hidden flex items-center gap-2">
          <span id="admin-session-name" class="text-xs text-emerald-300 font-mono"></span>
          <button id="panic-all-button" onclick="panicAll()" class="bg-rose-600 hover:bg-rose-500 text-white font-black text-xs px-4 py-2.5 rounded-xl border border-rose-400/40 shadow-lg shadow-rose-950/30">
            🚨 PÂNICO GERAL
          </button>
          <button onclick="logoutAdmin()" class="bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs px-3 py-2.5 rounded-xl border border-slate-700">SAIR</button>
        </div>
      </div>
    </header>

    <!-- ESTADO OPERACIONAL REAL -->
    <section class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
      <div class="bg-slate-900/70 border border-slate-800 rounded-xl p-3">
        <div class="text-[10px] uppercase tracking-wider text-slate-500">Execução</div>
        <div id="op-execution-mode" class="mt-1 font-bold ${state.dryRun ? 'text-amber-400' : 'text-emerald-400'}">
          ${state.dryRun ? 'DRY-RUN' : 'REAL ON-CHAIN'}
        </div>
        <div class="text-[10px] text-slate-500 mt-1">RPC: ${state.activeRpcUrl || 'n/a'}</div>
      </div>
      <div class="bg-slate-900/70 border border-slate-800 rounded-xl p-3">
        <div class="text-[10px] uppercase tracking-wider text-slate-500">Proteção de Saída</div>
        <div id="op-exit-health-status" class="mt-1 font-bold ${
          state.exitPathHealth?.state === 'HEALTHY'
            ? 'text-emerald-400'
            : state.exitPathHealth?.state === 'EMERGENCY'
              ? 'text-rose-400'
              : 'text-amber-400'
        }">
          ${state.exitPathHealth?.state || 'HEALTHY'}
        </div>
        <div id="op-exit-health-detail" class="text-[10px] text-slate-500 mt-1">
          ${escapeDashboardHtml(
            state.exitPathHealth?.reason ||
            `Falhas: ${state.exitPathHealth?.maxFailures ?? 0} · novas entradas ${state.exitPathHealth?.canOpenNewPosition === false ? 'PAUSADAS' : 'LIBERADAS'}`
          )}
        </div>
      </div>
      <div class="bg-slate-900/70 border border-slate-800 rounded-xl p-3">
        <div class="text-[10px] uppercase tracking-wider text-slate-500">Laya Sistema 1</div>
        <div id="op-laya-status" class="mt-1 font-bold ${state.laya?.health === 'OK' ? 'text-emerald-400' : 'text-amber-400'}">
          ${state.laya?.health || 'UNKNOWN'} · ${state.laya?.tacticalMode || 'UNKNOWN'}
        </div>
        <div id="op-laya-detail" class="text-[10px] text-slate-500 mt-1">
          ${(state.laya?.loaded || []).join(',') || 'checkpoint não confirmado'}
        </div>
      </div>
      <div class="bg-slate-900/70 border border-slate-800 rounded-xl p-3">
        <div class="text-[10px] uppercase tracking-wider text-slate-500">Rent Recovery</div>
        <div id="op-rent-status" class="mt-1 font-bold ${state.rentRecovery?.autoEnabled ? 'text-emerald-400' : 'text-slate-400'}">
          ${state.rentRecovery?.autoEnabled ? 'AUTO ATIVO' : 'AUTO DESLIGADO'}
        </div>
        <div id="op-rent-detail" class="text-[10px] text-slate-500 mt-1">
          ${(state.rentRecovery?.totalReclaimedSolActual || 0).toFixed(9)} SOL de rent bruto observados nesta execução
        </div>
      </div>
      <div class="bg-slate-900/70 border border-slate-800 rounded-xl p-3">
        <div class="text-[10px] uppercase tracking-wider text-slate-500">Admin</div>
        <div id="op-auth-status" class="mt-1 font-bold ${state.auth?.configured ? 'text-cyan-400' : 'text-rose-400'}">
          ${state.auth?.configured ? (state.auth.needsBootstrap ? 'CADASTRO INICIAL NECESSÁRIO' : 'LOGIN DISPONÍVEL') : 'AUTH INDISPONÍVEL'}
        </div>
        <div id="op-auth-detail" class="text-[10px] text-slate-500 mt-1">Pânico e ações manuais exigem sessão ADMIN</div>
      </div>
    </section>

    <!-- GRID DE MÉTRICAS DO FUNIL DE MATURAÇÃO -->
    <section class="grid grid-cols-2 lg:grid-cols-4 gap-4">
      <!-- Card 1: Incubadora -->
      <div class="bg-slate-900/60 border border-slate-800/90 rounded-2xl p-4 shadow-lg flex flex-col justify-between hover:border-slate-700 transition">
        <div class="flex items-center justify-between text-slate-400 text-xs font-medium">
          <span>🕒 Incubadora (Aguardando)</span>
          <span class="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-400">&lt; 5 min</span>
        </div>
        <div id="metric-incubator-waiting" class="text-2xl md:text-3xl font-black font-mono text-cyan-400 mt-2">
          ${waitingCount}
        </div>
        <div class="text-[11px] text-slate-500 mt-1">Pools com menos de 5 min aguardando maturidade</div>
      </div>

      <!-- Card 2: Maturos -->
      <div class="bg-slate-900/60 border border-slate-800/90 rounded-2xl p-4 shadow-lg flex flex-col justify-between hover:border-slate-700 transition">
        <div class="flex items-center justify-between text-slate-400 text-xs font-medium">
          <span>🎯 Maturos para análise</span>
          <span class="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400">5-60 min</span>
        </div>
        <div id="metric-incubator-mature" class="text-2xl md:text-3xl font-black font-mono text-amber-400 mt-2">
          ${matureCount}
        </div>
        <div class="text-[11px] text-slate-500 mt-1">Avaliados em lote via DexScreener</div>
      </div>

      <!-- Card 3: Descartes Técnicos -->
      <div class="bg-slate-900/60 border border-slate-800/90 rounded-2xl p-4 shadow-lg flex flex-col justify-between hover:border-slate-700 transition">
        <div class="flex items-center justify-between text-slate-400 text-xs font-medium">
          <span>🛡️ Descartes Técnicos</span>
          <span class="text-[10px] px-1.5 py-0.5 rounded bg-slate-500/10 text-slate-400">Filtro $15k</span>
        </div>
        <div id="metric-technical-discards" class="text-2xl md:text-3xl font-black font-mono text-rose-400 mt-2">
          ${discardsCount}
        </div>
        <div class="text-[11px] text-slate-500 mt-1">Barrados por liquidez ou momentum</div>
      </div>

      <!-- Card 4: Elegíveis para Auditoria -->
      <div class="bg-slate-900/60 border border-slate-800/90 rounded-2xl p-4 shadow-lg flex flex-col justify-between hover:border-slate-700 transition">
        <div class="flex items-center justify-between text-slate-400 text-xs font-medium">
          <span>🧠 Elegíveis para Auditoria</span>
          <span class="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400">Pré-filtro técnico</span>
        </div>
        <div id="metric-entry-eligible" class="text-2xl md:text-3xl font-black font-mono text-emerald-400 mt-2">
          ${entryEligibleCount}
        </div>
        <div class="text-[11px] text-slate-500 mt-1">Candidatos técnicos aguardando auditoria de risco/decisão</div>
      </div>
    </section>

    <!-- OBSERVATÓRIO PUMP.FUN READ-ONLY -->
    ${renderPumpObservatorySection(state)}

    <!-- LABORATÓRIO ECONÔMICO PUMP / JUPITER -->
    ${renderPumpStrategyLabSection(state)}

    <!-- FALLBACK DIRETO PUMP SELL-ONLY -->
    ${renderPumpSellFallbackSection(state)}

    <!-- TABELA DE POSIÇÕES ATIVAS MONITORADAS -->
    <section class="bg-slate-900/70 border border-slate-800 rounded-2xl overflow-hidden shadow-xl">
      <div class="p-4 md:px-6 border-b border-slate-800/80 flex items-center justify-between bg-slate-900/90">
        <div>
          <h2 class="text-base md:text-lg font-bold text-white flex items-center gap-2">
            <span>⚡ Posições Ativas sob Gestão</span>
            <span id="active-positions-badge" class="text-xs px-2 py-0.5 rounded-full bg-slate-800 text-slate-300 font-mono">
              ${state.positions.length} / 2
            </span>
          </h2>
          <p class="text-xs text-slate-400 mt-0.5">PnL/Stop Jupiter executável 1.5s · DexScreener referência · SL inicial: -6% · Trailing momentum: +8%/-6% do topo · Runner pós-parcial: -10% do topo</p>
        </div>
        <button id="sweep-rent-button" disabled onclick="sweepRentManual()" title="Requer sessão ADMIN." class="admin-action text-xs font-semibold px-3 py-1.5 rounded-lg bg-slate-900 text-slate-600 border border-slate-800 flex items-center gap-1.5 cursor-not-allowed">
          <span>🧹</span>
          <span>Varrer contas SPL vazias</span>
        </button>
      </div>

      <div class="overflow-x-auto">
        <table class="w-full text-left text-sm">
          <thead class="bg-slate-950/60 text-slate-400 text-xs uppercase tracking-wider font-semibold border-b border-slate-800">
            <tr>
              <th class="py-3 px-4 md:px-6">Token / Mint</th>
              <th class="py-3 px-4">Preço Entrada</th>
              <th class="py-3 px-4">Preço Sensor</th>
              <th class="py-3 px-4">PnL Sensor</th>
              <th class="py-3 px-4">Stop Loss</th>
              <th class="py-3 px-4">Trailing Stop</th>
              <th class="py-3 px-4 md:px-6 text-right">Ação</th>
            </tr>
          </thead>
          <tbody id="positions-tbody" class="divide-y divide-slate-800/60 font-mono">
            ${state.positions.length === 0 ? `
              <tr>
                <td colspan="7" class="py-8 text-center text-slate-500 font-sans">
                  Varredura ativa. Aguardando candidato aprovado pelos filtros determinísticos e momentum...
                </td>
              </tr>
            ` : state.positions.map(p => {
              const pnlVal = Number(p.pnlPct || 0);
              const isProfit = pnlVal >= 0;
              return `
              <tr id="pos-row-${p.mint}" class="hover:bg-slate-800/30 transition">
                <td class="py-4 px-4 md:px-6 font-sans">
                  <div class="font-bold text-white flex items-center gap-2">
                    <span>${p.symbol}</span>
                    <a href="https://solscan.io/token/${p.mint}" target="_blank" class="text-xs text-cyan-400 hover:underline">↗</a>
                  </div>
                  <div class="text-[11px] text-slate-400 font-mono">${p.mint.slice(0, 6)}...${p.mint.slice(-4)}</div>
                </td>
                <td class="py-4 px-4 text-slate-300">$${Number(p.entryPriceUsd).toFixed(6)}</td>
                <td id="price-${p.mint}" class="py-4 px-4 text-slate-200">$${Number(p.currentPriceUsd).toFixed(6)}</td>
                <td id="pnl-${p.mint}" class="py-4 px-4 font-bold ${isProfit ? 'text-emerald-400' : 'text-rose-400'}">
                  ${isProfit ? '+' : ''}${(pnlVal * 100).toFixed(2)}%
                </td>
                <td class="py-4 px-4 text-xs text-slate-400">${(Number(p.stopLossPct) * 100).toFixed(1)}%</td>
                <td class="py-4 px-4 text-xs">
                  <span class="${p.trailingActive ? 'text-emerald-400 font-semibold' : 'text-slate-500'}">
                    ${p.stopStatusText || (p.trailingActive ? 'ATIVO (proteção dinâmica)' : 'INATIVO (ativa a partir de +8%)')}
                  </span>
                </td>
                <td class="py-4 px-4 md:px-6 text-right font-sans">
                  <button disabled data-admin-action="true" onclick="panicToken('${p.mint}', '${p.symbol.replace(/\'/g, '')}')" title="Requer sessão ADMIN." class="admin-action bg-slate-800 text-slate-600 font-bold text-xs px-3 py-1.5 rounded-lg border border-slate-700 cursor-not-allowed">
                    LIQUIDAR POSIÇÃO
                  </button>
                </td>
              </tr>
            `;
            }).join('')}
          </tbody>
        </table>
      </div>
    </section>

    <!-- HISTÓRICO DE TRADES FECHADOS -->
    ${renderClosedTradesSection(state)}

    <!-- DECISION JOURNAL & CALIBRAÇÃO DE EV v2.5.0 (4 CARDS) -->
    ${renderJournalSection()}

    <!-- PAINEL DE TELEMETRIA E LOGS EM TEMPO REAL -->
    <section class="bg-slate-900/70 border border-slate-800 rounded-2xl p-4 md:p-6 shadow-xl space-y-3">
      <div class="flex items-center justify-between">
        <h2 class="text-sm md:text-base font-bold text-white flex items-center gap-2">
          <span>📡 Telemetria & Logs em Tempo Real</span>
          <span class="h-2 w-2 rounded-full bg-cyan-400 animate-ping"></span>
        </h2>
        <span class="text-xs text-slate-500 font-mono">Auto-scroll ativo</span>
      </div>
      <div id="logs-container" class="bg-black/90 border border-slate-800/80 rounded-xl p-4 font-mono text-xs text-slate-300 h-64 overflow-y-auto space-y-1.5">
        ${(state.scannerLogs || []).map(l => {
          const text = typeof l === 'string' ? l : `[${l.timestamp}] ${l.message}`;
          const colorClass = (text.includes('Elegíveis para Auditoria: 1') || text.includes('Elegíveis para Auditoria: 1')) || text.includes('APROVADO')
            ? 'text-emerald-400'
            : text.includes('⚠️') || text.includes('VETADO')
            ? 'text-amber-400'
            : text.includes('🚨') || text.includes('Erro')
            ? 'text-rose-400'
            : 'text-slate-300';
          return `<div class="${colorClass}">${text}</div>`;
        }).join('')}
      </div>
    </section>

  </div>

  <!-- MODAL ADMIN: cadastro inicial ou login -->
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
        <div class="text-xs text-amber-300">Primeiro acesso: crie o administrador. O código mestre é usado uma única vez e não é salvo no navegador.</div>
        <input id="admin-register-name" type="text" autocomplete="name" placeholder="Nome do administrador" class="w-full bg-slate-900 border border-slate-700 rounded-xl px-3 py-2.5 text-sm text-white outline-none focus:border-cyan-500">
        <input id="admin-register-email" type="email" autocomplete="username" placeholder="Email admin" class="w-full bg-slate-900 border border-slate-700 rounded-xl px-3 py-2.5 text-sm text-white outline-none focus:border-cyan-500">
        <input id="admin-register-password" type="password" autocomplete="new-password" placeholder="Senha (mín. 8 caracteres)" class="w-full bg-slate-900 border border-slate-700 rounded-xl px-3 py-2.5 text-sm text-white outline-none focus:border-cyan-500">
        <input id="admin-register-bootstrap" type="password" autocomplete="off" placeholder="Código mestre NEXUS_ADMIN_TOKEN" class="w-full bg-slate-900 border border-amber-700/60 rounded-xl px-3 py-2.5 text-sm text-white outline-none focus:border-amber-500">
        <button onclick="submitAdminRegistration()" class="w-full bg-amber-600 hover:bg-amber-500 text-white font-bold rounded-xl py-2.5">CADASTRAR ADMIN</button>
      </div>

      <div id="admin-auth-message" class="hidden text-xs rounded-lg p-2.5"></div>
    </div>
  </div>

  <!-- SCRIPT DE AÇÕES & POLLING NATIVO A CADA 2.5s -->
  <script>
    let adminSession = null;

    function escapePumpHtml(value) {
      return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) {
        return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[ch];
      });
    }

    function pumpLagText(ms) {
      const n = Number(ms);
      if (!Number.isFinite(n)) return '—';
      return Math.abs(n) < 1000 ? Math.round(n) + ' ms' : (n / 1000).toFixed(1) + ' s';
    }
    let adminAuthStatus = { configured: false, needsBootstrap: false };

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
      if (!adminSession || adminSession.role !== 'ADMIN') {
        throw new Error('Faça login como ADMIN para executar esta ação.');
      }
      const opts = Object.assign({ credentials: 'same-origin' }, options || {});
      const res = await fetch(url, opts);
      if (res.status === 401) {
        await logoutAdmin(false);
        throw new Error('Sessão administrativa expirada. Faça login novamente.');
      }
      return res;
    }

    function openAdminModal() {
      const modal = document.getElementById('admin-auth-modal');
      if (!modal) return;
      modal.classList.remove('hidden');
      modal.classList.add('flex');
      const registerPanel = document.getElementById('admin-register-panel');
      const loginPanel = document.getElementById('admin-login-panel');
      if (registerPanel) registerPanel.classList.toggle('hidden', !adminAuthStatus.needsBootstrap);
      if (loginPanel) loginPanel.classList.toggle('hidden', adminAuthStatus.needsBootstrap);
      setAdminMessage('', false);
    }

    function closeAdminModal() {
      const modal = document.getElementById('admin-auth-modal');
      if (!modal) return;
      modal.classList.add('hidden');
      modal.classList.remove('flex');
    }

    async function submitAdminLogin() {
      try {
        setAdminMessage('Validando credenciais...', false);
        const email = document.getElementById('admin-login-email')?.value || '';
        const password = document.getElementById('admin-login-password')?.value || '';
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: email, password: password })
        });
        const data = await res.json();
        if (!res.ok || !data.success || !data.user) throw new Error(data.error || 'Falha no login.');
        adminSession = data.user;
        const pwd = document.getElementById('admin-login-password');
        if (pwd) pwd.value = '';
        closeAdminModal();
        applyAdminUi();
      } catch (err) {
        setAdminMessage(err.message || String(err), true);
      }
    }

    async function submitAdminRegistration() {
      try {
        setAdminMessage('Criando administrador...', false);
        const name = document.getElementById('admin-register-name')?.value || '';
        const email = document.getElementById('admin-register-email')?.value || '';
        const password = document.getElementById('admin-register-password')?.value || '';
        const bootstrapToken = document.getElementById('admin-register-bootstrap')?.value || '';
        const res = await fetch('/api/auth/register-admin', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: name, email: email, password: password, bootstrapToken: bootstrapToken })
        });
        const data = await res.json();
        if (!res.ok || !data.success || !data.user) throw new Error(data.error || 'Falha no cadastro.');
        adminSession = data.user;
        adminAuthStatus.needsBootstrap = false;
        ['admin-register-password', 'admin-register-bootstrap'].forEach(function (id) {
          const el = document.getElementById(id);
          if (el) el.value = '';
        });
        closeAdminModal();
        applyAdminUi();
      } catch (err) {
        setAdminMessage(err.message || String(err), true);
      }
    }

    async function logoutAdmin(showMessage) {
      try {
        await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
      } catch (_) {}
      adminSession = null;
      applyAdminUi();
      if (showMessage !== false) alert('Sessão administrativa encerrada.');
    }

    async function refreshAuthState() {
      try {
        const statusRes = await fetch('/api/auth/status', { credentials: 'same-origin' });
        if (statusRes.ok) adminAuthStatus = await statusRes.json();
      } catch (_) {}

      try {
        const meRes = await fetch('/api/auth/me', { credentials: 'same-origin' });
        const me = await meRes.json();
        if (meRes.ok && me.success && me.user?.role === 'ADMIN') {
          adminSession = me.user;
        } else {
          adminSession = null;
        }
      } catch (_) {
        adminSession = null;
      }
      applyAdminUi();
    }

    async function panicToken(mint, symbol) {
      if (!confirm('⚡ CONFIRMAR LIQUIDAÇÃO ADMIN:\\nLiquidar 100% da posição ' + (symbol || mint) + ' pelo executor seguro. Após confirmação on-chain, o sistema tentará fechar a conta SPL vazia e devolver o rent real à carteira.')) {
        return;
      }
      try {
        const res = await adminFetch('/api/positions/' + encodeURIComponent(mint) + '/exit', { method: 'POST' });
        const data = await res.json();
        if (data.success) {
          alert('✅ ' + (data.message || 'Moeda liquidada com sucesso!'));
          pollDashboard();
        } else {
          alert('❌ Falha na liquidação de pânico: ' + (data.error || 'Erro desconhecido'));
        }
      } catch (err) {
        alert('❌ Erro de conexão ao enviar ordem de pânico: ' + err.message);
      }
    }

    async function panicAll() {
      if (!confirm('🚨 PÂNICO GERAL ADMIN\\n\\nEsta ação arma o circuit breaker, liquida posições rastreadas e holdings SPL positivos não-base, preserva SOL/USDC/USDT e depois varre contas SPL vazias.\\n\\nDeseja prosseguir?')) {
        return;
      }
      try {
        const res = await adminFetch('/api/positions/liquidate-all', { method: 'POST' });
        const data = await res.json();
        if (data.success) {
          alert('🚨 PÂNICO GERAL EXECUTADO COM SUCESSO!\\n' + (data.message || ''));
          pollDashboard();
        } else {
          alert('❌ Falha no pânico geral: ' + (data.error || 'Erro desconhecido'));
        }
      } catch (err) {
        alert('❌ Erro de conexão ao enviar pânico geral: ' + err.message);
      }
    }

    async function sweepRentManual() {
      try {
        const res = await adminFetch('/api/wallet/sweep-rent', { method: 'POST' });
        const data = await res.json();
        if (data.success) {
          alert('🧹 Rent recovery concluído. Contas SPL vazias fechadas: ' + data.closedCount + ' | Rent bruto observado: ' + Number(data.reclaimedSolActual || 0).toFixed(9) + ' SOL');
          pollDashboard();
        } else {
          alert('⚠️ Erro na varredura: ' + (data.error || 'Falha'));
        }
      } catch (err) {
        alert('Erro ao chamar varredura de aluguel: ' + err.message);
      }
    }

    // Polling nativo a cada 2.5 segundos (sem piscar a tela)
    const POLL_INTERVAL_MS = 2500;

    async function pollDashboard() {
      try {
        const res = await fetch('/api/status');
        if (!res.ok) return;
        const data = await res.json();

        // 1. Atualiza timestamp e saldo
        const tsEl = document.getElementById('last-updated');
        if (tsEl) tsEl.textContent = new Date().toLocaleTimeString();

        const bal = data.wallet?.balanceSol ?? data.balanceSol;
        const balEl = document.getElementById('wallet-balance');
        if (balEl && bal !== undefined) {
          balEl.textContent = Number(bal).toFixed(4) + ' SOL';
        }

        // 2. Atualiza Sentinel
        const sentinelStatus = data.sentinel?.status ?? data.macroRegime ?? 'NORMAL';
        const isBreaker = data.sentinel?.circuitBreaker === 'ENGAGED' || Boolean(data.circuitBreakerActive);
        const sentinelTextEl = document.getElementById('sentinel-text');
        const sentinelDotEl = document.getElementById('sentinel-dot');
        if (sentinelTextEl) {
          sentinelTextEl.textContent = isBreaker ? 'DISJUNTOR ATIVO' : sentinelStatus;
          sentinelTextEl.className = (isBreaker ? 'text-rose-400' : 'text-emerald-400') + ' ml-1 font-mono';
        }
        if (sentinelDotEl) {
          sentinelDotEl.className = 'h-2.5 w-2.5 rounded-full ' + (isBreaker ? 'bg-rose-500 animate-pulse' : 'bg-emerald-500 animate-pulse');
        }

        // Estado operacional real vindo exclusivamente do backend.
        const operational = data.operational || {};
        const auth = operational.adminAuth || {};
        const rent = operational.rentRecovery || {};
        const laya = operational.laya || {};
        const exitHealth = operational.exitPathHealth || {};

        adminAuthStatus.configured = Boolean(auth.configured);
        adminAuthStatus.needsBootstrap = Boolean(auth.needsBootstrap);

        const execEl = document.getElementById('op-execution-mode');
        if (execEl) {
          execEl.textContent = operational.maintenanceMode ? 'MODO MANUTENÇÃO' : (operational.executionMode === 'REAL_ON_CHAIN' ? 'REAL ON-CHAIN' : 'DRY-RUN');
          execEl.className = 'mt-1 font-bold ' + (operational.maintenanceMode ? 'text-amber-300' : (operational.executionMode === 'REAL_ON_CHAIN' ? 'text-emerald-400' : 'text-amber-400'));
        }

        const layaEl = document.getElementById('op-laya-status');
        const layaDetail = document.getElementById('op-laya-detail');
        if (layaEl) {
          layaEl.textContent = (laya.health || 'UNKNOWN') + ' · ' + (laya.tacticalMode || 'UNKNOWN');
          layaEl.className = 'mt-1 font-bold ' + (laya.health === 'OK' ? 'text-emerald-400' : 'text-amber-400');
        }
        if (layaDetail) layaDetail.textContent = (laya.loaded || []).join(',') || 'checkpoint não confirmado';

        const exitHealthEl = document.getElementById('op-exit-health-status');
        const exitHealthDetail = document.getElementById('op-exit-health-detail');
        if (exitHealthEl) {
          const state = exitHealth.state || 'HEALTHY';
          exitHealthEl.textContent = state;
          exitHealthEl.className = 'mt-1 font-bold ' +
            (state === 'HEALTHY' ? 'text-emerald-400' : (state === 'EMERGENCY' ? 'text-rose-400' : 'text-amber-400'));
        }
        if (exitHealthDetail) {
          exitHealthDetail.textContent = exitHealth.reason ||
            ('Falhas: ' + Number(exitHealth.maxFailures || 0) +
             ' · novas entradas ' + (exitHealth.canOpenNewPosition === false ? 'PAUSADAS' : 'LIBERADAS'));
        }

        const rentEl = document.getElementById('op-rent-status');
        const rentDetail = document.getElementById('op-rent-detail');
        if (rentEl) {
          rentEl.textContent = rent.autoEnabled ? (rent.inFlight ? 'AUTO EXECUTANDO' : 'AUTO ATIVO') : 'AUTO DESLIGADO';
          rentEl.className = 'mt-1 font-bold ' + (rent.autoEnabled ? 'text-emerald-400' : 'text-slate-400');
        }
        if (rentDetail) {
          rentDetail.textContent =
            Number(rent.totalReclaimedSolActual || 0).toFixed(9) +
            ' SOL de rent bruto observados nesta execução · ' +
            Number(rent.totalClosedCount || 0) +
            ' conta(s) fechada(s)';
        }

        const authEl = document.getElementById('op-auth-status');
        if (authEl) {
          authEl.textContent = auth.configured
            ? (auth.needsBootstrap ? 'CADASTRO INICIAL NECESSÁRIO' : (adminSession ? 'SESSÃO ADMIN ATIVA' : 'LOGIN DISPONÍVEL'))
            : 'AUTH INDISPONÍVEL';
          authEl.className = 'mt-1 font-bold ' + (auth.configured ? 'text-cyan-400' : 'text-rose-400');
        }

        // 3. Atualiza Cards do Funil
        const incubator = data.incubator || {};
        const elWaiting = document.getElementById('metric-incubator-waiting');
        const elMature = document.getElementById('metric-incubator-mature');
        const elDiscards = document.getElementById('metric-technical-discards');
        const elAyla = document.getElementById('metric-entry-eligible');

        if (elWaiting && incubator.waiting !== undefined) elWaiting.textContent = incubator.waiting;
        if (elMature && incubator.mature !== undefined) elMature.textContent = incubator.mature;
        if (elDiscards && incubator.technicalDiscards !== undefined) elDiscards.textContent = incubator.technicalDiscards;
        if (elAyla && incubator.entryEligible !== undefined) elAyla.textContent = incubator.entryEligible;

        // 3.1 Observatório Pump.fun — apenas leitura.
        const pump = data.pump || {};
        const pumpStatus = document.getElementById('pump-observatory-status');
        const pumpCreated = document.getElementById('pump-created-count');
        const pumpActive = document.getElementById('pump-active-count');
        const pumpGraduated = document.getElementById('pump-graduated-count');
        const pumpLag = document.getElementById('pump-last-lag');
        if (pumpStatus) {
          pumpStatus.textContent = pump.running ? 'STREAM ATIVO' : (pump.enabled ? 'AGUARDANDO STREAM' : 'DESABILITADO');
          pumpStatus.className = 'text-xs font-mono ' + (pump.running ? 'text-emerald-400' : 'text-slate-500');
        }
        if (pumpCreated) pumpCreated.textContent = String(Number(pump.totalCreatedObserved || 0));
        if (pumpActive) pumpActive.textContent = String(Number(pump.activeCurves || 0));
        if (pumpGraduated) pumpGraduated.textContent = String(Number(pump.graduatedCount || 0));
        if (pumpLag) pumpLag.textContent = pumpLagText(pump.lastCreateToObserverLagMs);

        const pumpTbody = document.getElementById('pump-observatory-tbody');
        if (pumpTbody) {
          const recentPump = Array.isArray(pump.recent) ? pump.recent.slice(0, 12) : [];
          if (recentPump.length === 0) {
            pumpTbody.innerHTML = '<tr><td colspan="6" class="py-8 text-center text-slate-500 text-sm">Aguardando CreateEvent oficial da Pump.fun...</td></tr>';
          } else {
            pumpTbody.innerHTML = recentPump.map(function (p) {
              const mint = String(p.mint || '');
              const signature = String(p.signature || '');
              const symbol = escapePumpHtml(p.symbol || 'UNKNOWN');
              const progress = p.progressPct == null ? '—' : Number(p.progressPct).toFixed(2) + '%';
              const status = p.complete ? 'GRADUADA' : 'CURVA ATIVA';
              const tokenUrl = 'https://solscan.io/token/' + encodeURIComponent(mint);
              const pumpUrl = 'https://pump.fun/coin/' + encodeURIComponent(mint);
              const txUrl = 'https://solscan.io/tx/' + encodeURIComponent(signature);
              return '<tr class="border-b border-slate-800/60 hover:bg-slate-800/30">' +
                '<td class="py-3 px-4"><div class="font-semibold text-slate-200 flex items-center gap-2">' +
                '<span>' + symbol + '</span>' +
                '<a href="' + tokenUrl + '" target="_blank" rel="noopener" class="text-cyan-400 hover:underline text-xs">Solscan↗</a>' +
                '<a href="' + pumpUrl + '" target="_blank" rel="noopener" class="text-fuchsia-400 hover:underline text-xs">Pump↗</a>' +
                '</div><div class="text-[10px] text-slate-500 font-mono">' + escapePumpHtml(mint.slice(0, 8)) + '...' + escapePumpHtml(mint.slice(-6)) + '</div></td>' +
                '<td class="py-3 px-4 font-mono text-xs text-slate-300">' + progress + '</td>' +
                '<td class="py-3 px-4 text-xs ' + (p.complete ? 'text-emerald-400' : 'text-amber-300') + '">' + status + '</td>' +
                '<td class="py-3 px-4 font-mono text-xs text-slate-400">' + pumpLagText(p.createToObserverLagMs) + '</td>' +
                '<td class="py-3 px-4 font-mono text-xs text-slate-400">' + Number(p.slot || 0) + '</td>' +
                '<td class="py-3 px-4"><a href="' + txUrl + '" target="_blank" rel="noopener" class="text-cyan-400 hover:underline font-mono text-[11px]">' + escapePumpHtml(signature.slice(0, 10)) + '...↗</a></td>' +
                '</tr>';
            }).join('');
          }
        }

        // 3.2 Strategy Lab Pump/Jupiter — shadow, sem execução real.
        const strategyLab = data.pumpStrategyLab || {};
        const labSamples = document.getElementById('pump-strategy-lab-samples');
        const labPlan = document.getElementById('pump-strategy-lab-plan');
        const labNet = document.getElementById('pump-strategy-lab-net');
        const labRouteRate = document.getElementById('pump-strategy-route-rate');
        const labRouteLag = document.getElementById('pump-strategy-route-lag');
        const labMomentZero = document.getElementById('pump-strategy-moment-zero');
        const labTbody = document.getElementById('pump-strategy-lab-tbody');
        const labError = document.getElementById('pump-strategy-lab-error');
        if (labError) {
          labError.hidden = !strategyLab.lastError;
          labError.textContent = strategyLab.lastError
            ? 'Coleta temporariamente indisponível; aguardando recuperação.'
            : '';
        }
        if (labSamples) labSamples.textContent = 'Amostras: ' + Number(strategyLab.totalSamples || 0);
        if (labPlan) labPlan.textContent = String(strategyLab.preferredJupiterPlan || 'INSUFFICIENT_DATA');
        if (labNet) {
          labNet.textContent = strategyLab.preferredPlanNetAfterCostSol == null
            ? '—'
            : Number(strategyLab.preferredPlanNetAfterCostSol).toFixed(6) + ' SOL';
        }
        const readiness = strategyLab.routeReadiness || {};
        const probedMints = Number(readiness.probedMints || 0);
        if (labRouteRate) {
          labRouteRate.textContent = probedMints === 0 ? '—' :
            (Number(readiness.compliantRouteRate || 0) * 100).toFixed(1) + '% (' +
            Number(readiness.compliantRouteMints || 0) + '/' + probedMints + ')';
        }
        if (labRouteLag) {
          labRouteLag.textContent = 'latência mediana: ' + pumpLagText(readiness.medianFirstCompliantRouteLagMs);
        }
        if (labMomentZero) {
          labMomentZero.textContent = probedMints === 0 ? '—' :
            (Number(readiness.momentZeroRate || 0) * 100).toFixed(1) + '% (' +
            Number(readiness.momentZeroMints || 0) + '/' + probedMints + ')';
        }
        if (labTbody) {
          const strategies = Array.isArray(strategyLab.strategies) ? strategyLab.strategies : [];
          labTbody.innerHTML = strategies.length === 0
            ? '<tr><td colspan="9" class="py-6 text-center text-slate-500 text-sm">INSUFFICIENT_DATA — coletando evidência shadow.</td></tr>'
            : strategies.map(function (item) {
                const replayRows = Array.isArray(item.exitPolicyReplays) ? item.exitPolicyReplays : [];
                const replayText = replayRows.length === 0
                  ? '—'
                  : replayRows.map(function (replay) {
                      return escapePumpHtml(replay.policy || '') + ': ' +
                        Number(replay.meanNetReturnPct || 0).toFixed(2) + '% | giveback ' +
                        Number(replay.meanMaxGiveBackFromPeakPct || 0).toFixed(1) + '%';
                    }).join('<br>');
                return '<tr class="border-b border-slate-800/60">' +
                  '<td class="py-2 px-3 font-mono text-xs text-fuchsia-300">' + escapePumpHtml(item.entryWindow || item.cohort || '') + '</td>' +
                  '<td class="py-2 px-3 font-mono text-xs text-amber-300">' + escapePumpHtml(item.horizon || '—') + '</td>' +
                  '<td class="py-2 px-3 font-mono text-xs text-slate-300">' + escapePumpHtml(item.cohort || '') + '</td>' +
                  '<td class="py-2 px-3 text-xs text-slate-300">' + escapePumpHtml(item.venue || '') + '</td>' +
                  '<td class="py-2 px-3 text-xs text-cyan-300">' + escapePumpHtml(item.state || '') + '</td>' +
                  '<td class="py-2 px-3 font-mono text-xs text-slate-400">' + Number(item.sampleCount || 0) + '</td>' +
                  '<td class="py-2 px-3 font-mono text-xs text-slate-400">' +
                    (item.meanNetReturnPct == null ? '—' : Number(item.meanNetReturnPct).toFixed(2) + '%') + '</td>' +
                  '<td class="py-2 px-3 font-mono text-xs text-slate-400">' +
                    (Number(item.executableExitRate || 0) * 100).toFixed(1) + '%</td>' +
                  '<td class="py-2 px-3 font-mono text-[10px] text-slate-400">' + replayText + '</td>' +
                  '</tr>';
              }).join('');
        }

        // 3.3 Pump direct SELL fallback — proteção de capital, nunca BUY.
        const pumpSellFallback = (data.operational && data.operational.pumpDirectSellFallback) || {};
        const fallbackEnabled = document.getElementById('pump-sell-fallback-enabled');
        const fallbackPath = document.getElementById('pump-sell-fallback-path');
        const fallbackConfirmation = document.getElementById('pump-sell-fallback-confirmation');
        const fallbackCost = document.getElementById('pump-sell-fallback-cost');
        const fallbackReason = document.getElementById('pump-sell-fallback-reason');
        if (fallbackEnabled) fallbackEnabled.textContent = pumpSellFallback.enabled ? 'ARMADO' : 'DESABILITADO';
        if (fallbackPath) fallbackPath.textContent = String(pumpSellFallback.selectedPath || 'NONE');
        if (fallbackConfirmation) fallbackConfirmation.textContent = String(pumpSellFallback.confirmationState || 'IDLE');
        if (fallbackCost) fallbackCost.textContent = pumpSellFallback.estimatedCostSol == null
          ? 'N/D'
          : Number(pumpSellFallback.estimatedCostSol).toFixed(9) + ' SOL';
        if (fallbackReason) fallbackReason.textContent = String(pumpSellFallback.fallbackReason || '—');

        // 4. Atualiza Tabela de Posições
        const positions = data.positions || [];
        const posTbody = document.getElementById('positions-tbody');
        const posBadge = document.getElementById('active-positions-badge');
        if (posBadge) posBadge.textContent = positions.length + ' / 2';

        if (posTbody) {
          if (positions.length === 0) {
            posTbody.innerHTML = '<tr><td colspan="7" class="py-8 text-center text-slate-500 font-sans">Varredura ativa. Aguardando candidato aprovado pelos filtros determinísticos e momentum...</td></tr>';
          } else {
            posTbody.innerHTML = positions.map(p => {
              const pnlPct = p.pnlPercent !== undefined ? p.pnlPercent : (p.pnlPct ? p.pnlPct * 100 : 0);
              const isProfit = pnlPct >= 0;
              const stopLoss = p.stopLossPercent !== undefined ? p.stopLossPercent : (p.stopLossPct !== undefined ? p.stopLossPct : -6);
              return '<tr id="pos-row-' + p.mint + '" class="hover:bg-slate-800/30 transition">' +
                '<td class="py-4 px-4 md:px-6 font-sans">' +
                  '<div class="font-bold text-white flex items-center gap-2">' +
                    '<span>' + p.symbol + '</span>' +
                    '<a href="https://solscan.io/token/' + p.mint + '" target="_blank" class="text-xs text-cyan-400 hover:underline">↗</a>' +
                  '</div>' +
                  '<div class="text-[11px] text-slate-400 font-mono">' + p.mint.slice(0, 6) + '...' + p.mint.slice(-4) + '</div>' +
                '</td>' +
                '<td class="py-4 px-4 text-slate-300">$' + Number(p.entryPriceUsd || 0).toFixed(6) + '</td>' +
                '<td id="price-' + p.mint + '" class="py-4 px-4 text-slate-200">$' + Number(p.currentPriceUsd || 0).toFixed(6) + '</td>' +
                '<td id="pnl-' + p.mint + '" class="py-4 px-4 font-bold ' + (isProfit ? 'text-emerald-400' : 'text-rose-400') + '">' +
                  (isProfit ? '+' : '') + Number(pnlPct).toFixed(2) + '%' +
                '</td>' +
                '<td class="py-4 px-4 text-xs text-slate-400">' + Number(stopLoss).toFixed(1) + '%</td>' +
                '<td class="py-4 px-4 text-xs">' +
                  (p.stopStatusText
                    ? '<span class="' + ((p.trailingStopActive || p.trailingActive) ? 'text-emerald-400 font-semibold' : 'text-slate-400') + '">' + p.stopStatusText + '</span>'
                    : '<span class="' + ((p.trailingStopActive || p.trailingActive) ? 'text-emerald-400 font-semibold' : 'text-slate-500') + '">' +
                      ((p.trailingStopActive || p.trailingActive) ? 'ATIVO (proteção dinâmica)' : 'INATIVO (ativa a partir de +8%)') +
                    '</span>') +
                '</td>' +
                '<td class="py-4 px-4 md:px-6 text-right font-sans">' +
                  '<button disabled data-admin-action="true" onclick="panicToken(&quot;' + p.mint + '&quot;)" title="Requer sessão ADMIN." class="admin-action bg-slate-800 text-slate-600 font-bold text-xs px-3 py-1.5 rounded-lg border border-slate-700 cursor-not-allowed">' +
                    'LIQUIDAR POSIÇÃO' +
                  '</button>' +
                '</td>' +
              '</tr>';
            }).join('');
          }
        }

        // 5. Atualiza Histórico de Trades Fechados
        const closed = (data.closedTrades || []).slice().reverse();
        const tradesTbody = document.getElementById('closed-trades-tbody');
        const tradesBadge = document.getElementById('closed-trades-badge');
        const tradesPnl = document.getElementById('closed-trades-pnl');
        const tradesWin = document.getElementById('closed-trades-win');
        if (tradesBadge) tradesBadge.textContent = closed.length + ' trade(s)';
        if (closed.length > 0) {
          const totalPnl = closed.reduce(function (a, t) { return a + Number(t.realizedPnlSol || 0); }, 0);
          const wins = closed.filter(function (t) { return Number(t.pnlPct || 0) > 0; }).length;
          if (tradesPnl) {
            tradesPnl.textContent = (totalPnl >= 0 ? '+' : '') + totalPnl.toFixed(6) + ' SOL';
            tradesPnl.className = (totalPnl >= 0 ? 'text-emerald-400' : 'text-rose-400') + ' font-bold';
          }
          if (tradesWin) tradesWin.textContent = wins + '/' + closed.length;
        }
        if (tradesTbody) {
          if (closed.length === 0) {
            tradesTbody.innerHTML = '<tr><td colspan="7" class="py-10 text-center text-slate-500 font-sans text-sm">Nenhum trade encerrado ainda. O histórico aparece após o primeiro fechamento confirmado on-chain.</td></tr>';
          } else {
            var reasonLabels = {
              STOP_LOSS: ['Stop Loss', 'bg-rose-500/15 text-rose-300 border-rose-500/30'],
              PARTIAL_TAKE_PROFIT_50: ['Colheita Parcial +35%', 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'],
              TRAILING_STOP: ['Trailing Stop', 'bg-amber-500/15 text-amber-300 border-amber-500/30'],
              TIME_STOP: ['Time-Stop', 'bg-slate-500/15 text-slate-300 border-slate-500/30'],
              TAKE_PROFIT: ['Take Profit', 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'],
              MANUAL: ['Manual / Pânico', 'bg-purple-500/15 text-purple-300 border-purple-500/30'],
              LAYA_EXIT: ['Saída Tática Laya', 'bg-cyan-500/15 text-cyan-300 border-cyan-500/30']
            };
            tradesTbody.innerHTML = closed.map(function (t) {
              var pnlPct = Number(t.pnlPct || 0);
              var pnlSol = Number(t.realizedPnlSol || 0);
              var isProfit = pnlPct >= 0;
              var r = reasonLabels[t.exitReason] || [t.exitReason, 'bg-slate-500/15 text-slate-300 border-slate-500/30'];
              var tx = t.txSignature
                ? '<a href="https://solscan.io/tx/' + t.txSignature + '" target="_blank" class="text-cyan-400 hover:underline font-mono text-[11px]">' + String(t.txSignature).slice(0, 10) + '...↗</a>'
                : '<span class="text-slate-600 text-[11px]">sem tx</span>';
              var d = new Date(t.closedAt || t.exitTimestamp);
              var when = isNaN(d.getTime()) ? '-' : d.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
              return '<tr class="border-b border-slate-800/60 hover:bg-slate-800/30">' +
                '<td class="py-3 px-4 text-slate-400 text-xs font-mono whitespace-nowrap">' + when + '</td>' +
                '<td class="py-3 px-4">' +
                  '<div class="flex items-center gap-2"><span class="font-semibold text-slate-200">' + t.symbol + '</span>' +
                  '<a href="https://solscan.io/token/' + t.mint + '" target="_blank" class="text-xs text-cyan-400 hover:underline">↗</a></div>' +
                  '<div class="text-[11px] text-slate-500 font-mono">' + String(t.mint).slice(0, 6) + '...' + String(t.mint).slice(-4) + '</div>' +
                '</td>' +
                '<td class="py-3 px-4 text-slate-300 font-mono text-xs">$' + Number(t.entryPriceUsd || 0).toFixed(8) + '</td>' +
                '<td class="py-3 px-4 text-slate-200 font-mono text-xs">$' + Number(t.exitPriceUsd || 0).toFixed(8) + '</td>' +
                '<td class="py-3 px-4 font-mono text-xs ' + (isProfit ? 'text-emerald-400' : 'text-rose-400') + '">' +
                  (isProfit ? '+' : '') + pnlSol.toFixed(6) + ' SOL' +
                  '<div class="text-[10px] opacity-80">' + (isProfit ? '+' : '') + pnlPct.toFixed(2) + '%</div>' +
                '</td>' +
                '<td class="py-3 px-4"><span class="inline-block px-2 py-0.5 rounded text-[10px] border ' + r[1] + '">' + r[0] + '</span></td>' +
                '<td class="py-3 px-4">' + tx + '</td>' +
              '</tr>';
            }).join('');
          }
        }

        // 6. Atualiza Logs
        const logs = data.recentLogs || (data.scannerLogs ? data.scannerLogs.map(l => typeof l === 'string' ? l : '[' + l.timestamp + '] ' + l.message) : []);
        const logsContainer = document.getElementById('logs-container');
        if (logsContainer && logs.length > 0) {
          logsContainer.innerHTML = logs.map(text => {
            const colorClass = (text.includes('Elegíveis para Auditoria: 1') || text.includes('Elegíveis para Auditoria: 1')) || text.includes('APROVADO')
              ? 'text-emerald-400'
              : text.includes('⚠️') || text.includes('VETADO')
              ? 'text-amber-400'
              : text.includes('🚨') || text.includes('Erro')
              ? 'text-rose-400'
              : 'text-slate-300';
            return '<div class="' + colorClass + '">' + text + '</div>';
          }).join('');
          logsContainer.scrollTop = logsContainer.scrollHeight;
        }

        // A tabela de posições é recriada a cada polling; reaplica o estado da sessão aos botões novos.
        applyAdminUi();
      } catch (err) {
        // Silencioso em caso de latência momentânea
      }
    }

    // Inicializa sessão e estado real imediatamente, depois mantém polling.
    void refreshAuthState();
    void pollDashboard();
    setInterval(pollDashboard, POLL_INTERVAL_MS);
  </script>
</body>
</html>`;
}
