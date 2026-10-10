import assert from 'node:assert/strict';
import test from 'node:test';
import { commitShadowExitFromQuote } from './shadowExitCommit.js';

test('shadow exit commits a quote-only hypothetical fill before changing position state', async () => {
  const order: string[] = [];
  const position = { mint: 'mint', traceId: 'trace', tokenAmount: 1000,
    highestTpStepReached: 0, executablePeakSolValue: 1.35 };
  const result = await commitShadowExitFromQuote({ position, exitTokenAmount: 741,
    monitorQuote: { inAmount: 1000, outAmount: 1_350_000_000, requestId: 'full', priceImpactPct: 0 },
    quoteAt: 1000, now: () => 1200, getQuote: async () => {
      order.push('quote'); return { inAmount: 741, outAmount: 1_000_350_000,
        requestId: 'partial', priceImpactPct: 0 };
    }, persist: async fill => { order.push('persist'); assert.equal(fill.grossProceedsSol, 1.00035);
      assert.equal(fill.accountingMode, 'SHADOW'); return { applied: true, position: { tokenAmount: 259,
        highestTpStepReached: 1, remainingCostSol: 0.259 } } as any; },
    apply: () => { order.push('apply'); } });
  assert.deepEqual(order, ['quote', 'persist', 'apply']);
  assert.equal(result.applied, true);
});

test('failed shadow persistence never advances local step or tries transport again', async () => {
  let applied = 0;
  await assert.rejects(commitShadowExitFromQuote({ position: { mint: 'mint', traceId: 'trace',
    tokenAmount: 1000, highestTpStepReached: 0 }, exitTokenAmount: 1000,
    monitorQuote: { inAmount: 1000, outAmount: 1_350_000_000,
      requestId: 'full', priceImpactPct: 0 }, quoteAt: 1000, now: () => 1200,
    getQuote: async () => { throw new Error('UNEXPECTED_QUOTE'); },
    persist: async () => { throw new Error('DB_DOWN'); }, apply: () => { applied++; } }), /DB_DOWN/);
  assert.equal(applied, 0);
});
