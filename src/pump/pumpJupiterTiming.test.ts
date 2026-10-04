import assert from 'node:assert/strict';
import test from 'node:test';
import { JupiterQuoteException, type SwapQuoteParams, type SwapQuoteResult } from '../blockchain/dexAggregator.js';
import { PumpJupiterTimingTracker } from './pumpJupiterTiming.js';

class FakeQuoteProvider {
  public calls: SwapQuoteParams[] = [];
  public mode: 'success' | '429' = 'success';

  async getQuote(params: SwapQuoteParams): Promise<SwapQuoteResult> {
    this.calls.push(params);
    if (this.mode === '429') {
      throw new JupiterQuoteException('rate limit', 429);
    }
    return {
      inputMint: params.inputMint,
      outputMint: params.outputMint,
      inAmount: params.amountLamports,
      outAmount: 900_000,
      priceImpactPct: 0.4,
      slippageBps: 250,
      routePlanSummary: 'Pump -> SOL',
      router: 'metis'
    };
  }
}

test('records first Jupiter route latency from canonical Pump birth and always probes at P6', async () => {
  let now = 1_000_000;
  const provider = new FakeQuoteProvider();
  const tracker = new PumpJupiterTimingTracker(provider, { now: () => now });

  now = 1_001_500;
  const sample = await tracker.probe({
    mint: 'Mint111',
    eventTimestampMs: 1_000_000,
    inputMint: 'So11111111111111111111111111111111111111112',
    outputMint: 'Mint111',
    amountLamports: 1_000_000
  });

  assert.equal(provider.calls[0].trafficPriority, 6);
  assert.equal(sample.firstAttemptAtMs, 1_001_500);
  assert.equal(sample.firstRouteAtMs, 1_001_500);
  assert.equal(sample.firstRouteLagMs, 1_500);
  assert.equal(sample.router, 'metis');
  assert.equal(sample.routeAvailable, true);
});

test('counts 429 without inventing a route and preserves later first-route timing', async () => {
  let now = 2_000_000;
  const provider = new FakeQuoteProvider();
  provider.mode = '429';
  const tracker = new PumpJupiterTimingTracker(provider, { now: () => now });

  const failed = await tracker.probe({
    mint: 'Mint222',
    eventTimestampMs: 1_999_000,
    inputMint: 'So11111111111111111111111111111111111111112',
    outputMint: 'Mint222',
    amountLamports: 1_000_000
  });

  assert.equal(failed.rateLimitHits, 1);
  assert.equal(failed.routeAvailable, false);
  assert.equal(failed.firstRouteAtMs, undefined);

  provider.mode = 'success';
  now = 2_002_000;
  const recovered = await tracker.probe({
    mint: 'Mint222',
    eventTimestampMs: 1_999_000,
    inputMint: 'So11111111111111111111111111111111111111112',
    outputMint: 'Mint222',
    amountLamports: 1_000_000
  });

  assert.equal(recovered.attempts, 2);
  assert.equal(recovered.firstRouteLagMs, 3_000);
  assert.equal(recovered.rateLimitHits, 1);
});


test('walks the bankroll ladder across ticks and records the first 750 bps compliant size', async () => {
  let now = 3_000_000;
  const calls: SwapQuoteParams[] = [];
  const tracker = new PumpJupiterTimingTracker({
    async getQuote(params) {
      calls.push(params);
      if (params.amountLamports > 400_000) {
        throw new JupiterQuoteException('Jupiter V2 RTSE excedeu hard-cap: 1000bps > 750bps.');
      }
      return {
        inputMint: params.inputMint,
        outputMint: params.outputMint,
        inAmount: params.amountLamports,
        outAmount: 360_000,
        priceImpactPct: 0.9,
        slippageBps: 700,
        routePlanSummary: 'Pump -> SOL',
        router: 'metis'
      };
    }
  }, { now: () => now });

  const input = {
    mint: 'Mint333',
    eventTimestampMs: 3_000_000,
    inputMint: 'So11111111111111111111111111111111111111112',
    outputMint: 'Mint333',
    amountLamports: 1_000_000,
    amountLadderLamports: [1_000_000, 700_000, 400_000, 200_000],
    probeSeriesKey: 'Mint333:LAUNCH_0_15S'
  };
  await tracker.probe(input);
  now += 5_000;
  await tracker.probe(input);
  now += 5_000;
  const routed = await tracker.probe(input);

  assert.deepEqual(calls.map(call => call.amountLamports), [1_000_000, 700_000, 400_000]);
  assert.ok(calls.every(call => call.maxAutoSlippageBps === 750));
  assert.equal(routed.firstRouteAmountLamports, 400_000);
  assert.equal(routed.firstRouteLadderIndex, 2);
  assert.equal(routed.firstCompliantRouteLagMs, 10_000);
  assert.equal(routed.firstRouteSlippageBps, 700);
});

test('summarizes real moment-zero feasibility without treating an unavailable route as an entry', async () => {
  const module = await import('./pumpJupiterTiming.js');
  const summary = module.summarizePumpJupiterTiming([
    {
      mint: 'fast',
      attempts: 1,
      rateLimitHits: 0,
      routeAvailable: true,
      firstRouteAtMs: 10_000,
      firstRouteLagMs: 8_000,
      firstCompliantRouteLagMs: 8_000,
      firstRouteAmountLamports: 1_000_000,
      firstRouteSlippageBps: 500
    },
    {
      mint: 'slow',
      attempts: 4,
      rateLimitHits: 0,
      routeAvailable: true,
      firstRouteAtMs: 40_000,
      firstRouteLagMs: 35_000,
      firstCompliantRouteLagMs: 35_000,
      firstRouteAmountLamports: 400_000,
      firstRouteSlippageBps: 750
    },
    {
      mint: 'blocked',
      attempts: 5,
      rateLimitHits: 0,
      routeAvailable: false,
      lastFailureReason: 'SLIPPAGE_ABOVE_CAP'
    }
  ]);

  assert.equal(summary.probedMints, 3);
  assert.equal(summary.compliantRouteMints, 2);
  assert.equal(summary.momentZeroMints, 1);
  assert.equal(summary.momentZeroRate, 1 / 3);
  assert.equal(summary.medianFirstCompliantRouteLagMs, 8_000);
  assert.equal(summary.p90FirstCompliantRouteLagMs, 35_000);
  assert.equal(summary.smallestFirstExecutableAmountLamports, 400_000);
});
