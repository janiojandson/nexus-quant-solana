import assert from 'node:assert/strict';
import test from 'node:test';
import type { SwapQuoteParams, SwapQuoteResult } from '../blockchain/dexAggregator.js';
import type { PumpObservatorySnapshot } from './pumpObservatory.js';
import { PumpStrategyLabRuntime } from './pumpStrategyLabRuntime.js';

class FakeProvider {
  calls: SwapQuoteParams[] = [];
  async getQuote(params: SwapQuoteParams): Promise<SwapQuoteResult> {
    this.calls.push(params);
    const isEntry = params.inputMint === 'So11111111111111111111111111111111111111112';
    return {
      inputMint: params.inputMint,
      outputMint: params.outputMint,
      inAmount: params.amountLamports,
      outAmount: isEntry ? 1_000_000 : 1_100_000,
      priceImpactPct: 0.2,
      slippageBps: 250,
      routePlanSummary: 'test',
      router: 'metis'
    };
  }
}

function source(): { snapshot(): PumpObservatorySnapshot } {
  return {
    snapshot: () => ({
      enabled: true,
      running: true,
      readOnly: true,
      totalCreatedObserved: 1,
      activeCurves: 1,
      graduatedCount: 0,
      dexIndexedCount: 0,
      dexReadyCount: 0,
      recent: [{
        mint: 'Mint111',
        symbol: 'TST',
        name: 'Test',
        creator: 'Creator111',
        bondingCurve: 'Curve111',
        slot: 42,
        signature: 'Sig111',
        eventTimestampMs: 0,
        observedAtMs: 1000,
        createToObserverLagMs: 1000,
        initialRealTokenReserves: '1000',
        currentRealTokenReserves: '900',
        progressPct: 10,
        complete: false,
        solscanUrl: 'https://solscan.io/token/Mint111',
        transactionUrl: 'https://solscan.io/tx/Sig111',
        pumpUrl: 'https://pump.fun/coin/Mint111'
      }]
    })
  };
}

test('runtime uses at most one P6 network probe per tick and builds executable shadow evidence', async () => {
  let now = 10_000;
  let healthy = true;
  const provider = new FakeProvider();
  const calls = { obs: 0, shadow: 0, market: 0, summary: 0 };
  const store = {
    appendObservation: async () => { calls.obs++; },
    appendShadowTrade: async () => { calls.shadow++; },
    appendMarketSample: async () => { calls.market++; },
    upsertStrategySummary: async () => { calls.summary++; }
  };

  const runtime = new PumpStrategyLabRuntime(source(), provider, store, {
    now: () => now,
    canRunResearch: () => healthy,
    entryLamports: 1_000_000,
    horizons: [{ label: '15s', ms: 15_000 }]
  });

  await runtime.sample();
  assert.equal(provider.calls.length, 1);
  assert.equal(provider.calls[0].trafficPriority, 6);
  assert.equal(calls.obs, 1);
  assert.equal(calls.shadow, 1);

  now = 25_000;
  await runtime.sample();
  assert.equal(provider.calls.length, 2);
  assert.equal(provider.calls[1].trafficPriority, 6);
  assert.equal(calls.market, 1);

  const snapshot = runtime.snapshot();
  assert.equal(snapshot.totalSamples, 1);
  assert.equal(snapshot.strategies[0].cohort, 'BIRTH_0_15S');
  assert.equal(snapshot.strategies[0].state, 'INSUFFICIENT_DATA');

  healthy = false;
  now = 50_000;
  await runtime.sample();
  assert.equal(provider.calls.length, 2);
});

test('runtime does not probe Jupiter at all while research is suspended', async () => {
  const provider = new FakeProvider();
  const runtime = new PumpStrategyLabRuntime(source(), provider, null, {
    canRunResearch: () => false,
    now: () => 10_000
  });
  await runtime.sample();
  assert.equal(provider.calls.length, 0);
});


test('runtime abre múltiplas janelas para o mesmo mint e separa resumo por horizonte', async () => {
  let now = 10_000;
  const provider = new FakeProvider();
  const shadows: any[] = [];
  const markets: any[] = [];
  const store = {
    appendObservation: async () => {},
    appendShadowTrade: async (record: any) => { shadows.push(record); },
    appendMarketSample: async (record: any) => { markets.push(record); },
    upsertStrategySummary: async () => {}
  };

  const runtime = new PumpStrategyLabRuntime(source(), provider, store, {
    now: () => now,
    entryLamports: 1_000_000,
    horizons: [{ label: '15s', ms: 15_000 }]
  });

  await runtime.sample(); // LAUNCH_0_15S
  now = 25_000;
  await runtime.sample(); // saída 15s do lançamento
  now = 180_000;
  await runtime.sample(); // ENTRY_3M do mesmo mint
  now = 195_000;
  await runtime.sample(); // saída 15s da entrada 3m

  assert.equal(shadows.length, 2);
  assert.equal(shadows[0].payload.entryWindow, 'LAUNCH_0_15S');
  assert.equal(shadows[1].payload.entryWindow, 'ENTRY_3M');
  assert.equal(markets.length, 2);
  assert.equal(markets[0].payload.entryWindow, 'LAUNCH_0_15S');
  assert.equal(markets[1].payload.entryWindow, 'ENTRY_3M');
  assert.ok(Array.isArray(markets[0].payload.exitPolicyReplays));
  assert.ok(markets[0].payload.exitPolicyReplays.some((row: any) => row.policy === 'BASELINE_CURRENT'));
  assert.ok(markets[0].payload.exitPolicyReplays.some((row: any) => row.policy === 'TIERED_PROFIT_LOCK'));

  const snapshot = runtime.snapshot();
  assert.equal(snapshot.totalSamples, 2);
  assert.ok(snapshot.strategies.some(row =>
    row.entryWindow === 'LAUNCH_0_15S' && row.horizon === '15s'
  ));
  assert.ok(snapshot.strategies.some(row =>
    row.entryWindow === 'ENTRY_3M' && row.horizon === '15s'
  ));
});

test('overlapping research cycles keep a single P6 probe in flight', async () => {
  let release!: () => void;
  let started!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { started = resolve; });
  let probeCount = 0;
  const fake = new FakeProvider();
  const provider = {
    async getQuote(params: SwapQuoteParams) {
      probeCount++;
      started();
      await blocked;
      return fake.getQuote(params);
    }
  };
  const runtime = new PumpStrategyLabRuntime(source(), provider, null, { now: () => 10_000 });
  const first = runtime.sample();
  await entered;
  const second = runtime.sample();
  await Promise.resolve();
  await Promise.resolve();
  const overlappingProbes = probeCount;
  release();
  await Promise.all([first, second]);
  assert.equal(overlappingProbes, 1);
  assert.equal(fake.calls.length, 1);
});

test('failed shadow persistence is isolated and the next cycle can recover', async () => {
  let failed = true;
  const provider = new FakeProvider();
  const store = {
    appendObservation: async () => { if (failed) throw new Error('database unavailable'); },
    appendShadowTrade: async () => {},
    appendMarketSample: async () => {},
    upsertStrategySummary: async () => {}
  };
  const runtime = new PumpStrategyLabRuntime(source(), provider, store, { now: () => 10_000 });
  await assert.doesNotReject(runtime.sample());
  assert.equal((runtime.snapshot() as any).lastError, 'SAMPLE_FAILED');
  assert.equal(provider.calls.length, 0);
  failed = false;
  await runtime.sample();
  assert.equal(provider.calls.length, 1);
  assert.equal((runtime.snapshot() as any).lastError, undefined);
});

test('runtime compares all five policies using the configured transaction costs', async () => {
  let now = 10_000;
  const provider = new FakeProvider();
  const markets: any[] = [];
  const runtime = new PumpStrategyLabRuntime(source(), provider, {
    appendObservation: async () => {},
    appendShadowTrade: async () => {},
    appendMarketSample: async record => { markets.push(record); },
    upsertStrategySummary: async () => {}
  }, {
    now: () => now,
    entryLamports: 1_000_000,
    networkFeeLamports: 5_000,
    priorityFeeLamports: 5_000,
    horizons: [{ label: '15s', ms: 15_000 }]
  });
  await runtime.sample();
  now = 25_000;
  await runtime.sample();
  const persisted = markets[0].payload.exitPolicyReplays;
  assert.equal(persisted.length, 5);
  const stop = persisted.find((row: any) => row.policy === 'STOP_ONLY');
  assert.ok(Math.abs(stop.netReturnPct - markets[0].payload.mark.netReturnPct) < 1e-9);
  const summary = runtime.snapshot().strategies[0].exitPolicyReplays;
  assert.equal(summary.length, 5);
  assert.ok(Math.abs(summary.find(row => row.policy === 'STOP_ONLY')!.meanNetReturnPct - 8) < 1e-9);
});

test('an unavailable final exit does not reuse an earlier quote to fabricate a replay', async () => {
  let now = 10_000;
  let exitAvailable = true;
  const fake = new FakeProvider();
  const provider = {
    async getQuote(params: SwapQuoteParams) {
      if (params.inputMint === 'Mint111' && !exitAvailable) throw new Error('no route');
      return fake.getQuote(params);
    }
  };
  const markets: any[] = [];
  const runtime = new PumpStrategyLabRuntime(source(), provider, {
    appendObservation: async () => {},
    appendShadowTrade: async () => {},
    appendMarketSample: async record => { markets.push(record); },
    upsertStrategySummary: async () => {}
  }, { now: () => now, horizons: [{ label: '15s', ms: 15_000 }, { label: '30s', ms: 30_000 }] });
  await runtime.sample();
  now = 25_000;
  await runtime.sample();
  exitAvailable = false;
  now = 40_000;
  await runtime.sample();
  const unavailable = runtime.snapshot().strategies.find(row => row.horizon === '30s')!;
  assert.equal(unavailable.executableExitRate, 0);
  assert.deepEqual(unavailable.exitPolicyReplays, []);
  assert.deepEqual(markets[1].payload.exitPolicyReplays, []);
});

test('entry and exit evidence use quote completion time rather than request start time', async () => {
  let now = 10_000;
  const fake = new FakeProvider();
  const provider = {
    async getQuote(params: SwapQuoteParams) {
      now += 2_000;
      return fake.getQuote(params);
    }
  };
  const shadows: any[] = [];
  const markets: any[] = [];
  const runtime = new PumpStrategyLabRuntime(source(), provider, {
    appendObservation: async () => {},
    appendShadowTrade: async record => { shadows.push(record); },
    appendMarketSample: async record => { markets.push(record); },
    upsertStrategySummary: async () => {}
  }, { now: () => now, horizons: [{ label: '15s', ms: 15_000 }] });
  await runtime.sample();
  assert.equal(shadows[0].entryAtMs, 12_000);
  assert.equal(shadows[0].payload.entryAgeMs, 12_000);
  now = 27_000;
  await runtime.sample();
  assert.equal(markets[0].sampledAtMs, 29_000);
  assert.equal(markets[0].payload.mark.observedAtMs, 29_000);
});

test('a launch quote delayed past its window is discarded instead of mislabeled', async () => {
  let now = 10_000;
  const fake = new FakeProvider();
  const shadows: any[] = [];
  const runtime = new PumpStrategyLabRuntime(source(), {
    async getQuote(params: SwapQuoteParams) {
      now = 180_000;
      return fake.getQuote(params);
    }
  }, {
    appendObservation: async () => {},
    appendShadowTrade: async record => { shadows.push(record); },
    appendMarketSample: async () => {},
    upsertStrategySummary: async () => {}
  }, { now: () => now });
  await runtime.sample();
  assert.equal(shadows.length, 0);
  await runtime.sample();
  assert.equal(shadows.length, 1);
  assert.equal(shadows[0].payload.entryWindow, 'ENTRY_3M');
});

test('a failed market write is retried with one fresh mark rather than losing the horizon', async () => {
  let now = 10_000;
  let failed = true;
  const markets: any[] = [];
  const provider = new FakeProvider();
  const runtime = new PumpStrategyLabRuntime(source(), provider, {
    appendObservation: async () => {},
    appendShadowTrade: async () => {},
    appendMarketSample: async record => {
      if (failed) throw new Error('database unavailable');
      markets.push(record);
    },
    upsertStrategySummary: async () => {}
  }, { now: () => now, horizons: [{ label: '15s', ms: 15_000 }] });
  await runtime.sample();
  now = 25_000;
  await runtime.sample();
  assert.equal((runtime.snapshot() as any).lastError, 'SAMPLE_FAILED');
  failed = false;
  now = 26_000;
  await runtime.sample();
  assert.equal(markets.length, 1);
  assert.equal(provider.calls.length, 3);
  assert.equal(markets[0].sampledAtMs, 26_000);
  assert.equal(runtime.snapshot().strategies[0].sampleCount, 1);
});


test('runtime rebuilds persisted shadows, horizons and policy summaries after restart', async () => {
  let appendedObservations = 0;
  const summaries: any[] = [];
  const trade = {
    mint: 'Mint111',
    cohort: 'BIRTH_0_15S',
    venue: 'JUPITER_ROUTE',
    entryAtMs: 10_000,
    entryPrincipalSol: 0.001,
    entryFeeBps: 0,
    entrySlippageBps: 0,
    priorityFeeLamports: 0,
    networkFeeLamports: 0,
    exitMarks: []
  };
  const mark = {
    horizon: '15s',
    observedAtMs: 25_000,
    grossExitValueSol: 0.0011,
    executable: true,
    exitFeeBps: 0,
    exitSlippageBps: 0,
    priorityFeeLamports: 0,
    networkFeeLamports: 0,
    netPnlSol: 0.0001,
    netReturnPct: 10,
    totalCostSol: 0
  };
  const store = {
    appendObservation: async () => { appendedObservations++; },
    appendShadowTrade: async () => {},
    appendMarketSample: async () => {},
    upsertStrategySummary: async (row: any) => { summaries.push(row); },
    loadRecoveryState: async () => ({
      observations: [{ mint: 'Mint111', signature: 'Sig111', payload: {} }],
      shadowTrades: [{
        mint: 'Mint111',
        cohort: 'BIRTH_0_15S',
        venue: 'JUPITER_ROUTE',
        entryAtMs: 10_000,
        payload: {
          trade,
          entryWindow: 'LAUNCH_0_15S',
          entryAgeMs: 10_000,
          tokenAmountAtomic: 1_000_000
        }
      }],
      marketSamples: [{
        mint: 'Mint111',
        sampledAtMs: 25_000,
        cohort: 'BIRTH_0_15S',
        venue: 'JUPITER_ROUTE',
        payload: { entryWindow: 'LAUNCH_0_15S', mark }
      }]
    })
  };

  const runtime = new PumpStrategyLabRuntime(source(), new FakeProvider(), store, {
    now: () => 25_000,
    horizons: [{ label: '15s', ms: 15_000 }]
  });
  await runtime.restore();

  const snapshot = runtime.snapshot();
  assert.equal(snapshot.totalSamples, 1);
  assert.equal(snapshot.strategies.length, 1);
  assert.equal(snapshot.strategies[0].entryWindow, 'LAUNCH_0_15S');
  assert.equal(snapshot.strategies[0].sampleCount, 1);
  assert.equal(snapshot.strategies[0].exitPolicyReplays.length, 5);
  assert.ok(summaries.length > 0);

  await runtime.sample();
  assert.equal(appendedObservations, 0);
});
