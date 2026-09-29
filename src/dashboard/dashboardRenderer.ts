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

        <!-- Botão de Ação Rápida: PÂNICO GERAL -->
        <button onclick="panicAll()" class="bg-gradient-to-r from-rose-600 to-red-700 hover:from-rose-500 hover:to-red-600 text-white font-bold text-xs md:text-sm px-4 py-2.5 rounded-xl shadow-lg shadow-rose-950/60 border border-rose-500/50 flex items-center gap-2 transition-all active:scale-95 cursor-pointer">
          <span class="text-base">🚨</span>
          <span>PÂNICO GERAL / ZERAR TUDO</span>
        </button>
      </div>
    </header>

    <!-- GRID DE MÉTRICAS DO FUNIL DE MATURAÇÃO -->
    <section class="grid grid-cols-2 lg:grid-cols-4 gap-4">
      <!-- Card 1: Incubadora -->
      <div class="bg-slate-900/60 border border-slate-800/90 rounded-2xl p-4 shadow-lg flex flex-col justify-between hover:border-slate-700 transition">
        <div class="flex items-center justify-between text-slate-400 text-xs font-medium">
          <span>🕒 Incubadora (Aguardando)</span>
          <span class="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-400">&lt; 15 min</span>
        </div>
        <div id="metric-incubator-waiting" class="text-2xl md:text-3xl font-black font-mono text-cyan-400 mt-2">
          ${waitingCount}
        </div>
        <div class="text-[11px] text-slate-500 mt-1">Tokens marinando pós-dump inicial</div>
      </div>

      <!-- Card 2: Maturos -->
      <div class="bg-slate-900/60 border border-slate-800/90 rounded-2xl p-4 shadow-lg flex flex-col justify-between hover:border-slate-700 transition">
        <div class="flex items-center justify-between text-slate-400 text-xs font-medium">
          <span>🎯 Maturos (Prontos)</span>
          <span class="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400">15-60 min</span>
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
          <span class="text-[10px] px-1.5 py-0.5 rounded bg-slate-500/10 text-slate-400">Filtro $20k</span>
        </div>
        <div id="metric-technical-discards" class="text-2xl md:text-3xl font-black font-mono text-rose-400 mt-2">
          ${discardsCount}
        </div>
        <div class="text-[11px] text-slate-500 mt-1">Barrados por liquidez ou momentum</div>
      </div>

      <!-- Card 4: Elegíveis Ayla -->
      <div class="bg-slate-900/60 border border-slate-800/90 rounded-2xl p-4 shadow-lg flex flex-col justify-between hover:border-slate-700 transition">
        <div class="flex items-center justify-between text-slate-400 text-xs font-medium">
          <span>🧠 Elegíveis para Ayla</span>
          <span class="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400">Gatilho +EV</span>
        </div>
        <div id="metric-ayla-eligible" class="text-2xl md:text-3xl font-black font-mono text-emerald-400 mt-2">
          ${aylaCount}
        </div>
        <div class="text-[11px] text-slate-500 mt-1">Candidatos aprovados para entrada</div>
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
          <p class="text-xs text-slate-400 mt-0.5">Ultra-Fast 1.5s quote loop · Stop Loss: -8% · Trailing Stop: -10% Topo · Slippage: 5%</p>
        </div>
        <button onclick="sweepRentManual()" class="text-xs font-semibold px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-cyan-400 border border-slate-700 flex items-center gap-1.5 transition">
          <span>🧹</span>
          <span>Varrer Aluguel ATAs</span>
        </button>
      </div>

      <div class="overflow-x-auto">
        <table class="w-full text-left text-sm">
          <thead class="bg-slate-950/60 text-slate-400 text-xs uppercase tracking-wider font-semibold border-b border-slate-800">
            <tr>
              <th class="py-3 px-4 md:px-6">Token / Mint</th>
              <th class="py-3 px-4">Preço Entrada</th>
              <th class="py-3 px-4">Cotação Atual</th>
              <th class="py-3 px-4">PnL Flutuante</th>
              <th class="py-3 px-4">Stop Loss</th>
              <th class="py-3 px-4">Trailing Stop</th>
              <th class="py-3 px-4 md:px-6 text-right">Ação</th>
            </tr>
          </thead>
          <tbody id="positions-tbody" class="divide-y divide-slate-800/60 font-mono">
            ${state.positions.length === 0 ? `
              <tr>
                <td colspan="7" class="py-8 text-center text-slate-500 font-sans">
                  Varredura ativa. Aguardando breakout validado pela Ayla...
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
                    ${p.trailingActive ? 'ATIVO (-10% Topo)' : 'INATIVO (Aguardando +35%)'}
                  </span>
                </td>
                <td class="py-4 px-4 md:px-6 text-right font-sans">
                  <button onclick="panicToken('${p.mint}', '${p.symbol}')" class="bg-rose-600/90 hover:bg-rose-600 text-white font-bold text-xs px-3 py-1.5 rounded-lg border border-rose-500/40 shadow-sm transition active:scale-95 cursor-pointer">
                    VENDER AGORA (PÂNICO)
                  </button>
                </td>
              </tr>
            `;
            }).join('')}
          </tbody>
        </table>
      </div>
    </section>

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
          const colorClass = text.includes('Elegíveis para Ayla: 1') || text.includes('APROVADO')
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
            posTbody.innerHTML = '<tr><td colspan="7" class="py-8 text-center text-slate-500 font-sans">Varredura ativa. Aguardando breakout validado pela Ayla...</td></tr>';
          } else {
            posTbody.innerHTML = positions.map(p => {
              const pnlPct = p.pnlPercent !== undefined ? p.pnlPercent : (p.pnlPct ? p.pnlPct * 100 : 0);
              const isProfit = pnlPct >= 0;
              const stopLoss = p.stopLossPercent !== undefined ? p.stopLossPercent : (p.stopLossPct ? p.stopLossPct * 100 : -8);
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
                  '<span class="' + (p.trailingStopActive || p.trailingActive ? 'text-emerald-400 font-semibold' : 'text-slate-500') + '">' +
                    (p.trailingStopActive || p.trailingActive ? 'ATIVO (-10% Topo)' : 'INATIVO (Aguardando +35%)') +
                  '</span>' +
                '</td>' +
                '<td class="py-4 px-4 md:px-6 text-right font-sans">' +
                  '<button onclick="panicToken(\\'' + p.mint + '\\', \\'' + p.symbol + '\\')" class="bg-rose-600/90 hover:bg-rose-600 text-white font-bold text-xs px-3 py-1.5 rounded-lg border border-rose-500/40 shadow-sm transition active:scale-95 cursor-pointer">' +
                    'VENDER AGORA (PÂNICO)' +
                  '</button>' +
                '</td>' +
              '</tr>';
            }).join('');
          }
        }

        // 5. Atualiza Logs
        const logs = data.recentLogs || (data.scannerLogs ? data.scannerLogs.map(l => typeof l === 'string' ? l : '[' + l.timestamp + '] ' + l.message) : []);
        const logsContainer = document.getElementById('logs-container');
        if (logsContainer && logs.length > 0) {
          logsContainer.innerHTML = logs.map(text => {
            const colorClass = text.includes('Elegíveis para Ayla: 1') || text.includes('APROVADO')
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
