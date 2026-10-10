import assert from 'node:assert/strict';
import test from 'node:test';
import { commitShadowExitFromQuote } from './shadowExitCommit.js';
const feeProof = (minOut: string) => ({ otherAmountThreshold: minOut, feeBps: 0,
  signatureFeeLamports: 0, prioritizationFeeLamports: 0, rentFeeLamports: 0 });

test('shadow exit commits a quote-only hypothetical fill before changing position state', async () => {
  const order: string[] = [];
  const position = { mint: 'mint', traceId: 'trace', tokenAmount: 1000,
    highestTpStepReached: 0, initialCapitalSol: 1, executablePeakSolValue: 1.35 };
  const result = await commitShadowExitFromQuote({ position, exitTokenAmount: 741,
    monitorQuote: { inAmount: 1000, outAmount: 1_350_000_000, requestId: 'full', priceImpactPct: 0,
      rawQuote: feeProof('1350000000') }, taker: 'wallet',
    quoteAt: 1000, now: () => 1200, getQuote: async () => {
      order.push('quote'); return { inAmount: 741, outAmount: 1_000_350_000,
        requestId: 'partial', priceImpactPct: 0, rawQuote: feeProof('1000350000') };
    }, persist: async fill => { order.push('persist'); assert.equal(fill.grossProceedsSol, 1.00035);
      assert.equal(fill.accountingMode, 'SHADOW'); return { applied: true, position: { tokenAmount: 259,
        highestTpStepReached: 1, remainingCostSol: 0.259 } } as any; },
    apply: () => { order.push('apply'); } });
  assert.deepEqual(order, ['quote', 'persist', 'apply']);
  assert.equal(result.kind, 'COMMITTED');
  if (result.kind === 'COMMITTED') assert.equal(result.fill.applied, true);
});

test('failed shadow persistence never advances local step or tries transport again', async () => {
  let applied = 0;
  await assert.rejects(commitShadowExitFromQuote({ position: { mint: 'mint', traceId: 'trace',
    tokenAmount: 1000, highestTpStepReached: 0 }, exitTokenAmount: 1000,
    monitorQuote: { inAmount: 1000, outAmount: 1_350_000_000,
      requestId: 'full', priceImpactPct: 0, rawQuote: feeProof('1350000000') },
      taker: 'wallet', quoteAt: 1000, now: () => 1200,
    getQuote: async () => { throw new Error('UNEXPECTED_QUOTE'); },
    persist: async () => { throw new Error('DB_DOWN'); }, apply: () => { applied++; } }), /DB_DOWN/);
  assert.equal(applied, 0);
});

test('shadow fill stores minimum output and conservative charge, not expected quote output', async () => {
  let stored: any;
  await commitShadowExitFromQuote({ position: { mint: 'mint', traceId: 'trace', tokenAmount: 1000 },
    exitTokenAmount: 1000, taker: 'wallet',
    monitorQuote: { inAmount: 1000, outAmount: 1_400_000_000, requestId: 'q',
      priceImpactPct: 0, rawQuote: { otherAmountThreshold: '1350000000', feeBps: 100,
        signatureFeeLamports: 5000, signatureFeePayer: 'wallet',
        prioritizationFeeLamports: 10000, prioritizationFeePayer: 'wallet',
        rentFeeLamports: 0 } }, quoteAt: 1000, now: () => 1200,
    getQuote: async () => { throw new Error('NO_SECOND_QUOTE'); },
    persist: async fill => { stored = fill; return { applied: true, position: {} as any }; },
    apply: () => {} });
  assert.equal(stored.grossProceedsSol, 1.35);
  assert.equal(stored.feeSol, 0.013515);
  assert.deepEqual(stored.quoteEvidence, {
    expectedOutLamports: 1_400_000_000, minimumOutLamports: 1_350_000_000,
    bpsHaircutLamports: 13_500_000, networkFeeLamports: 15_000,
    rentReserveLamports: 0, conservativeNetLamports: 1_336_485_000
  });
});

test('TP1 does not mark nominal recovery when fresh exact-size minimum is below initial capital', async () => {
  let persisted = 0;
  const result = await commitShadowExitFromQuote({
    position: { mint: 'mint', traceId: 'trace', tokenAmount: 1000,
      initialCapitalSol: 1, highestTpStepReached: 0 },
    exitTokenAmount: 741, taker: 'wallet',
    monitorQuote: { inAmount: 1000, outAmount: 1_400_000_000,
      priceImpactPct: 0, rawQuote: feeProof('1350000000') },
    quoteAt: 1000, now: () => 1200,
    getQuote: async () => ({ inAmount: 741, outAmount: 1_010_000_000,
      priceImpactPct: 0, rawQuote: feeProof('990000000') }),
    persist: async () => { persisted++; return { applied: true, position: {} as any }; },
    apply: () => {}
  });
  assert.deepEqual(result, { kind: 'HOLD', reason: 'TP1_NOMINAL_RECOVERY_UNPROVEN' });
  assert.equal(persisted, 0);
});

test('missing or stale partial quote is a non-persisting HOLD, not ledger uncertainty', async () => {
  let persisted = 0;
  const input = { position: { mint: 'mint', traceId: 'trace', tokenAmount: 1000,
    initialCapitalSol: 1 }, exitTokenAmount: 741, taker: 'wallet',
    monitorQuote: { inAmount: 1000, outAmount: 1_400_000_000,
      priceImpactPct: 0, rawQuote: feeProof('1350000000') },
    quoteAt: 1000, now: () => 1200,
    persist: async () => { persisted++; return { applied: true, position: {} as any }; },
    apply: () => {} };
  const unavailable = await commitShadowExitFromQuote({ ...input,
    getQuote: async () => { throw new Error('RPS_LIMIT'); } });
  assert.deepEqual(unavailable, { kind: 'HOLD', reason: 'PARTIAL_QUOTE_UNAVAILABLE' });
  const missingProof = await commitShadowExitFromQuote({ ...input,
    getQuote: async () => ({ inAmount: 741, outAmount: 1_100_000_000, priceImpactPct: 0 }) });
  assert.deepEqual(missingProof, { kind: 'HOLD', reason: 'SHADOW_QUOTE_PROOF_UNAVAILABLE' });
  const staleSize = await commitShadowExitFromQuote({ ...input,
    getQuote: async () => ({ inAmount: 740, outAmount: 1_100_000_000,
      priceImpactPct: 0, rawQuote: feeProof('1100000000') }) });
  assert.deepEqual(staleSize, { kind: 'HOLD', reason: 'STALE_OR_INVALID_EXIT_QUOTE' });
  assert.equal(persisted, 0);
});

test('invalid local exit size does not masquerade as uncertain ledger commit', async () => {
  let persisted = 0;
  const result = await commitShadowExitFromQuote({ position: { mint: 'mint', traceId: 'trace',
    tokenAmount: 1000 }, exitTokenAmount: 1001, taker: 'wallet',
    monitorQuote: { inAmount: 1000, outAmount: 1_400_000_000,
      priceImpactPct: 0, rawQuote: feeProof('1350000000') },
    quoteAt: 1000, now: () => 1200,
    getQuote: async () => { throw new Error('SHOULD_NOT_QUOTE'); },
    persist: async () => { persisted++; return { applied: true, position: {} as any }; },
    apply: () => {} });
  assert.deepEqual(result, { kind: 'HOLD', reason: 'INVALID_SHADOW_EXIT' });
  assert.equal(persisted, 0);
});
