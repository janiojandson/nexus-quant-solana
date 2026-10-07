import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { scheduleEntryAdvisory } from './entryAdvisory.js';
import axios from 'axios';
import { MemeRiskGatekeeper } from '../risk/memeRiskGatekeeper.js';

// Execute the actual handlers without importing index.ts and starting production services.
const source = ts.createSourceFile('index.ts', readFileSync(join(__dirname, '../index.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
function loadHandler(name: string, dependencies: Record<string, unknown>) {
  const nodes = source.statements.filter(node =>
    ts.isFunctionDeclaration(node) ? node.name?.text === name :
      ts.isVariableStatement(node) && node.declarationList.declarations.some(d =>
        ts.isIdentifier(d.name) && (d.name.text.startsWith('SENTINEL_') || ['SOL_MINT_GLOBAL', 'sentinelActiveGraduations'].includes(d.name.text) ||
          (dependencies.MemeRiskGatekeeper && ['gatekeeper', 'dexEntryGatekeeper', 'entryGatekeeper'].includes(d.name.text)))));
  const js = ts.transpileModule(nodes.map(n => n.getText(source)).join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText;
  return vm.runInNewContext(`${js}\n${name};`, {
    latestState: { sentinelHandoffQueue: 0 },
    console: { log() {}, warn() {}, error(e: unknown) { throw new Error(String(e)); } },
    ...dependencies
  }) as (...args: any[]) => Promise<void>;
}

test('Sentinel queue tracks overlapping handlers and clears on expiry', async () => {
  let now = 0;
  const latestState = { sentinelHandoffQueue: 0 };
  const releases: Array<() => void> = [];
  const handler = loadHandler('handleSentinelGraduationDip', {
    latestState, Date: { now: () => now }, setTimeout: (resolve: () => void) => releases.push(resolve),
    antiSpamMemory: { shouldSkip: () => ({ skip: false }) },
    scanner: { fetchCurrentTokenMarketSnapshot: async () => { throw new Error('upstream failed'); } },
    console: { log() {}, warn() {}, error() {} }
  });
  const first = handler({ mint: 'one', symbol: 'ONE', createdAt: new Date(0) });
  const second = handler({ mint: 'two', symbol: 'TWO', createdAt: new Date(0) });
  assert.equal(latestState.sentinelHandoffQueue, 2);
  await handler({ mint: 'one', symbol: 'ONE', createdAt: new Date() });
  assert.equal(latestState.sentinelHandoffQueue, 2);
  now = 91_000;
  releases[0](); await first;
  assert.equal(latestState.sentinelHandoffQueue, 1);
  releases[1](); await second;
  assert.equal(latestState.sentinelHandoffQueue, 0);
});

function dipHarness(options: { liquidity?: number; now?: number; score?: number | null; refreshLiquidity?: number; refreshFails?: boolean } = {}) {
  let now = options.now ?? 3_000;
  const waits: number[] = [], executions: any[] = [], discards: string[] = [];
  let snapshots = 0, quotes = 0;
  const handler = loadHandler('handleSentinelGraduationDip', {
    Date: { now: () => now },
    setTimeout: (resolve: () => void, ms: number) => { waits.push(ms); now += ms; resolve(); },
    antiSpamMemory: { shouldSkip: () => ({ skip: false }), recordTechnicalDiscard: (_mint: string, reason: string) => discards.push(reason) },
    scanner: { fetchCurrentTokenMarketSnapshot: async () => {
      snapshots++;
      if (snapshots > 1 && options.refreshFails) throw new Error('DEX unavailable');
      return { symbol: 'BLANK', liquidityUsd: snapshots > 1 ? (options.refreshLiquidity ?? options.liquidity ?? 562_491) : (options.liquidity ?? 562_491), priceUsd: 1, volume5mUsd: 1000, buysM5: 50, sellsM5: 20, pairAddress: 'pair', dexId: 'raydium' };
    } },
    jupiterEngine: { getQuote: async () => { quotes++; return { outAmount: 100, rawQuote: { routePlan: [] } }; } },
    referencesProgram: () => false, PUMP_PROGRAM_ID: { toBase58: () => 'bonding-curve' },
    priorityForJupiterWork: (p: string) => p,
    executeSentinelEntryCandidate: async (candidate: any) => executions.push({ at: now, candidate })
  });
  return { run: () => handler({ mint: 'mint', symbol: 'BLANK', createdAt: new Date(0), layaScore: options.score ?? null }), waits, executions, discards, state: () => ({ snapshots, quotes }) };
}

test('BLANK: confirmed route and robust liquidity enter at six seconds without maturity wait', async () => {
  const h = dipHarness(); await h.run();
  assert.equal(h.executions.length, 1);
  assert.equal(h.executions[0].at, 6_000);
  assert.deepEqual(h.waits, [3_000]);
});

test('Sentinel composes real deterministic audit without waiting for native shadow enabled by environment', async () => {
  const originalGet = axios.get, originalShadow = process.env.SOLANA_LAYA_SHADOW_ENABLED;
  let completed = false, nativeCalls = 0;
  try {
    process.env.SOLANA_LAYA_SHADOW_ENABLED = 'true';
    axios.get = (async () => ({ data: { is_circuit_breaker_active: false, regime: 'NEUTRAL_RANGING' } })) as any;
    class ControlledGatekeeper extends MemeRiskGatekeeper {
      constructor(config: any) {
        super({ ...config,
          rugCheckService: { auditToken: async () => ({ mint: 'mint', score: 100, risks: [], isRugged: false, isSafe: true, verified: true, mintAuthority: null, freezeAuthority: null, holdersCount: 500, factsComplete: true, lpLockedPct: 100, topHoldersPct: 10 }) } as any,
          solanaLayaAdapter: { evaluate: () => { nativeCalls++; return new Promise(() => {}); } } as any
        });
      }
    }
    const handler = loadHandler('executeSentinelEntryCandidate', {
      MemeRiskGatekeeper: ControlledGatekeeper, MACRO_SENTINEL_URL: 'https://fake.invalid',
      executionUncertainReason: null, MAX_CONCURRENT_POSITIONS: 2,
      positionEngine: { getAllPositions: () => [] }, latestState: { circuitBreakerActive: false },
      wallet: { getBalanceSol: async () => 1 },
      buildEquitySizingPolicy: () => ({ canOpenNextPosition: true, ladderSol: [0.01] }),
      ENTRY_EQUITY_PCT: 0.1, MAX_TOTAL_ALLOCATION_PCT: 0.2, BUY_AMOUNT_SOL: 0.025,
      MAX_TOTAL_ALLOCATION_SOL: 0.1, GAS_RESERVE_EQUITY_PCT: 0.1, MIN_GAS_RESERVE_SOL: 0.01, MAX_GAS_RESERVE_SOL: 0.05,
      SOLANA_LAYA_TACTICAL_MODE: 'LIVE', process, scheduleEntryAdvisory,
      solanaLayaAdapter: { evaluateEntry: () => new Promise(() => {}) },
      antiSpamMemory: { recordTechnicalDiscard() {} }, priorityForJupiterWork: (p: string) => p,
      adaptiveSizer: { findExecutableSize: async () => ({ success: false, error: 'stop before sending' }) }
    });
    void handler({ mint: 'mint', symbol: 'BLANK', liquidityUsd: 562_491 }, { layaScore: null }).then(() => { completed = true; });
    for (let i = 0; i < 40; i++) await Promise.resolve();
    assert.equal(completed, true);
    assert.equal(nativeCalls, 0);
  } finally {
    axios.get = originalGet;
    if (originalShadow === undefined) delete process.env.SOLANA_LAYA_SHADOW_ENABLED;
    else process.env.SOLANA_LAYA_SHADOW_ENABLED = originalShadow;
  }
});

test('liquidity below 25k waits for maturity and refreshes market and route before entry', async () => {
  const h = dipHarness({ liquidity: 24_999, refreshLiquidity: 20_000 }); await h.run();
  assert.equal(h.executions.length, 1);
  assert.ok(h.waits.includes(39_000));
  assert.ok(h.executions[0].at >= 45_000);
  assert.equal(h.executions[0].candidate.liquidityUsd, 20_000);
  assert.ok(h.state().quotes >= 2);
});

test('25k liquidity includes the immediate-entry threshold', async () => {
  const h = dipHarness({ liquidity: 25_000 }); await h.run();
  assert.equal(h.executions[0]?.at, 6_000);
});

test('maturity wait cannot reuse a snapshot when refreshed DEX requests fail', async () => {
  const h = dipHarness({ liquidity: 20_000, refreshFails: true }); await h.run();
  assert.equal(h.executions.length, 0);
});

test('robust liquidity never bypasses the maximum dip age', async () => {
  const h = dipHarness({ now: 88_000 }); await h.run();
  assert.equal(h.executions.length, 0);
});

test('45 and 90 seconds are inclusive maturity boundaries', async () => {
  for (const now of [42_000, 87_000]) {
    const h = dipHarness({ now, liquidity: 20_000 }); await h.run();
    assert.equal(h.executions.length, 1);
  }
});

test('low upstream Laya score is advisory and cannot discard the handoff', async () => {
  const h = dipHarness({ score: 2 }); await h.run();
  assert.equal(h.executions.length, 1);
  assert.deepEqual(h.discards, []);
});

test('null-score Sentinel entries reach sizing despite LIVE Laya veto, abstention, failure or pending response', async () => {
  for (const evaluate of [
    async () => ({ action: 'REJECT', score: 0 }),
    async () => ({ action: 'ABSTAIN', score: 0 }),
    async () => { throw new Error('timeout'); },
    () => new Promise(() => {})
  ]) {
    let sizingCalls = 0;
    const vetoes: string[] = [];
    const handler = loadHandler('executeSentinelEntryCandidate', {
      executionUncertainReason: null, MAX_CONCURRENT_POSITIONS: 2,
      positionEngine: { getAllPositions: () => [] }, latestState: { circuitBreakerActive: false },
      entryGatekeeper: { auditToken: async () => ({ safe: true, score: 90, layaFacts: {} }) },
      wallet: { getBalanceSol: async () => 1 },
      buildEquitySizingPolicy: () => ({ canOpenNextPosition: true, ladderSol: [0.01] }),
      ENTRY_EQUITY_PCT: 0.1, MAX_TOTAL_ALLOCATION_PCT: 0.2, BUY_AMOUNT_SOL: 0.025,
      MAX_TOTAL_ALLOCATION_SOL: 0.1, GAS_RESERVE_EQUITY_PCT: 0.1, MIN_GAS_RESERVE_SOL: 0.01, MAX_GAS_RESERVE_SOL: 0.05,
      SOLANA_LAYA_TACTICAL_MODE: 'LIVE', process: { env: {} }, scheduleEntryAdvisory,
      solanaLayaAdapter: { evaluateEntry: evaluate },
      shouldBlockSolanaEntryFromLaya: () => ({ blocked: true, score: 0 }),
      antiSpamMemory: { recordVeto: (_mint: string, reason: string) => vetoes.push(reason), recordTechnicalDiscard() {} },
      priorityForJupiterWork: (p: string) => p,
      adaptiveSizer: { findExecutableSize: async () => { sizingCalls++; return { success: false, error: 'test stops before execution' }; } }
    });
    // Bounded microtask flush: a pending Laya request must not hold the financial path.
    let completed = false;
    const running = handler({ mint: 'mint', symbol: 'BLANK', liquidityUsd: 562_491 }, { layaScore: null }).then(() => { completed = true; });
    for (let i = 0; i < 30; i++) await Promise.resolve();
    assert.equal(sizingCalls, 1);
    assert.equal(completed, true);
    assert.deepEqual(vetoes, []);
    await running;
  }
});
