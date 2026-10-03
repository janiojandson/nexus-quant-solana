import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PumpDexTimingTracker,
  selectBestDexPairForMint,
  type PumpDexCorrelationTarget
} from './pumpDexTiming.js';

const MINT_A = 'MintA1111111111111111111111111111111111111';
const MINT_B = 'MintB2222222222222222222222222222222222222';

test('selects the matching Solana pair with the highest available liquidity', () => {
  const pair = selectBestDexPairForMint(MINT_A, [
    {
      chainId: 'solana',
      pairAddress: 'PairLow',
      baseToken: { address: MINT_A },
      priceUsd: '0.01',
      liquidity: { usd: 1000 },
      pairCreatedAt: 1_000
    },
    {
      chainId: 'solana',
      pairAddress: 'PairHigh',
      baseToken: { address: MINT_A },
      priceUsd: '0.02',
      liquidity: { usd: 9000 },
      pairCreatedAt: 2_000
    },
    {
      chainId: 'ethereum',
      pairAddress: 'WrongChain',
      baseToken: { address: MINT_A },
      priceUsd: '1',
      liquidity: { usd: 999999 }
    }
  ] as any);

  assert.equal(pair?.pairAddress, 'PairHigh');
});

test('batch tracker measures Pump birth to Dex first-seen and ready time in one request', async () => {
  const applied: Array<{ mint: string; sample: any }> = [];
  const target: PumpDexCorrelationTarget = {
    getDexCorrelationCandidates(limit) {
      assert.equal(limit, 30);
      return [
        { mint: MINT_A, eventTimestampMs: 1_000_000 },
        { mint: MINT_B, eventTimestampMs: 1_001_000 }
      ];
    },
    applyDexCorrelation(mint, sample) {
      applied.push({ mint, sample });
    }
  };

  const urls: string[] = [];
  const tracker = new PumpDexTimingTracker(target, {
    now: () => 1_010_000,
    fetchJson: async (url) => {
      urls.push(url);
      return [
        {
          chainId: 'solana',
          pairAddress: 'PairA',
          baseToken: { address: MINT_A },
          priceUsd: '0.0001',
          liquidity: { usd: 25_000 },
          pairCreatedAt: 1_005_000
        },
        {
          chainId: 'solana',
          pairAddress: 'PairB',
          baseToken: { address: MINT_B },
          priceUsd: null,
          liquidity: { usd: 0 },
          pairCreatedAt: 1_007_000
        }
      ];
    }
  });

  await tracker.sample();

  assert.equal(urls.length, 1);
  assert.match(urls[0], /tokens\/v1\/solana\//);
  assert.match(urls[0], new RegExp(MINT_A));
  assert.match(urls[0], new RegExp(MINT_B));
  assert.equal(applied.length, 2);

  const a = applied.find(x => x.mint === MINT_A)!.sample;
  assert.equal(a.observedAtMs, 1_010_000);
  assert.equal(a.ready, true);
  assert.equal(a.pairCreatedAtMs, 1_005_000);
  assert.equal(a.liquidityUsd, 25_000);
  assert.equal(a.priceUsd, 0.0001);

  const b = applied.find(x => x.mint === MINT_B)!.sample;
  assert.equal(b.ready, false);
  assert.equal(b.pairCreatedAtMs, 1_007_000);
});

test('tracker fails open for observability when DexScreener is unavailable', async () => {
  let applyCalled = false;
  const target: PumpDexCorrelationTarget = {
    getDexCorrelationCandidates() {
      return [{ mint: MINT_A, eventTimestampMs: 1_000_000 }];
    },
    applyDexCorrelation() {
      applyCalled = true;
    }
  };
  const tracker = new PumpDexTimingTracker(target, {
    fetchJson: async () => {
      throw new Error('429 rate limit');
    }
  });

  await assert.doesNotReject(() => tracker.sample());
  assert.equal(applyCalled, false);
  assert.match(tracker.snapshot().lastError || '', /429/);
});
