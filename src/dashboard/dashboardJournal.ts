// ============================================================
// dashboardJournal.ts — Seção de Telemetria v2.5.0
// 100% Vanilla JS + Tailwind (já importado no projeto)
// Zero dependências novas. Zero overhead no loop de 1.5s.
// ============================================================

export function renderJournalSection(): string {
  return `
  <!-- ═══════════════════════════════════════════════ -->
  <!-- DECISION JOURNAL & CALIBRAÇÃO DE EV (v2.5.0)    -->
  <!-- ═══════════════════════════════════════════════ -->
  <div class="mt-8 space-y-6">
    <div class="flex items-center justify-between border-b border-purple-900/40 pb-3">
      <h2 class="text-lg md:text-xl font-black text-purple-400 flex items-center gap-2">
        <span>🧠 DECISION JOURNAL & CALIBRAÇÃO DE EV</span>
        <span class="text-xs font-semibold px-2 py-0.5 rounded-full bg-purple-500/20 text-purple-300 border border-purple-500/30">v2.5.0</span>
      </h2>
      <span class="text-xs text-slate-400 font-mono">Telemetria Quantitativa On-Chain</span>
    </div>

    <!-- ── CARD 1: FUNIL DE COLETA ── -->
    <div id="card-funnel" class="bg-slate-900/80 rounded-2xl p-5 border border-purple-900/30 shadow-xl backdrop-blur-sm">
      <div class="flex items-center justify-between mb-4">
        <h3 class="text-sm font-bold text-slate-200 flex items-center gap-2">
          <span>📊 Funil de Coleta — Decision Journal</span>
          <span class="text-[10px] px-2 py-0.5 rounded bg-purple-500/10 text-purple-400 font-mono">Buffer RAM + Partições</span>
        </h3>
        <span class="text-xs text-slate-500">Alvo p/ Policy Adapter: 150 trades</span>
      </div>

      <div class="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
        <div class="bg-slate-950/70 border border-slate-800 rounded-xl p-4 text-center">
          <div id="dj-total-decisions" class="text-3xl font-black font-mono text-cyan-400">—</div>
          <div class="text-xs text-slate-400 mt-1">Decisões Registradas</div>
        </div>
        <div class="bg-slate-950/70 border border-slate-800 rounded-xl p-4 text-center">
          <div id="dj-closed-trades" class="text-3xl font-black font-mono text-emerald-400">—</div>
          <div class="text-xs text-slate-400 mt-1">Trades Fechados</div>
        </div>
        <div class="bg-slate-950/70 border border-slate-800 rounded-xl p-4 text-center">
          <div id="dj-target-n" class="text-3xl font-black font-mono text-amber-400">150</div>
          <div class="text-xs text-slate-400 mt-1">N Alvo para Calibração</div>
        </div>
      </div>

      <!-- Barra de Progresso -->
      <div class="mb-4 bg-slate-950/60 p-3.5 rounded-xl border border-slate-800/80">
        <div class="flex justify-between text-xs text-slate-400 mb-1.5">
          <span>Progresso Estatístico para Policy Adapter</span>
          <span id="dj-progress-label" class="font-mono text-purple-300 font-bold">—/150 (0%)</span>
        </div>
        <div class="w-full bg-slate-800 rounded-full h-3 overflow-hidden">
          <div id="dj-progress-bar"
               class="bg-gradient-to-r from-purple-600 via-purple-400 to-cyan-400 h-3 rounded-full transition-all duration-500"
               style="width: 0%">
          </div>
        </div>
      </div>

      <!-- Status do Buffer e Sistema -->
      <div class="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs mb-4">
        <div class="bg-slate-950/80 border border-slate-800 rounded-xl p-3 flex items-center justify-between">
          <span class="text-slate-400">Buffer RAM:</span>
          <div>
            <span id="dj-buffer-count" class="text-purple-400 font-mono font-bold">—</span>
            <span class="text-slate-600 font-mono">/ 100</span>
          </div>
        </div>
        <div class="bg-slate-950/80 border border-slate-800 rounded-xl p-3 flex items-center justify-between">
          <span class="text-slate-400">Cron Noturno:</span>
          <span class="text-emerald-400 font-mono font-bold">03:00 UTC</span>
        </div>
        <div class="bg-slate-950/80 border border-slate-800 rounded-xl p-3 flex items-center justify-between">
          <span class="text-slate-400">Retenção Partições:</span>
          <span class="text-slate-200 font-mono font-bold">90 dias</span>
        </div>
      </div>

      <!-- Breakdown por Tipo de Decisão -->
      <div class="bg-slate-950/60 rounded-xl p-3 border border-slate-800/80">
        <div class="text-xs text-slate-400 mb-2 font-medium">Distribuição de Decisões no Ledger:</div>
        <div id="dj-decision-breakdown" class="flex flex-wrap gap-2">
          <span class="text-slate-600 text-xs">Carregando telemetria...</span>
        </div>
      </div>

      <!-- Botão de Auditoria -->
      <button id="btn-run-calibration" onclick="runCalibrationManual(event)"
              class="mt-4 w-full bg-gradient-to-r from-purple-700 to-indigo-700 hover:from-purple-600 hover:to-indigo-600 text-white text-sm font-bold py-2.5 px-4 rounded-xl shadow-lg border border-purple-500/40 transition-all active:scale-[0.99] cursor-pointer flex items-center justify-center gap-2">
        <span>🔄</span>
        <span id="btn-run-calibration-text">Executar Auditoria de Calibração Sob Demanda</span>
      </button>
    </div>

    <!-- ── CARD 2: LIFT POR GATE ── -->
    <div id="card-gates" class="bg-slate-900/80 rounded-2xl p-5 border border-purple-900/30 shadow-xl backdrop-blur-sm">
      <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-1 mb-3">
        <h3 class="text-sm font-bold text-slate-200 flex items-center gap-2">
          <span>🧮 Lift por Gate — Eficiência dos Filtros</span>
        </h3>
        <div id="dj-gates-header" class="text-xs text-slate-400 font-mono">
          Aguardando primeira calibração...
        </div>
      </div>

      <div class="overflow-x-auto rounded-xl border border-slate-800">
        <table class="w-full text-xs text-left">
          <thead class="bg-slate-950/90 text-slate-400 uppercase tracking-wider font-semibold border-b border-slate-800">
            <tr>
              <th class="py-2.5 px-3">Gate</th>
              <th class="py-2.5 px-2 text-right">N</th>
              <th class="py-2.5 px-2 text-right">WR%</th>
              <th class="py-2.5 px-2 text-right">EV%</th>
              <th class="py-2.5 px-2 text-right">Lift%</th>
              <th class="py-2.5 px-2 text-right">IC 95%</th>
              <th class="py-2.5 px-3 text-center">Verdict</th>
            </tr>
          </thead>
          <tbody id="dj-gates-body" class="divide-y divide-slate-800/60 font-mono">
            <tr>
              <td colspan="7" class="text-center text-slate-500 py-6 font-sans">
                Sem dados de calibração ainda. Execute a auditoria manual ou aguarde o ciclo de 03:00 UTC...
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- Resumo de Verdicts -->
      <div class="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-2.5 text-xs">
        <div class="bg-emerald-950/30 border border-emerald-800/50 rounded-xl p-2.5 text-center">
          <div id="dj-keep-count" class="text-emerald-400 font-black text-xl font-mono">0</div>
          <div class="text-emerald-500 font-medium mt-0.5">KEEP</div>
        </div>
        <div class="bg-amber-950/30 border border-amber-800/50 rounded-xl p-2.5 text-center">
          <div id="dj-adjust-count" class="text-amber-400 font-black text-xl font-mono">0</div>
          <div class="text-amber-500 font-medium mt-0.5">AJUSTE</div>
        </div>
        <div class="bg-rose-950/30 border border-rose-800/50 rounded-xl p-2.5 text-center">
          <div id="dj-remove-count" class="text-rose-400 font-black text-xl font-mono">0</div>
          <div class="text-rose-500 font-medium mt-0.5">REVISAR</div>
        </div>
        <div class="bg-slate-800/40 border border-slate-700/50 rounded-xl p-2.5 text-center">
          <div id="dj-waiting-count" class="text-slate-400 font-black text-xl font-mono">0</div>
          <div class="text-slate-500 font-medium mt-0.5">AGUARDANDO</div>
        </div>
      </div>
    </div>

    <!-- ── CARD 3: LATÊNCIA VS EV ── -->
    <div id="card-latency" class="bg-slate-900/80 rounded-2xl p-5 border border-purple-900/30 shadow-xl backdrop-blur-sm">
      <div class="flex items-center justify-between mb-3">
        <h3 class="text-sm font-bold text-slate-200 flex items-center gap-2">
          <span>⏱️ Latência vs EV — Decaimento do Alpha</span>
        </h3>
        <span class="text-xs text-slate-500 font-mono">Gate: LATENCY_ABORT</span>
      </div>

      <div id="dj-latency-chart" class="flex items-end justify-between gap-3 h-36 mb-3 px-4 bg-slate-950/60 rounded-xl p-4 border border-slate-800">
        <div class="flex-1 text-center">
          <div class="bg-slate-700 h-2 rounded-t mx-auto w-12" style="height: 20px;"></div>
          <div class="text-xs text-slate-400 mt-2 font-mono">0-400ms</div>
        </div>
        <div class="flex-1 text-center">
          <div class="bg-slate-700 h-2 rounded-t mx-auto w-12" style="height: 20px;"></div>
          <div class="text-xs text-slate-400 mt-2 font-mono">400-800ms</div>
        </div>
        <div class="flex-1 text-center">
          <div class="bg-slate-700 h-2 rounded-t mx-auto w-12" style="height: 20px;"></div>
          <div class="text-xs text-slate-400 mt-2 font-mono">800-1500ms</div>
        </div>
        <div class="flex-1 text-center">
          <div class="bg-slate-700 h-2 rounded-t mx-auto w-12" style="height: 20px;"></div>
          <div class="text-xs text-slate-400 mt-2 font-mono">1500ms+</div>
        </div>
      </div>

      <div id="dj-latency-note" class="text-xs text-slate-400 text-center bg-slate-950/40 p-2.5 rounded-lg border border-slate-800/60">
        Aguardando amostras suficientes para análise de correlação entre latência de execução e retorno.
      </div>
    </div>

    <!-- ── CARD 4: FAIXA DE MATURAÇÃO ── -->
    <div id="card-maturity" class="bg-slate-900/80 rounded-2xl p-5 border border-purple-900/50 shadow-xl backdrop-blur-sm">
      <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-1 mb-2">
        <h3 class="text-sm font-bold text-purple-300 flex items-center gap-2">
          <span>⏰ Faixa de Maturação — Qual Janela é Ideal?</span>
        </h3>
        <span class="text-xs text-slate-400">15 min (atual) vs "Momento Doce" (3-8 min)</span>
      </div>
      <div class="text-xs text-slate-500 mb-4">
        Avaliação empírica: os dados definem qual faixa cronológica entrega maior Expectancy Value (EV).
      </div>

      <!-- Tabela de Performance por Faixa -->
      <div class="overflow-x-auto rounded-xl border border-slate-800 mb-4">
        <table class="w-full text-xs text-left">
          <thead class="bg-slate-950/90 text-slate-400 uppercase tracking-wider font-semibold border-b border-slate-800">
            <tr>
              <th class="py-2.5 px-3">Faixa de Idade</th>
              <th class="py-2.5 px-2 text-right">Trades</th>
              <th class="py-2.5 px-2 text-right">WR%</th>
              <th class="py-2.5 px-2 text-right">Avg PnL%</th>
              <th class="py-2.5 px-2 text-right">Avg Win%</th>
              <th class="py-2.5 px-2 text-right">Avg Loss%</th>
              <th class="py-2.5 px-3 text-right">Total PnL (SOL)</th>
            </tr>
          </thead>
          <tbody id="dj-maturity-body" class="divide-y divide-slate-800/60 font-mono">
            <tr>
              <td colspan="7" class="text-center text-slate-500 py-6 font-sans">
                Aguardando trades fechados com idade de token registrada no ledger...
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- Comparação de Estratégias -->
      <div class="bg-slate-950/80 rounded-xl p-4 border border-purple-950/60">
        <div class="text-xs text-slate-300 mb-3 font-bold flex items-center gap-2">
          <span>📊 COMPARAÇÃO DE ESTRATÉGIAS</span>
          <span class="text-[10px] text-slate-500 font-normal">(Requisito: N ≥ 30 por faixa)</span>
        </div>
        <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
          <!-- Momento Doce -->
          <div class="bg-slate-900/90 rounded-xl p-3 border border-amber-500/30">
            <div class="text-xs text-amber-400 font-bold mb-2 flex items-center gap-1.5">
              <span>🟡</span>
              <span>Momento Doce (3-8 min)</span>
            </div>
            <div class="space-y-1 text-xs text-slate-400 font-mono">
              <div class="flex justify-between"><span>N:</span> <strong id="dj-mc-n" class="text-white">—</strong></div>
              <div class="flex justify-between"><span>WR:</span> <strong id="dj-mc-wr" class="text-white">—</strong></div>
              <div class="flex justify-between"><span>EV:</span> <strong id="dj-mc-ev" class="text-white">—</strong></div>
              <div class="flex justify-between"><span>PnL:</span> <strong id="dj-mc-pnl" class="text-white">—</strong></div>
            </div>
          </div>
          <!-- Janela Atual -->
          <div class="bg-purple-950/30 rounded-xl p-3 border border-purple-500/40">
            <div class="text-xs text-purple-400 font-bold mb-2 flex items-center gap-1.5">
              <span>🟣</span>
              <span>Janela Atual (15-30 min)</span>
            </div>
            <div class="space-y-1 text-xs text-slate-400 font-mono">
              <div class="flex justify-between"><span>N:</span> <strong id="dj-ja-n" class="text-white">—</strong></div>
              <div class="flex justify-between"><span>WR:</span> <strong id="dj-ja-wr" class="text-white">—</strong></div>
              <div class="flex justify-between"><span>EV:</span> <strong id="dj-ja-ev" class="text-white">—</strong></div>
              <div class="flex justify-between"><span>PnL:</span> <strong id="dj-ja-pnl" class="text-white">—</strong></div>
            </div>
          </div>
          <!-- Estendida -->
          <div class="bg-slate-900/90 rounded-xl p-3 border border-cyan-500/30">
            <div class="text-xs text-cyan-400 font-bold mb-2 flex items-center gap-1.5">
              <span>🔵</span>
              <span>Estendida (30-60 min)</span>
            </div>
            <div class="space-y-1 text-xs text-slate-400 font-mono">
              <div class="flex justify-between"><span>N:</span> <strong id="dj-ee-n" class="text-white">—</strong></div>
              <div class="flex justify-between"><span>WR:</span> <strong id="dj-ee-wr" class="text-white">—</strong></div>
              <div class="flex justify-between"><span>EV:</span> <strong id="dj-ee-ev" class="text-white">—</strong></div>
              <div class="flex justify-between"><span>PnL:</span> <strong id="dj-ee-pnl" class="text-white">—</strong></div>
            </div>
          </div>
        </div>
        <div id="dj-maturity-verdict" class="mt-3 text-xs text-center text-slate-400 bg-slate-900/60 p-2.5 rounded-lg border border-slate-800">
          Aguardando N ≥ 30 em cada faixa para determinação estatística...
        </div>
      </div>
    </div>
  </div>

  <!-- ═══════════════════════════════════════════════ -->
  <!-- JAVASCRIPT — Atualização dos 4 Cards            -->
  <!-- ═══════════════════════════════════════════════ -->
  <script>
    // ── FUNÇÕES DE FETCH ASSÍNCRONO NÃO-BLOQUEANTE ──

    async function refreshJournalCards() {
      try {
        await Promise.all([
          fetchCard1_Funnel(),
          fetchCard2_Gates(),
          fetchCard3_Latency(),
          fetchCard4_Maturity()
        ]);
      } catch (e) {
        // Silencioso em caso de latência momentânea
      }
    }

    // ── CARD 1: Funil ──
    async function fetchCard1_Funnel() {
      try {
        const res = await fetch('/api/journal/stats');
        if (!res.ok) return;
        const data = await res.json();

        const elDec = document.getElementById('dj-total-decisions');
        const elTr = document.getElementById('dj-closed-trades');
        const elTgt = document.getElementById('dj-target-n');
        const elBuf = document.getElementById('dj-buffer-count');
        const elBar = document.getElementById('dj-progress-bar');
        const elLbl = document.getElementById('dj-progress-label');

        if (elDec) elDec.textContent = data.totalDecisions || 0;
        if (elTr) elTr.textContent = data.totalClosedTrades || 0;
        if (elTgt) elTgt.textContent = data.targetN || 150;
        if (elBuf) elBuf.textContent = data.buffer ? data.buffer.bufferSize : 0;

        const pct = data.progressPct || 0;
        if (elBar) elBar.style.width = pct + '%';
        if (elLbl) elLbl.textContent = (data.totalClosedTrades || 0) + '/' + (data.targetN || 150) + ' (' + pct + '%)';

        // Breakdown de decisões
        const container = document.getElementById('dj-decision-breakdown');
        if (container && data.decisionBreakdown && data.decisionBreakdown.length > 0) {
          const colors = {
            'ENTRY_APPROVED': 'bg-emerald-950/60 text-emerald-400 border-emerald-800/80',
            'ENTRY_REJECTED': 'bg-rose-950/60 text-rose-400 border-rose-800/80',
            'EXIT_SL': 'bg-amber-950/60 text-amber-400 border-amber-800/80',
            'EXIT_BE': 'bg-blue-950/60 text-blue-400 border-blue-800/80',
            'EXIT_PARTIAL': 'bg-purple-950/60 text-purple-400 border-purple-800/80',
            'EXIT_TRAILING': 'bg-teal-950/60 text-teal-400 border-teal-800/80',
            'EXIT_TIME_STOP': 'bg-yellow-950/60 text-yellow-400 border-yellow-800/80',
            'EXIT_WATCHDOG': 'bg-rose-950/60 text-rose-400 border-rose-800/80',
            'EXIT_PANIC': 'bg-red-950/60 text-red-400 border-red-800/80',
            'ABORTED_LATENCY': 'bg-slate-800 text-slate-400 border-slate-700'
          };
          container.innerHTML = data.decisionBreakdown.map(function(d) {
            const cls = colors[d.decision] || 'bg-slate-800 text-slate-400 border-slate-700';
            return '<span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-mono border ' +
                   cls + '">' + d.decision + ' <strong class="text-white">' + d.total + '</strong></span>';
          }).join('');
        }
      } catch (err) {}
    }

    // ── CARD 2: Gates ──
    async function fetchCard2_Gates() {
      try {
        const res = await fetch('/api/journal/gates');
        if (!res.ok) return;
        const data = await res.json();

        const elHdr = document.getElementById('dj-gates-header');
        if (elHdr && data.lastCalibrationAt) {
          elHdr.textContent = 'Última calibração: ' + new Date(data.lastCalibrationAt).toLocaleString('pt-BR');
        }

        const tbody = document.getElementById('dj-gates-body');
        if (tbody && data.gates && data.gates.length > 0) {
          const verdictColors = {
            'KEEP': 'text-emerald-400',
            'LOOSEN': 'text-amber-400',
            'TIGHTEN': 'text-amber-400',
            'REMOVE': 'text-rose-400',
            'INSUFFICIENT_DATA': 'text-slate-500'
          };
          const verdictIcons = {
            'KEEP': '✅',
            'LOOSEN': '🟡',
            'TIGHTEN': '🟡',
            'REMOVE': '🔴',
            'INSUFFICIENT_DATA': '⏳'
          };

          tbody.innerHTML = data.gates.map(function(g) {
            const vColor = verdictColors[g.gate_verdict] || 'text-slate-500';
            const vIcon = verdictIcons[g.gate_verdict] || '⏳';
            const evColor = (g.ev_net_pct != null && g.ev_net_pct >= 0) ? 'text-emerald-400' : 'text-rose-400';
            const liftColor = (g.lift_pct != null && g.lift_pct >= 0) ? 'text-emerald-400' : 'text-rose-400';
            const nColor = (g.sample_size < 30) ? 'text-amber-400' : 'text-white';

            return '<tr class="border-b border-slate-800/60 hover:bg-slate-800/30 transition">' +
              '<td class="py-2.5 px-3 text-slate-300 font-sans font-medium">' + g.gate_name + '</td>' +
              '<td class="py-2.5 px-2 text-right font-mono ' + nColor + '">' + g.sample_size + '</td>' +
              '<td class="py-2.5 px-2 text-right font-mono text-white">' +
                (g.win_rate != null ? Number(g.win_rate).toFixed(1) + '%' : '—') + '</td>' +
              '<td class="py-2.5 px-2 text-right font-mono ' + evColor + '">' +
                (g.ev_net_pct != null ? (g.ev_net_pct > 0 ? '+' : '') + Number(g.ev_net_pct).toFixed(2) + '%' : '—') + '</td>' +
              '<td class="py-2.5 px-2 text-right font-mono ' + liftColor + '">' +
                (g.lift_pct != null ? (g.lift_pct > 0 ? '+' : '') + Number(g.lift_pct).toFixed(2) + '%' : '—') + '</td>' +
              '<td class="py-2.5 px-2 text-right font-mono text-slate-500">' +
                (g.ci_lower_pct != null && g.ci_upper_pct != null
                  ? '[' + Number(g.ci_lower_pct).toFixed(1) + ', ' + Number(g.ci_upper_pct).toFixed(1) + ']'
                  : '—') + '</td>' +
              '<td class="py-2.5 px-3 text-center font-sans font-semibold ' + vColor + '">' + vIcon + ' ' + (g.gate_verdict || 'PENDING') + '</td>' +
            '</tr>';
          }).join('');
        }

        if (data.summary) {
          const elK = document.getElementById('dj-keep-count');
          const elA = document.getElementById('dj-adjust-count');
          const elR = document.getElementById('dj-remove-count');
          const elW = document.getElementById('dj-waiting-count');
          if (elK) elK.textContent = data.summary.keep || 0;
          if (elA) elA.textContent = data.summary.adjust || 0;
          if (elR) elR.textContent = data.summary.remove || 0;
          if (elW) elW.textContent = data.summary.waiting || 0;
        }
      } catch (err) {}
    }

    // ── CARD 3: Latência ──
    async function fetchCard3_Latency() {
      try {
        const res = await fetch('/api/journal/latency');
        if (!res.ok) return;
        const data = await res.json();

        const chart = document.getElementById('dj-latency-chart');
        const note = document.getElementById('dj-latency-note');

        if (chart && data.buckets && data.buckets.length > 0) {
          const maxEv = Math.max.apply(null, data.buckets.map(function(b) {
            return Math.abs(b.ev_net_pct || 0);
          })) || 1;

          chart.innerHTML = data.buckets.map(function(b) {
            const ev = b.ev_net_pct || 0;
            const heightPx = Math.max(12, Math.round((Math.abs(ev) / maxEv) * 90));
            const color = ev >= 0 ? 'bg-emerald-500' : 'bg-rose-500';
            const evLabel = (ev > 0 ? '+' : '') + Number(ev).toFixed(1) + '%';

            return '<div class="flex-1 text-center flex flex-col justify-end items-center h-full">' +
              '<div class="text-[11px] font-mono ' + (ev >= 0 ? 'text-emerald-400' : 'text-rose-400') +
                ' mb-1 font-bold">' + evLabel + '</div>' +
              '<div class="w-12 rounded-t ' + color + ' shadow-sm transition-all" style="height: ' + heightPx + 'px;"></div>' +
              '<div class="text-xs text-slate-300 font-mono mt-2">' + b.bucket + '</div>' +
              '<div class="text-[10px] text-slate-500 font-mono">N=' + b.sample_size + '</div>' +
            '</div>';
          }).join('');

          if (note) {
            const slowBuckets = data.buckets.filter(function(b) { return b.ev_net_pct < 0; });
            if (slowBuckets.length > 0) {
              note.innerHTML = '<span class="text-amber-400 font-semibold">⚠️ Degradação de alpha detectada a partir de ~' +
                slowBuckets[0].bucket + '</span>';
            } else {
              note.innerHTML = '<span class="text-emerald-400 font-semibold">✅ Alpha positivo nas faixas monitoradas</span>';
            }
          }
        }
      } catch (err) {}
    }

    // ── CARD 4: Faixa de Maturação ──
    async function fetchCard4_Maturity() {
      try {
        const res = await fetch('/api/journal/maturity');
        if (!res.ok) return;
        const data = await res.json();

        // Tabela principal
        const tbody = document.getElementById('dj-maturity-body');
        if (tbody && data.ageBuckets && data.ageBuckets.length > 0) {
          tbody.innerHTML = data.ageBuckets.map(function(b) {
            const pnlColor = (b.avg_pnl_pct || 0) >= 0 ? 'text-emerald-400' : 'text-rose-400';
            const nColor = (b.n_trades < 30) ? 'text-amber-400' : 'text-white';

            return '<tr class="border-b border-slate-800/60 hover:bg-slate-800/30 transition">' +
              '<td class="py-2.5 px-3 text-slate-300 font-sans font-medium">' + b.age_bucket + '</td>' +
              '<td class="py-2.5 px-2 text-right font-mono ' + nColor + '">' + b.n_trades + '</td>' +
              '<td class="py-2.5 px-2 text-right font-mono text-white">' + (b.win_rate_pct != null ? b.win_rate_pct + '%' : '—') + '</td>' +
              '<td class="py-2.5 px-2 text-right font-mono ' + pnlColor + '">' +
                (b.avg_pnl_pct != null ? (b.avg_pnl_pct > 0 ? '+' : '') + b.avg_pnl_pct + '%' : '—') + '</td>' +
              '<td class="py-2.5 px-2 text-right font-mono text-emerald-400">' + (b.avg_win_pct != null ? '+' + b.avg_win_pct + '%' : '—') + '</td>' +
              '<td class="py-2.5 px-2 text-right font-mono text-rose-400">' + (b.avg_loss_pct != null ? b.avg_loss_pct + '%' : '—') + '</td>' +
              '<td class="py-2.5 px-3 text-right font-mono ' + pnlColor + '">' +
                (b.total_net_pnl_sol != null ? Number(b.total_net_pnl_sol).toFixed(6) : '—') + '</td>' +
            '</tr>';
          }).join('');
        }

        // Comparação de estratégias
        const strategies = data.strategyComparison || [];
        for (let i = 0; i < strategies.length; i++) {
          const s = strategies[i];
          const strat = s.strategy || '';
          const prefix = strat.indexOf('momento_doce') !== -1 ? 'dj-mc' :
                         strat.indexOf('janela_atual') !== -1 ? 'dj-ja' :
                         strat.indexOf('estendida') !== -1 ? 'dj-ee' : null;
          if (prefix) {
            const elN = document.getElementById(prefix + '-n');
            const elWr = document.getElementById(prefix + '-wr');
            const elEv = document.getElementById(prefix + '-ev');
            const elPnl = document.getElementById(prefix + '-pnl');
            if (elN) elN.textContent = s.n || '—';
            if (elWr) elWr.textContent = s.win_rate != null ? s.win_rate + '%' : '—';
            if (elEv) elEv.textContent = s.avg_pnl_pct != null ? (s.avg_pnl_pct > 0 ? '+' : '') + s.avg_pnl_pct + '%' : '—';
            if (elPnl) elPnl.textContent = s.total_pnl_sol != null ? Number(s.total_pnl_sol).toFixed(6) + ' SOL' : '—';
          }
        }

        // Veredito
        const verdict = document.getElementById('dj-maturity-verdict');
        if (verdict) {
          if (strategies.length >= 2) {
            const best = strategies[0];
            const names = {
              'momento_doce_3_8min': '🟡 MOMENTO DOCE (3-8 min)',
              'janela_atual_15_30min': '🟣 JANELA ATUAL (15-30 min)',
              'janela_estendida_30_60min': '🔵 ESTENDIDA (30-60 min)'
            };
            verdict.innerHTML =
              '<span class="text-emerald-400 font-bold">🏆 Melhor faixa: ' +
              (names[best.strategy] || best.strategy) +
              '</span> — EV: +' + best.avg_pnl_pct + '% | WR: ' + best.win_rate + '% | N: ' + best.n;
          } else {
            verdict.textContent = data.note || 'Aguardando N ≥ 30 em cada faixa para determinação estatística...';
          }
        }
      } catch (err) {}
    }

    // ── BOTÃO: Executar Calibração Manual ──
    async function runCalibrationManual(event) {
      const btn = document.getElementById('btn-run-calibration') || (event ? event.target : null);
      const textSpan = document.getElementById('btn-run-calibration-text');
      if (btn) btn.disabled = true;
      if (textSpan) textSpan.textContent = 'Executando auditoria assíncrona...';

      try {
        const res = await fetch('/api/calibration/run', { method: 'POST' });
        const data = await res.json();

        if (data.success) {
          if (textSpan) textSpan.textContent = '✅ Auditoria Concluída com Sucesso';
          await refreshJournalCards();
        } else {
          if (textSpan) textSpan.textContent = '❌ Falha na auditoria: ' + (data.error || 'Erro');
        }
      } catch (e) {
        if (textSpan) textSpan.textContent = '❌ Erro de conexão com o servidor';
      }

      setTimeout(function() {
        if (btn) btn.disabled = false;
        if (textSpan) textSpan.textContent = 'Executar Auditoria de Calibração Sob Demanda';
      }, 3500);
    }

    // ── INICIALIZAÇÃO IMEDIATA & POLLING A CADA 2.5s ──
    refreshJournalCards();
    setInterval(refreshJournalCards, 2500);
  </script>
  `;
}
