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
  exitPathHealth: {
    state: 'DEGRADED',
    canOpenNewPosition: false,
    canRunResearch: false,
    maxFailures: 2,
    affectedMints: ['Mint111111111111111111111111111111111111111'],
    reason: 'Jupiter /order unavailable',
    lastChangedAt: new Date().toISOString()
  },
  pumpObservatory: {
    enabled: true,
    running: true,
    readOnly: true,
    totalCreatedObserved: 12,
    activeCurves: 9,
    graduatedCount: 3,
    dexIndexedCount: 0,
    dexReadyCount: 0,
    lastCreateToObserverLagMs: 2400,
    maxCreateToObserverLagMs: 5100,
    lastObservedAt: new Date().toISOString(),
    recent: [{
      mint: 'PumpMint111111111111111111111111111111111111',
      symbol: 'PUMPX',
      name: 'Pump Nexus',
      creator: 'Creator11111111111111111111111111111111111',
      bondingCurve: 'Curve111111111111111111111111111111111111',
      slot: 300123456,
      signature: 'PumpTx111111111111111111111111111111111111111111111111',
      eventTimestampMs: Date.now() - 2400,
      observedAtMs: Date.now(),
      createToObserverLagMs: 2400,
      initialRealTokenReserves: '800',
      currentRealTokenReserves: '320',
      progressPct: 60,
      complete: false,
      solscanUrl: 'https://solscan.io/token/PumpMint111111111111111111111111111111111111',
      transactionUrl: 'https://solscan.io/tx/PumpTx111111111111111111111111111111111111111111111111',
      pumpUrl: 'https://pump.fun/coin/PumpMint111111111111111111111111111111111111'
    }]
  },
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

test('Dashboard reflete a estratégia operacional atual e só habilita ações após login admin', () => {
  const html = renderDashboardHtml(state);

  assert.match(html, /EXECUÇÃO REAL ON-CHAIN/);
  assert.match(html, /5-60 min/);
  assert.match(html, /Filtro \$15k/);
  assert.match(html, /Elegíveis para Auditoria/);
  assert.match(html, /PnL\/Stop Jupiter executável 1\.5s/);
  assert.match(html, /DexScreener referência/);
  assert.match(html, /SL inicial: -6%/);
  assert.match(html, /Trailing momentum: \+8%\/-6% do topo/);
  assert.match(html, /Stop Ativo: Trailing Momentum/);
  assert.match(html, /Proteção de Saída/);
  assert.match(html, /DEGRADED/);
  assert.match(html, /Jupiter \/order unavailable/);
  assert.match(html, /Pump\.fun Observatory/);
  assert.match(html, /READ-ONLY/);
  assert.match(html, /PUMPX/);
  assert.match(html, /60\.00%/);
  assert.match(html, /pump\.fun\/coin\/PumpMint/);
  assert.match(html, /solscan\.io\/token\/PumpMint/);

  assert.match(html, /ENTRAR ADMIN/);
  assert.match(html, /PÂNICO GERAL/);
  assert.match(html, /LIQUIDAR POSIÇÃO/);
  assert.match(html, /adminFetch\('\/api\/positions\//);
  assert.doesNotMatch(html, /sessionStorage/);
  assert.doesNotMatch(html, /localStorage/);
  assert.match(html, /credentials: 'same-origin'/);
  assert.match(html, /\/api\/auth\/logout/);
  assert.match(html, /disabled data-admin-action="true"/);
  assert.doesNotMatch(html, /Ultra-Fast 1\.5s quote loop/);
  assert.doesNotMatch(html, /Stop Loss: -8%/);

  // A API já entrega stopLossPct em percentual. O browser não pode multiplicar novamente por 100.
  assert.match(html, /p\.stopLossPct !== undefined \? p\.stopLossPct : -6/);
  assert.doesNotMatch(html, /p\.stopLossPct \* 100/);
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


test('Pump Observatory escapa nome/símbolo não confiável antes de renderizar HTML', () => {
  const pump = state.pumpObservatory!;
  const maliciousState: DashboardState = {
    ...state,
    pumpObservatory: {
      ...pump,
      recent: [{
        ...pump.recent[0],
        symbol: '<img src=x onerror=alert(1)>',
        name: '<script>alert(1)</script>'
      }]
    }
  };
  const html = renderDashboardHtml(maliciousState);
  assert.doesNotMatch(html, /<img src=x onerror=alert\(1\)>/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});


test('Dashboard expõe Strategy Lab econômico sem promover dados insuficientes', () => {
  const html = renderDashboardHtml({
    ...state,
    pumpStrategyLab: {
      mode: 'SHADOW',
      totalSamples: 40,
      preferredJupiterPlan: 'Developer',
      preferredPlanNetAfterCostSol: 0.275,
      strategies: [{
        cohort: 'BIRTH_0_15S',
        venue: 'JUPITER_ROUTE',
        state: 'PROMISING_SHADOW',
        sampleCount: 40,
        meanNetReturnPct: 4.2,
        executableExitRate: 0.95
      }]
    }
  });

  assert.match(html, /Pump Strategy Lab/);
  assert.match(html, /Developer/);
  assert.match(html, /PROMISING_SHADOW/);
  assert.match(html, /BIRTH_0_15S/);
  assert.match(html, /95\.0%/);
});


test('Strategy Lab possui atualização dinâmica via /api/status', () => {
  const html = renderDashboardHtml(state);
  assert.match(html, /id="pump-strategy-lab-tbody"/);
  assert.match(html, /id="pump-strategy-lab-samples"/);
  assert.match(html, /data\.pumpStrategyLab/);
});
