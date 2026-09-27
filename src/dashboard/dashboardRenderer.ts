export interface DashboardState {
  agent: string;
  wallet: string;
  balanceSol: number;
  vitalityState: string;
  dryRun: boolean;
  macroRegime: string;
  circuitBreakerActive: boolean;
  activeRpcUrl: string;
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
        <td style="padding: 14px 16px; font-weight: 600; color: #F8FAFC;">
          ${p.symbol}
          <div style="font-size: 11px; color: #64748B; font-family: monospace;">${p.mint.substring(0, 6)}...${p.mint.substring(p.mint.length - 4)}</div>
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
          <a href="${p.dexScreenerUrl}" target="_blank" style="margin-right: 8px; font-size: 12px; color: #38BDF8; text-decoration: none; padding: 4px 8px; background: rgba(56,189,248,0.1); border-radius: 4px;">DexScreener ↗</a>
          <a href="${p.solscanUrl}" target="_blank" style="font-size: 12px; color: #A855F7; text-decoration: none; padding: 4px 8px; background: rgba(168,85,247,0.1); border-radius: 4px;">Solscan ↗</a>
        </td>
      </tr>
    `).join('');

  const auditsRows = state.recentAudits.slice(0, 6).map(a => `
    <tr style="border-bottom: 1px solid #1E293B; font-size: 13px;">
      <td style="padding: 10px 16px; color: #F1F5F9; font-weight: 500;">${a.symbol}</td>
      <td style="padding: 10px 16px;">
        <span style="padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; background: ${a.isSafe ? 'rgba(16,185,129,0.15)' : 'rgba(239,68,68,0.15)'}; color: ${a.isSafe ? '#10B981' : '#EF4444'};">
          ${a.isSafe ? 'APROVADO' : 'VETADO'}
        </span>
      </td>
      <td style="padding: 10px 16px; font-family: monospace; color: #CBD5E1;">${a.score}/100</td>
      <td style="padding: 10px 16px; color: #94A3B8; font-size: 12px;">${a.reason || 'Verificação concluída'}</td>
      <td style="padding: 10px 16px; text-align: right; color: #64748B; font-size: 11px;">${new Date(a.timestamp).toLocaleTimeString()}</td>
    </tr>
  `).join('');

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Nexus Quant Solana - Terminal Autônomo</title>
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
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 16px; margin-bottom: 24px; }
    .card { background: #131B2B; border: 1px solid #1E293B; border-radius: 10px; padding: 20px; box-shadow: 0 4px 20px rgba(0,0,0,0.25); }
    .card-label { font-size: 12px; font-weight: 500; color: #94A3B8; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 8px; }
    .card-value { font-size: 24px; font-weight: 700; color: #F8FAFC; font-family: 'JetBrains Mono', monospace; }
    .card-sub { font-size: 12px; color: #64748B; margin-top: 6px; }
    .table-container { background: #131B2B; border: 1px solid #1E293B; border-radius: 10px; overflow: hidden; margin-bottom: 24px; }
    .table-header { padding: 16px 20px; border-bottom: 1px solid #1E293B; display: flex; justify-content: space-between; align-items: center; }
    .table-header h2 { font-size: 16px; font-weight: 600; }
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
      <div>
        <span style="font-size: 12px; color: #64748B;">Auto-refresh: 5s | Última leitura: ${new Date(state.lastUpdated).toLocaleTimeString()}</span>
      </div>
    </div>

    <!-- Cards de Métricas -->
    <div class="grid">
      <div class="card">
        <div class="card-label">Saldo On-Chain (Phantom)</div>
        <div class="card-value" style="color: #38BDF8;">${state.balanceSol.toFixed(4)} <span style="font-size: 16px;">SOL</span></div>
        <div class="card-sub">Estado Vital: <strong style="color: #10B981;">${state.vitalityState}</strong></div>
      </div>

      <div class="card">
        <div class="card-label">Disjuntor Macro Sentinel</div>
        <div class="card-value" style="color: ${state.circuitBreakerActive ? '#EF4444' : '#10B981'};">
          ${state.circuitBreakerActive ? '🛑 LIGADO' : '🛡️ SEGURO'}
        </div>
        <div class="card-sub">Regime: <strong>${state.macroRegime}</strong></div>
      </div>

      <div class="card">
        <div class="card-label">Posições Abertas</div>
        <div class="card-value">${state.positions.length} <span style="font-size: 16px;">Ativas</span></div>
        <div class="card-sub">Risco por entrada: <strong>0.015 SOL (Ayla)</strong></div>
      </div>

      <div class="card">
        <div class="card-label">Filtro & Quarentena Anti-Spam</div>
        <div class="card-value" style="color: #F59E0B;">${state.quarantineCount} <span style="font-size: 16px;">Tokens</span></div>
        <div class="card-sub">Modo: <strong>${state.dryRun ? 'Simulação (Dry-Run)' : 'Real On-Chain ⚠️'}</strong></div>
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
            <th>PnL %</th>
            <th>Alvos de Risco</th>
            <th style="text-align: right;">Ações On-Chain</th>
          </tr>
        </thead>
        <tbody>
          ${positionsRows}
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
</body>
</html>`;
}
