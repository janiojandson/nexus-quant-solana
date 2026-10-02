import { renderJournalSection } from './dashboardJournal.js';

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
  exitReason: 'TAKE_PROFIT' | 'PARTIAL_TAKE_PROFIT_50' | 'STOP_LOSS' | 'TRAILING_STOP' | 'TIME_STOP' | 'MANUAL' | 'HOLD';
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
  macroRegime: string;
  circuitBreakerActive: boolean;
  activeRpcUrl: string;
  totalRealizedPnlSol: number;
  totalNetworkFeesSolEst: number;
  incubator?: {
    waiting: number;
    mature: number;
    technicalDiscards: number;
    aylaEligible: number;
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

const EXIT_REASON_LABELS: Record<string, { label: string; cls: string }> = {
  STOP_LOSS: { label: 'Stop Loss', cls: 'bg-rose-500/15 text-rose-300 border-rose-500/30' },
  PARTIAL_TAKE_PROFIT_50: { label: 'Colheita Parcial +35%', cls: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30' },
  TRAILING_STOP: { label: 'Trailing Stop', cls: 'bg-amber-500/15 text-amber-300 border-amber-500/30' },
  TIME_STOP: { label: 'Time-Stop', cls: 'bg-slate-500/15 text-slate-300 border-slate-500/30' },
  TAKE_PROFIT: { label: 'Take Profit', cls: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30' },
  MANUAL: { label: 'Manual / Pânico', cls: 'bg-purple-500/15 text-purple-300 border-purple-500/30' }
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
  const aylaCount = state.incubator?.aylaEligible ?? 0;

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

        <!-- Ações administrativas exigem autenticação segura no servidor. -->
        <button disabled title="Ação administrativa protegida por NEXUS_ADMIN_TOKEN. Use API/CLI autenticada até existir sessão web segura." class="bg-slate-800 text-slate-500 font-bold text-xs md:text-sm px-4 py-2.5 rounded-xl border border-slate-700 flex items-center gap-2 cursor-not-allowed">
          <span class="text-base">🔒</span>
          <span>AÇÕES ADMIN PROTEGIDAS</span>
        </button>
      </div>
    </header>

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

      <!-- Card 4: Elegíveis Ayla -->
      <div class="bg-slate-900/60 border border-slate-800/90 rounded-2xl p-4 shadow-lg flex flex-col justify-between hover:border-slate-700 transition">
        <div class="flex items-center justify-between text-slate-400 text-xs font-medium">
          <span>🧠 Elegíveis para Laya</span>
          <span class="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400">Pré-filtro técnico</span>
        </div>
        <div id="metric-ayla-eligible" class="text-2xl md:text-3xl font-black font-mono text-emerald-400 mt-2">
          ${aylaCount}
        </div>
        <div class="text-[11px] text-slate-500 mt-1">Candidatos técnicos aguardando auditoria de risco/decisão</div>
      </div>
    </section>

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
          <p class="text-xs text-slate-400 mt-0.5">Sensor DexScreener 1.5s · SL inicial: -6% · Trailing momentum: +8%/-6% do topo · Runner pós-parcial: -10% do topo</p>
        </div>
        <button disabled title="Requer autenticação administrativa via API/CLI." class="text-xs font-semibold px-3 py-1.5 rounded-lg bg-slate-900 text-slate-600 border border-slate-800 flex items-center gap-1.5 cursor-not-allowed">
          <span>🔒</span>
          <span>Varrer ATAs via API autenticada</span>
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
                  Varredura ativa. Aguardando candidato validado por risco, Laya e momentum...
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
                  <button disabled title="Venda manual exige API/CLI autenticada." class="bg-slate-800 text-slate-600 font-bold text-xs px-3 py-1.5 rounded-lg border border-slate-700 cursor-not-allowed">
                    VENDA MANUAL PROTEGIDA
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
          const colorClass = (text.includes('Elegíveis para Laya: 1') || text.includes('Elegíveis para Ayla: 1')) || text.includes('APROVADO')
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

  <!-- SCRIPT DE AÇÕES & POLLING NATIVO A CADA 2.5s -->
  <script>
    async function panicToken(mint, symbol) {
      if (!confirm('⚡ CONFIRMAR VENDA DE EMERGÊNCIA:\nDeseja liquidar 100% de ' + symbol + ' a mercado via Jupiter V6 e resgatar o aluguel da conta ATA (~0.00204 SOL)?')) {
        return;
      }
      try {
        const res = await fetch('/api/panic/' + encodeURIComponent(mint), { method: 'POST' });
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
      if (!confirm('🚨 ATENÇÃO: PÂNICO GERAL / ZERAR TUDO!\n\nEsta ação irá:\n1. Desarmar o disjuntor do Sentinel e vetar novas compras;\n2. Interromper todos os monitores ativos;\n3. Liquidar 100% de todos os tokens da carteira a mercado para SOL;\n4. Fechar todas as contas de token (ATAs) e resgatar os aluguéis.\n\nDeseja prosseguir?')) {
        return;
      }
      try {
        const res = await fetch('/api/panic/all', { method: 'POST' });
        const data = await res.json();
        if (data.success) {
          alert('🚨 PÂNICO GERAL EXECUTADO COM SUCESSO!\n' + (data.message || ''));
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
        const res = await fetch('/api/wallet/sweep-rent', { method: 'POST' });
        const data = await res.json();
        if (data.success) {
          alert('🧹 Varredura de aluguel concluída! Contas fechadas: ' + data.closedCount + ' | SOL recuperado: ~' + data.reclaimedSolEst);
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

        // 3. Atualiza Cards do Funil
        const incubator = data.incubator || {};
        const elWaiting = document.getElementById('metric-incubator-waiting');
        const elMature = document.getElementById('metric-incubator-mature');
        const elDiscards = document.getElementById('metric-technical-discards');
        const elAyla = document.getElementById('metric-ayla-eligible');

        if (elWaiting && incubator.waiting !== undefined) elWaiting.textContent = incubator.waiting;
        if (elMature && incubator.mature !== undefined) elMature.textContent = incubator.mature;
        if (elDiscards && incubator.technicalDiscards !== undefined) elDiscards.textContent = incubator.technicalDiscards;
        if (elAyla && incubator.aylaEligible !== undefined) elAyla.textContent = incubator.aylaEligible;

        // 4. Atualiza Tabela de Posições
        const positions = data.positions || [];
        const posTbody = document.getElementById('positions-tbody');
        const posBadge = document.getElementById('active-positions-badge');
        if (posBadge) posBadge.textContent = positions.length + ' / 2';

        if (posTbody) {
          if (positions.length === 0) {
            posTbody.innerHTML = '<tr><td colspan="7" class="py-8 text-center text-slate-500 font-sans">Varredura ativa. Aguardando candidato validado por risco, Laya e momentum...</td></tr>';
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
                  '<button disabled title="Venda manual exige API/CLI autenticada." class="bg-slate-800 text-slate-600 font-bold text-xs px-3 py-1.5 rounded-lg border border-slate-700 cursor-not-allowed">' +
                    'VENDA MANUAL PROTEGIDA' +
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
              MANUAL: ['Manual / Pânico', 'bg-purple-500/15 text-purple-300 border-purple-500/30']
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
            const colorClass = (text.includes('Elegíveis para Laya: 1') || text.includes('Elegíveis para Ayla: 1')) || text.includes('APROVADO')
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

      } catch (err) {
        // Silencioso em caso de latência momentânea
      }
    }

    // Inicia polling
    setInterval(pollDashboard, POLL_INTERVAL_MS);
  </script>
</body>
</html>`;
}
