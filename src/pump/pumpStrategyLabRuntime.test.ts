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
