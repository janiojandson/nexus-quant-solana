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
