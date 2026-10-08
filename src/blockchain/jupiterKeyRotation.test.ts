import test from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import { DexAggregatorService } from './dexAggregator.js';
test('Jupiter comma-separated keys rotate for quote HTTP calls and single key remains fallback', async () => {
  const originalGet = axios.get, oldKeys = process.env.JUPITER_API_KEYS, oldKey = process.env.JUPITER_API_KEY;
  const seen: string[] = [];
  try {
    process.env.JUPITER_API_KEYS = ' first, second, first,  ';
    process.env.JUPITER_API_KEY = 'fallback';
    axios.get = (async (_url: string, options: any) => {
      seen.push(options.headers['x-api-key']);
      return { data: { inAmount: '25000000', outAmount: '100', priceImpactPct: '0.01', slippageBps: 250 } };
    }) as any;
    const dex = new DexAggregatorService('https://fake.invalid', { cacheTtlMs: 0 });
    for (let i = 0; i < 3; i++) await dex.getQuote({ inputMint: 'sol', outputMint: 'token', amountLamports: 25000000 });
    assert.deepEqual(seen, ['first', 'second', 'first']);
    delete process.env.JUPITER_API_KEYS;
    await new DexAggregatorService('https://fake.invalid').getQuote({ inputMint: 'sol', outputMint: 'token', amountLamports: 25000000 });
    assert.equal(seen.at(-1), 'fallback');
  } finally {
    axios.get = originalGet;
    if (oldKeys === undefined) delete process.env.JUPITER_API_KEYS; else process.env.JUPITER_API_KEYS = oldKeys;
    if (oldKey === undefined) delete process.env.JUPITER_API_KEY; else process.env.JUPITER_API_KEY = oldKey;
  }
});

