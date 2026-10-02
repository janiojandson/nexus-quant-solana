import test from 'node:test';
import assert from 'node:assert';
import { renderDashboardHtml, type DashboardState } from './dashboardRenderer.js';

const state: DashboardState = {
  agent: 'NEXUS_QUANT_SOLANA_V1',
  wallet: 'FBx2SKLDLsdeLM8owxU8MNVPKAfJpLpmpHHRgiZDqBoi',
  balanceSol: 0.278078952,
  initialDepositSol: 0.3133,
  vitalityState: 'NORMAL',
  dryRun: false,
  macroRegime: 'NEUTRAL_RANGING',
  circuitBreakerActive: false,
  activeRpcUrl: 'https://mainnet.helius-rpc.com/',
  totalRealizedPnlSol: 0,
  totalNetworkFeesSolEst: 0,
  incubator: { waiting: 0, mature: 19, technicalDiscards: 3, entryEligible: 1 },
  positions: [{
    mint: 'Mint111111111111111111111111111111111111111',
    symbol: 'TEST',
    tokenAmount: 1_000_000,
    entryPriceUsd: 0.001,
    currentPriceUsd: 0.00108,
    pnlPct: 0.08,
    stopLossPct: -0.06,
    takeProfitPct: 0.35,
    entryTimestamp: Date.now(),
    dexScreenerUrl: 'https://dexscreener.com/solana/test',
    solscanUrl: 'https://solscan.io/token/test',
    trailingActive: true,
    stopStatusText: 'Stop Ativo: Trailing Momentum (-6% do Topo: +1.52%)'
  }],
  closedTrades: [],
  recentAudits: [],
  quarantineCount: 1085,
  scannerLogs: [],
  lastUpdated: new Date().toISOString()
};

test('Dashboard reflete a estratégia operacional atual e permanece read-only para ações admin', () => {
  const html = renderDashboardHtml(state);

  assert.match(html, /EXECUÇÃO REAL ON-CHAIN/);
  assert.match(html, /5-60 min/);
  assert.match(html, /Filtro \$15k/);
  assert.match(html, /Elegíveis para Auditoria/);
  assert.match(html, /Sensor DexScreener 1\.5s/);
  assert.match(html, /SL inicial: -6%/);
  assert.match(html, /Trailing momentum: \+8%\/-6% do topo/);
  assert.match(html, /Stop Ativo: Trailing Momentum/);

  assert.match(html, /AÇÕES ADMIN PROTEGIDAS/);
  assert.match(html, /VENDA MANUAL PROTEGIDA/);
  assert.doesNotMatch(html, /VENDER AGORA \(PÂNICO\)/);
  assert.doesNotMatch(html, /Ultra-Fast 1\.5s quote loop/);
  assert.doesNotMatch(html, /Stop Loss: -8%/);

  // A API já entrega stopLossPct em percentual. O browser não pode multiplicar novamente por 100.
  assert.match(html, /p\.stopLossPct !== undefined \? p\.stopLossPct : -6/);
  assert.doesNotMatch(html, /p\.stopLossPct \* 100/);
});
