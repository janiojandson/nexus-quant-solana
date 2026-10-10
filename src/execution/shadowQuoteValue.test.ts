import assert from 'node:assert/strict';
import test from 'node:test';
import { shadowLiquidableValue } from './shadowQuoteValue.js';

const taker = 'wallet';
const quote = { inAmount: 1000, outAmount: 1_400_000_000, requestId: 'q',
  rawQuote: { otherAmountThreshold: '1350000000', feeBps: 100,
    signatureFeeLamports: 5000, signatureFeePayer: taker,
    prioritizationFeeLamports: 10000, prioritizationFeePayer: taker,
    rentFeeLamports: 0, rentFeePayer: taker } };

test('SHADOW liquidable value uses adverse minimum and explicit payer fees, never optimistic output', () => {
  assert.deepEqual(shadowLiquidableValue(quote, 1000, taker), {
    grossLamports: 1_350_000_000, feeLamports: 13_515_000,
    netLamports: 1_336_485_000, expectedOutLamports: 1_400_000_000,
    minimumOutLamports: 1_350_000_000, bpsHaircutLamports: 13_500_000,
    networkFeeLamports: 15_000, rentReserveLamports: 0,
    conservativeNetLamports: 1_336_485_000
  });
});

test('SHADOW refuses missing minimum, fee evidence, wrong amount or no positive net', () => {
  assert.throws(() => shadowLiquidableValue({ ...quote, rawQuote: { ...quote.rawQuote,
    otherAmountThreshold: undefined } }, 1000, taker), /SHADOW_QUOTE_PROOF_UNAVAILABLE/);
  assert.throws(() => shadowLiquidableValue({ ...quote, rawQuote: { ...quote.rawQuote,
    feeBps: undefined } }, 1000, taker), /SHADOW_QUOTE_PROOF_UNAVAILABLE/);
  assert.throws(() => shadowLiquidableValue(quote, 741, taker), /SHADOW_QUOTE_SIZE_MISMATCH/);
  assert.throws(() => shadowLiquidableValue({ ...quote, rawQuote: { ...quote.rawQuote,
    otherAmountThreshold: '1000', signatureFeeLamports: 5000 } }, 1000, taker),
    /SHADOW_QUOTE_NET_NONPOSITIVE/);
});
