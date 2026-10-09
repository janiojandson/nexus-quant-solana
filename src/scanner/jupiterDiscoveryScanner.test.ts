import test from 'node:test';
import assert from 'node:assert/strict';
import { JupiterDiscoveryScanner } from './jupiterDiscoveryScanner.js';

test('TokensV2 direct array id yields real metadata and leaves absent fields unknown', async () => {
  const calls: unknown[] = [];
  const hub = { request: async (...args: unknown[]) => {
    calls.push(args);
    return { status: 200, body: [{
      id: 'Mint111111111111111111111111111111111111111', symbol: 'REAL', name: 'Real Token',
      usdPrice: 0.00125, liquidity: 31250,
      stats5m: { priceChange: 1.2, buyCount: 13, sellCount: 7, buyVolume: 1000, sellVolume: 700 },
      firstPool: { id: 'Pool111111111111111111111111111111111111111', createdAt: '2026-10-09T12:00:00Z' }
    }, { id: 'Mint222222222222222222222222222222222222222' }] };
  }};
  const result = await new JupiterDiscoveryScanner(hub as any).scanTrendingCandidates();
  assert.equal(calls.length, 1);
  assert.equal(result[0]?.mint, 'Mint111111111111111111111111111111111111111');
  assert.equal(result[0]?.priceUsd, 0.00125);
  assert.equal(result[0]?.liquidityUsd, 31250);
  assert.equal(result[0]?.buysM5, 13);
  assert.equal(result[0]?.pairAddress, 'Pool111111111111111111111111111111111111111');
  assert.equal(result[0]?.pairCreatedAt, Date.parse('2026-10-09T12:00:00Z'));
  assert.equal(result[1]?.priceUsd, null);
  assert.equal(result[1]?.liquidityUsd, null);
  assert.equal(result[1]?.pairCreatedAt, null);
  assert.equal(result[1]?.buysM5, null);
});

test('handoff search keeps only exact mint metadata and never adopts another token in results', async () => {
  const hub = { request: async (work: string, endpoint: string, payload: any) => {
    assert.equal(work, 'DISCOVERY'); assert.equal(endpoint, '/tokens/v2/search');
    assert.deepEqual(payload, { query: 'wanted' });
    return { status: 200, body: [
      { id: 'different', usdPrice: 3, liquidity: 90000 },
      { id: 'wanted', symbol: 'W', name: 'Wanted', usdPrice: 0.02,
        liquidity: 25000, firstPool: { id: 'confirmed' } }
    ] };
  }};
  const result = await new JupiterDiscoveryScanner(hub as any).fetchCandidate('wanted');
  assert.equal(result?.mint, 'wanted');
  assert.equal(result?.pairAddress, 'confirmed');
  assert.equal(result?.priceUsd, 0.02);
});
