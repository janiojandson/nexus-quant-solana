import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForSentinelJupiterRoute } from './sentinelJupiterPreflight.js';
test('Sentinel enters immediately on an executable 2.5 percent route without DEX data', async () => {
  const quote = { outAmount: 100, priceImpactPct: 2.5, rawQuote: { priceImpactPct: '.025', routePlan: [{swapInfo:{ammKey:'pool',outputMint:'mint'}}] } };
  const result = await waitForSentinelJupiterRoute('mint', async () => quote as any, () => 0, async () => { throw Error('must not wait'); });
  assert.equal(result?.poolAddress, 'pool');
});
test('Sentinel retries missing routes, high impact and unknown impact every two seconds then expires at 45 seconds', async () => {
  let now = 0, calls = 0; const waits: number[] = [];
  const result = await waitForSentinelJupiterRoute('mint', async () => {
    calls++; return { outAmount: 100, priceImpactPct: calls % 2 ? 3 : 0, rawQuote: {} } as any;
  }, () => now, async ms => { waits.push(ms); now += ms; });
  assert.equal(result, null); assert.equal(now, 45000);
  assert.equal(waits[0], 2000); assert.equal(waits.at(-1), 1000);
});
test('Sentinel never accepts a route returned beyond its preflight deadline', async () => {
  let now = 0;
  const result = await waitForSentinelJupiterRoute('mint', async () => { now = 45001; return { outAmount: 100, priceImpactPct: 1 } as any; }, () => now, async ms => { now += ms; });
  assert.equal(result, null);
});
test('Sentinel deadline aborts an in-flight Jupiter request', async () => {
  let aborted = false;
  const result = await waitForSentinelJupiterRoute('mint', signal => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => { aborted = true; reject(new Error('cancelled')); });
  }), Date.now, ms => new Promise(resolve => setTimeout(resolve, ms)), 20);
  assert.equal(result, null); assert.equal(aborted, true);
});
