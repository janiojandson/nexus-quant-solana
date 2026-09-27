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
  exitReason: 'TAKE_PROFIT' | 'STOP_LOSS' | 'MANUAL' | 'HOLD';
  txSignature?: string;
  dexScreenerUrl: string;
  solscanUrl: string;
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
  }>;
  closedTrades: ClosedTradeView[];
  recentAudits: Array<{
    mint: string;
    symbol: string;
    isSafe: boolean;
    score: number;
    reason?: string;
    timestamp: number;
  }>;
  quarantineCount: number;
  lastUpdated: string;
}

export function renderDashboardHtml(state: DashboardState): string {
  const pnlColor = (pnl: number) => (pnl >= 0 ? '#10B981' : '#EF4444');
  const formatUsd = (num: number) => `$${num.toFixed(6)}`;

  const positionsRows = state.positions.length === 0
    ? `<tr><td colspan="7" style="text-align: center; color: #94A3B8; padding: 24px;">Nenhuma posição aberta no momento. O scanner está caçando novas oportunidades elegíveis...</td></tr>`
    : state.positions.map(p => `
      <tr style="border-bottom: 1px solid #1E293B;">
        <td style="padding: 14px 16px; font-weight: 600;">
          <a href="https://solscan.io/token/${p.mint}" target="_blank" title="Ver token na Solana (Solscan)" style="color: #38BDF8; text-decoration: none; display: inline-flex; align-items: center; gap: 4px;">
            <span>${p.symbol}</span>
            <span style="font-size: 11px;">↗</span>
          </a>
          <div style="font-size: 11px; color: #64748B; font-family: monospace;">
            <a href="https://solscan.io/token/${p.mint}" target="_blank" style="color: #64748B; text-decoration: none;">${p.mint.substring(0, 6)}...${p.mint.substring(p.mint.length - 4)}</a>
          </div>
        </td>
        <td style="padding: 14px 16px; font-family: monospace; color: #CBD5E1;">${Number(p.tokenAmount).toLocaleString()}</td>
        <td style="padding: 14px 16px; font-family: monospace; color: #CBD5E1;">${formatUsd(p.entryPriceUsd)}</td>
        <td style="padding: 14px 16px; font-family: monospace; color: #CBD5E1;">${formatUsd(p.currentPriceUsd)}</td>
        <td style="padding: 14px 16px; font-weight: 700; font-family: monospace; color: ${pnlColor(p.pnlPct)};">
          ${p.pnlPct >= 0 ? '+' : ''}${(p.pnlPct * 100).toFixed(2)}%
        </td>
        <td style="padding: 14px 16px; font-size: 12px; font-family: monospace; color: #94A3B8;">
          SL: ${(p.stopLossPct * 100).toFixed(0)}% | TP: +${(p.takeProfitPct * 100).toFixed(0)}%
        </td>
        <td style="padding: 14px 16px; text-align: right;">
          <button onclick="emergencyExit('${p.mint}', '${p.symbol}')" style="margin-right: 8px; font-size: 11px; font-weight: 700; color: #FFFFFF; background: #EF4444; border: none; padding: 5px 10px; border-radius: 4px; cursor: pointer; transition: background 0.2s;" onmouseover="this.style.background='#DC2626'" onmouseout="this.style.background='#EF4444'">🚨 Vender a Mercado</button>
          <a href="${p.dexScreenerUrl}" target="_blank" style="margin-right: 8px; font-size: 12px; color: #38BDF8; text-decoration: none; padding: 4px 8px; background: rgba(56,189,248,0.1); border-radius: 4px;">DexScreener ↗</a>
          <a href="https://solscan.io/token/${p.mint}" target="_blank" style="font-size: 12px; color: #A855F7; text-decoration: none; padding: 4px 8px; background: rgba(168,85,247,0.1); border-radius: 4px;">Solana Explorer ↗</a>
        </td>
      </tr>
    `).join('');

  const closedRows = state.closedTrades.length === 0
    ? `<tr><td colspan="7" style="text-align: center; color: #94A3B8; padding: 24px;">Nenhum trade encerrado ainda. As operações fechadas com lucro (+TP) ou proteção (-SL) aparecerão detalhadas aqui.</td></tr>`
    : state.closedTrades.map(c => `
      <tr style="border-bottom: 1px solid #1E293B;">
        <td style="padding: 12px 16px; font-weight: 600;">
          <a href="https://solscan.io/token/${c.mint}" target="_blank" title="Ver token na Solana (Solscan)" style="color: #38BDF8; text-decoration: none; display: inline-flex; align-items: center; gap: 4px;">
            <span>${c.symbol}</span>
            <span style="font-size: 11px;">↗</span>
          </a>
          <div style="font-size: 11px; color: #64748B; font-family: monospace;">
            <a href="https://solscan.io/token/${c.mint}" target="_blank" style="color: #64748B; text-decoration: none;">${c.mint.substring(0, 6)}...${c.mint.substring(c.mint.length - 4)}</a>
          </div>
        </td>
        <td style="padding: 12px 16px;">
          <span style="padding: 3px 8px; border-radius: 4px; font-size: 11px; font-weight: 700; background: ${c.exitReason === 'TAKE_PROFIT' ? 'rgba(16,185,129,0.15)' : 'rgba(239,68,68,0.15)'}; color: ${c.exitReason === 'TAKE_PROFIT' ? '#10B981' : '#EF4444'};">
            ${c.exitReason === 'TAKE_PROFIT' ? '🟢 TAKE-PROFIT (+50%)' : '🔴 STOP-LOSS (-20%)'}
          </span>
        </td>
        <td style="padding: 12px 16px; font-family: monospace; color: #CBD5E1;">${formatUsd(c.entryPriceUsd)}</td>
        <td style="padding: 12px 16px; font-family: monospace; color: #CBD5E1;">${formatUsd(c.exitPriceUsd)}</td>
        <td style="padding: 12px 16px; font-weight: 700; font-family: monospace; color: ${pnlColor(c.pnlPct)};">
          ${c.pnlPct >= 0 ? '+' : ''}${(c.pnlPct * 100).toFixed(2)}%
          <div style="font-size: 11px; color: ${pnlColor(c.pnlSolEst)}; font-weight: 500;">${c.pnlSolEst >= 0 ? '+' : ''}${c.pnlSolEst.toFixed(4)} SOL</div>
        </td>
        <td style="padding: 12px 16px; font-size: 12px; color: #94A3B8;">${new Date(c.exitTimestamp).toLocaleTimeString()}</td>
        <td style="padding: 12px 16px; text-align: right;">
          <a href="${c.dexScreenerUrl}" target="_blank" style="margin-right: 6px; font-size: 11px; color: #38BDF8; text-decoration: none; padding: 3px 6px; background: rgba(56,189,248,0.1); border-radius: 4px;">Gráfico</a>
          <a href="https://solscan.io/token/${c.mint}" target="_blank" style="margin-right: 6px; font-size: 11px; color: #A855F7; text-decoration: none; padding: 3px 6px; background: rgba(168,85,247,0.1); border-radius: 4px;">Solana</a>
          ${c.txSignature ? `<a href="https://solscan.io/tx/${c.txSignature}" target="_blank" style="font-size: 11px; color: #10B981; text-decoration: none; padding: 3px 6px; background: rgba(16,185,129,0.1); border-radius: 4px;">Tx</a>` : ''}
        </td>
      </tr>
    `).join('');

  const auditsRows = state.recentAudits.slice(0, 8).map(a => `
    <tr style="border-bottom: 1px solid #1E293B; font-size: 13px;">
      <td style="padding: 10px 16px; font-weight: 500;">
        <a href="https://solscan.io/token/${a.mint}" target="_blank" style="color: #38BDF8; text-decoration: none; display: inline-flex; align-items: center; gap: 4px;">
          <span>${a.symbol}</span>
          <span style="font-size: 10px;">↗</span>
        </a>
      </td>
      <td style="padding: 10px 16px;">
        <span style="padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; background: ${a.isSafe ? 'rgba(16,185,129,0.15)' : 'rgba(239,68,68,0.15)'}; color: ${a.isSafe ? '#10B981' : '#EF4444'};">
          ${a.isSafe ? 'APROVADO' : 'VETADO'}
        </span>
      </td>
      <td style="padding: 10px 16px; font-family: monospace; color: #CBD5E1;">${a.score}/100</td>
      <td style="padding: 10px 16px; color: #94A3B8; font-size: 12px;">${a.reason || 'Verificação concluída'}</td>
      <td style="padding: 10px 16px; text-align: right; color: #64748B; font-size: 11px;">
        <a href="https://dexscreener.com/solana/${a.mint}" target="_blank" style="color: #38BDF8; text-decoration: none; margin-right: 8px;">DexScreener</a>
        <a href="https://solscan.io/token/${a.mint}" target="_blank" style="color: #A855F7; text-decoration: none;">Solana</a>
      </td>
    </tr>
  `).join('');

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Nexus Quant Solana - Terminal Institucional</title>
  <meta http-equiv="refresh" content="5">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;600;700&display=swap" rel="stylesheet">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; font-family: 'Inter', -apple-system, sans-serif; }
    body { background-color: #0B0F17; color: #F8FAFC; min-height: 100vh; padding: 24px; }
    .container { max-width: 1300px; margin: 0 auto; }
    .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; padding-bottom: 20px; border-bottom: 1px solid #1E293B; }
    .title-box { display: flex; align-items: center; gap: 12px; }
    .status-badge { display: flex; align-items: center; gap: 6px; font-size: 12px; padding: 4px 10px; border-radius: 9999px; background: rgba(16, 185, 129, 0.1); color: #10B981; font-weight: 600; }
    .pulse-dot { width: 8px; height: 8px; border-radius: 50%; background: #10B981; box-shadow: 0 0 10px #10B981; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; margin-bottom: 24px; }
    .card { background: #131B2B; border: 1px solid #1E293B; border-radius: 10px; padding: 18px; box-shadow: 0 4px 20px rgba(0,0,0,0.25); }
    .card-label { font-size: 11px; font-weight: 600; color: #94A3B8; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 6px; }
    .card-value { font-size: 22px; font-weight: 700; color: #F8FAFC; font-family: 'JetBrains Mono', monospace; }
    .card-sub { font-size: 11px; color: #64748B; margin-top: 5px; }
    .table-container { background: #131B2B; border: 1px solid #1E293B; border-radius: 10px; overflow: hidden; margin-bottom: 24px; }
    .table-header { padding: 16px 20px; border-bottom: 1px solid #1E293B; display: flex; justify-content: space-between; align-items: center; }
    .table-header h2 { font-size: 15px; font-weight: 600; }
    table { width: 100%; border-collapse: collapse; text-align: left; }
    th { padding: 12px 16px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: #64748B; background: #0E1626; border-bottom: 1px solid #1E293B; }
    .wallet-pill { font-family: 'JetBrains Mono', monospace; font-size: 12px; color: #38BDF8; background: rgba(56,189,248,0.1); padding: 4px 10px; border-radius: 6px; display: inline-block; word-break: break-all; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="title-box">
        <h1 style="font-size: 22px; font-weight: 700; letter-spacing: -0.02em;">🚀 Nexus Quant Solana</h1>
        <div class="status-badge"><div class="pulse-dot"></div> 24/7 ONLINE</div>
      </div>
      <div style="display: flex; align-items: center; gap: 16px;">
        <button onclick="liquidateAll()" style="font-size: 13px; font-weight: 700; color: #FFFFFF; background: #DC2626; border: 1px solid #EF4444; padding: 8px 16px; border-radius: 6px; cursor: pointer; display: flex; align-items: center; gap: 6px; box-shadow: 0 0 15px rgba(220,38,38,0.4);" onmouseover="this.style.background='#B91C1C'" onmouseout="this.style.background='#DC2626'">
          <span>🛑</span> Liquidar Tudo (Panic Button)
        </button>
        <span style="font-size: 12px; color: #64748B;">Auto-refresh: 5s | Última leitura: ${new Date(state.lastUpdated).toLocaleTimeString()}</span>
      </div>
    </div>

    <!-- Cards de Métricas e Governança Financeira -->
    <div class="grid">
      <div class="card">
        <div class="card-label">Saldo On-Chain (Phantom)</div>
        <div class="card-value" style="color: #38BDF8;">${state.balanceSol.toFixed(4)} <span style="font-size: 14px;">SOL</span></div>
        <div class="card-sub">Vitalidade: <strong style="color: #10B981;">${state.vitalityState}</strong></div>
      </div>

      <div class="card">
        <div class="card-label">PnL Realizado Fechado</div>
        <div class="card-value" style="color: ${pnlColor(state.totalRealizedPnlSol)};">
          ${state.totalRealizedPnlSol >= 0 ? '+' : ''}${state.totalRealizedPnlSol.toFixed(4)} <span style="font-size: 14px;">SOL</span>
        </div>
        <div class="card-sub">Trades Encerrados: <strong>${state.closedTrades.length}</strong></div>
      </div>

      <div class="card">
        <div class="card-label">Taxas de Rede & ATA Estimadas</div>
        <div class="card-value" style="color: #F59E0B;">~${state.totalNetworkFeesSolEst.toFixed(4)} <span style="font-size: 14px;">SOL</span></div>
        <div class="card-sub">Criação de Contas ATA + Prioridade</div>
      </div>

      <div class="card">
        <div class="card-label">Posições Abertas / Sentinel</div>
        <div class="card-value" style="color: ${state.positions.length > 0 ? '#38BDF8' : '#94A3B8'};">
          ${state.positions.length} <span style="font-size: 14px;">Em Custódia</span>
        </div>
        <div class="card-sub">Sentinel: <strong style="color: ${state.circuitBreakerActive ? '#EF4444' : '#10B981'};">${state.circuitBreakerActive ? '🛑 DISJUNTOR ATIVO' : '🛡️ SEGURO'}</strong></div>
      </div>
    </div>

    <!-- Tabela de Posições Abertas -->
    <div class="table-container">
      <div class="table-header">
        <h2>📊 Posições em Custódia e Gestão de Saída (Take-Profit & Stop-Loss)</h2>
        <span style="font-size: 12px; color: #94A3B8;">Take-Profit: +50% | Stop-Loss: -20% | Trailing Breakeven: Ativo</span>
      </div>
      <table>
        <thead>
          <tr>
            <th>Ativo</th>
            <th>Quantidade</th>
            <th>Preço Entrada</th>
            <th>Preço Atual</th>
            <th>PnL % Flutuante</th>
            <th>Alvos de Risco</th>
            <th style="text-align: right;">Ações On-Chain</th>
          </tr>
        </thead>
        <tbody>
          ${positionsRows}
        </tbody>
      </table>
    </div>

    <!-- Tabela de Histórico de Trades Fechados -->
    <div class="table-container">
      <div class="table-header">
        <h2>🏁 Histórico de Trades Fechados (Realized PnL & Saídas On-Chain)</h2>
        <span style="font-size: 12px; color: #94A3B8;">Histórico das últimas 50 posições encerradas</span>
      </div>
      <table>
        <thead>
          <tr>
            <th>Ativo</th>
            <th>Gatilho de Saída</th>
            <th>Preço Entrada</th>
            <th>Preço Saída</th>
            <th>PnL Líquido</th>
            <th>Horário Fechamento</th>
            <th style="text-align: right;">Auditoria</th>
          </tr>
        </thead>
        <tbody>
          ${closedRows}
        </tbody>
      </table>
    </div>

    <!-- Tabela de Auditorias Recentes -->
    <div class="table-container">
      <div class="table-header">
        <h2>🛡️ Histórico Recente de Análises (DexScreener + RugCheck + Ayla)</h2>
      </div>
      <table>
        <thead>
          <tr>
            <th>Token</th>
            <th>Veredito</th>
            <th>Score Segurança</th>
            <th>Motivo / Status</th>
            <th style="text-align: right;">Horário</th>
          </tr>
        </thead>
        <tbody>
          ${auditsRows.length === 0 ? '<tr><td colspan="5" style="text-align: center; color: #64748B; padding: 16px;">Aguardando varredura...</td></tr>' : auditsRows}
        </tbody>
      </table>
    </div>

    <!-- Rodapé de Configuração -->
    <div style="display: flex; justify-content: space-between; align-items: center; padding: 16px; background: #0E1626; border-radius: 8px; border: 1px solid #1E293B; font-size: 12px; color: #94A3B8;">
      <div>
        Carteira Oficial Phantom: <span class="wallet-pill">${state.wallet}</span>
      </div>
      <div>
        RPC Ativa: <span style="color: #CBD5E1; font-family: monospace;">${state.activeRpcUrl}</span>
      </div>
    </div>
  </div>

  <script>
    async function emergencyExit(mint, symbol) {
      if (!confirm('Deseja vender imediatamente a mercado o token ' + symbol + ' via Jupiter, resgatar a caução da ATA e colocá-lo em quarentena de 24h?')) {
        return;
      }
      try {
        const res = await fetch('/api/positions/' + encodeURIComponent(mint) + '/exit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        });
        const data = await res.json();
        if (data.success) {
          alert('✅ Venda de ' + symbol + ' executada com sucesso! Tx: ' + (data.txSignature || 'OK'));
          window.location.reload();
        } else {
          alert('❌ Falha na venda de ' + symbol + ': ' + (data.error || 'Erro desconhecido'));
        }
      } catch (err) {
        alert('❌ Erro de conexão ao solicitar venda: ' + err.message);
      }
    }

    async function liquidateAll() {
      if (!confirm('⚠️ ALERTA MÁXIMO: Deseja liquidar TODAS as posições em custódia imediatamente a mercado, resgatar as contas ATA e pausar as entradas?')) {
        return;
      }
      try {
        const res = await fetch('/api/positions/liquidate-all', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        });
        const data = await res.json();
        alert('🛑 Ordem de liquidação global disparada! ' + (data.message || ''));
        window.location.reload();
      } catch (err) {
        alert('❌ Erro de conexão na liquidação: ' + err.message);
      }
    }
  </script>
</body>
</html>`;
}
