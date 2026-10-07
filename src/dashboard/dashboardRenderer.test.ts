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
  totalRealizedPnlSol: 0.045,
  totalNetworkFeesSolEst: 0.002,
  sentinelHandoffQueue: 3,
  incubator: { waiting: 5, mature: 19, technicalDiscards: 3, entryEligible: 2 },
  exitPathHealth: {
    state: 'HEALTHY',
    canOpenNewPosition: true,
    canRunResearch: true,
    maxFailures: 0,
    affectedMints: [],
    reason: 'Jupiter rotas saudáveis',
    lastChangedAt: new Date().toISOString()
  },
  positions: [
    {
      mint: 'Mint111111111111111111111111111111111111111',
      symbol: 'RAYDOGE',
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
      stopStatusText: 'Stop Ativo: Trailing Momentum (-6% do Topo: +1.52%)',
      isSentinelHandoff: false
    },
    {
      mint: 'Mint222222222222222222222222222222222222222',
      symbol: 'SENTINELPUMP',
      tokenAmount: 500_000,
      entryPriceUsd: 0.0005,
      currentPriceUsd: 0.00062,
      pnlPct: 0.24,
      stopLossPct: -0.04,
      takeProfitPct: 0.50,
      entryTimestamp: Date.now(),
      dexScreenerUrl: 'https://dexscreener.com/solana/test2',
      solscanUrl: 'https://solscan.io/token/test2',
      trailingActive: true,
      stopStatusText: 'Stop Ativo: Trailing Momentum',
      isSentinelHandoff: true
    }
  ],
  closedTrades: [
    {
      mint: 'MintClosed111111111111111111111111111111111',
      symbol: 'CLOSEDEX',
      tokenAmount: 100_000,
      entryPriceUsd: 0.0001,
      exitPriceUsd: 0.00014,
      entryTimestamp: Date.now() - 3600000,
      exitTimestamp: Date.now() - 1800000,
      pnlPct: 0.40,
      pnlSolEst: 0.03,
      exitReason: 'TAKE_PROFIT',
      txSignature: '5J4XTxSignature111111111111111111111111111111111',
      dexScreenerUrl: 'https://dexscreener.com/solana/closedex',
      solscanUrl: 'https://solscan.io/token/closedex',
      isSentinelHandoff: false
    },
    {
      mint: 'MintClosed222222222222222222222222222222222',
      symbol: 'CLOSESENT',
      tokenAmount: 200_000,
      entryPriceUsd: 0.0002,
      exitPriceUsd: 0.00028,
      entryTimestamp: Date.now() - 7200000,
      exitTimestamp: Date.now() - 3600000,
      pnlPct: 0.40,
      pnlSolEst: 0.025,
      exitReason: 'PARTIAL_TAKE_PROFIT_50',
      txSignature: '4K3YTxSignature222222222222222222222222222222222',
      dexScreenerUrl: 'https://dexscreener.com/solana/closesent',
      solscanUrl: 'https://solscan.io/token/closesent',
      isSentinelHandoff: true
    }
  ],
  recentAudits: [],
  quarantineCount: 1085,
  scannerLogs: [
    { timestamp: '21:30:00', message: '⚡ SentinelHandoffScanner: capturado token PUMP_TOKEN' },
    { timestamp: '21:30:01', message: '🎯 DEX 5m Scanner: APROVADO token RAYDOGE' }
  ],
  lastUpdated: new Date().toISOString()
};

test('Dashboard Executivo reflete o layout limpo sem seções legadas poluidoras', () => {
  const html = renderDashboardHtml(state);

  // Seções legadas removidas definitivamente
  assert.doesNotMatch(html, /Pump\.fun Observatory/);
  assert.doesNotMatch(html, /Pump Strategy Lab/);
  assert.doesNotMatch(html, /Faixa de Maturação/);
  assert.doesNotMatch(html, /Comparação de Estratégias/);
  assert.doesNotMatch(html, /Pump SELL Fallback/);

  // Header Executivo
  assert.match(html, /NEXUS QUANT SOLANA/);
  assert.match(html, /SISTEMA 24\/7/);
  assert.match(html, /FBx2SK/);
  assert.match(html, /EXECUÇÃO REAL ON-CHAIN/);
  assert.match(html, /0\.2781 SOL/);

  // Cards Chave do Topo / Funil
  assert.match(html, /Incubadora/);
  assert.match(html, /Maturos para Análise/);
  assert.match(html, /Descartes Técnicos/);
  assert.match(html, /Elegíveis/);
  assert.match(html, /⚡ Fila Sentinel/);
  assert.match(html, /id="metric-sentinel-queue"/);

  // Posições Ativas com Badges de Origem
  assert.match(html, /Posições Ativas sob Gestão/);
  assert.match(html, /🎯 DEX 5m/);
  assert.match(html, /⚡ Sentinel/);
  assert.match(html, /RAYDOGE/);
  assert.match(html, /SENTINELPUMP/);
  assert.match(html, /Varrer contas SPL vazias/);

  // Histórico de Trades Fechados com Breakdown por Origem
  assert.match(html, /Histórico de Trades Fechados/);
  assert.match(html, /DEX 5m — PnL/);
  assert.match(html, /⚡ Sentinel — PnL/);
  assert.match(html, /Taxa de Acerto Global/);
  assert.match(html, /CLOSEDEX/);
  assert.match(html, /CLOSESENT/);

  // Decision Journal & Telemetria
  assert.match(html, /DECISION JOURNAL & CALIBRAÇÃO DE EV/);
  assert.match(html, /Telemetria &amp; Logs em Tempo Real/);
});

test('Dashboard possui controles de segurança e login administrativo', () => {
  const html = renderDashboardHtml(state);

  assert.match(html, /ENTRAR ADMIN/);
  assert.match(html, /PÂNICO GERAL/);
  assert.match(html, /LIQUIDAR POSIÇÃO/);
  assert.match(html, /adminFetch\('\/api\/positions\//);
  assert.doesNotMatch(html, /sessionStorage/);
  assert.doesNotMatch(html, /localStorage/);
  assert.match(html, /credentials: 'same-origin'/);
  assert.match(html, /\/api\/auth\/logout/);
  assert.match(html, /disabled data-admin-action="true"/);
});

test('todos os scripts inline gerados pelo dashboard têm sintaxe JavaScript válida', () => {
  const html = renderDashboardHtml(state);
  const scripts = Array.from(
    html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi),
    match => match[1]
  ).filter(script => script.trim().length > 0);

  assert.ok(scripts.length > 0);
  scripts.forEach((script, index) => {
    assert.doesNotThrow(
      () => new Function(script),
      `script inline #${index} deve compilar sem SyntaxError`
    );
  });
});

test('Dashboard lida graciosamente com estado vazio de posições e trades', () => {
  const emptyState: DashboardState = {
    ...state,
    positions: [],
    closedTrades: []
  };

  const html = renderDashboardHtml(emptyState);
  assert.match(html, /Aguardando candidato aprovado pelos filtros determinísticos/);
  assert.match(html, /Nenhum trade encerrado ainda/);
  assert.match(html, /0 \/ 2/);
});
