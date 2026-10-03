import assert from 'node:assert/strict';
import test from 'node:test';
import { quotePumpBondingCurveSell } from './pumpSellQuote.js';

test('quotes canonical constant-product Pump sell with ceiling-rounded fee and min-out', () => {
  const quote = quotePumpBondingCurveSell({
    tokenAmountAtomic: 100_000_000_000n,
    virtualTokenReserves: 1_073_000_000_000_000n,
    virtualSolReserves: 30_000_000_000n,
    totalFeeBps: 125,
    slippageBps: 500
  });

  assert.equal(quote.grossSolLamports, 2_795_638n);
  assert.equal(quote.feeLamports, 34_946n);
  assert.equal(quote.netSolLamports, 2_760_692n);
  assert.equal(quote.minSolOutputLamports, 2_622_657n);
});

test('quote rejects zero amounts, invalid reserves and unsafe slippage', () => {
  assert.throws(() => quotePumpBondingCurveSell({
    tokenAmountAtomic: 0n,
    virtualTokenReserves: 1n,
    virtualSolReserves: 1n,
    totalFeeBps: 125,
    slippageBps: 500
  }), /token amount/i);

  assert.throws(() => quotePumpBondingCurveSell({
    tokenAmountAtomic: 1n,
    virtualTokenReserves: 0n,
    virtualSolReserves: 1n,
    totalFeeBps: 125,
    slippageBps: 500
  }), /reserves/i);

  assert.throws(() => quotePumpBondingCurveSell({
    tokenAmountAtomic: 1n,
    virtualTokenReserves: 1n,
    virtualSolReserves: 1n,
    totalFeeBps: 125,
    slippageBps: 751
  }), /slippage/i);
});

test('dust output fails closed when fees consume the gross quote', () => {
  assert.throws(() => quotePumpBondingCurveSell({
    tokenAmountAtomic: 1n,
    virtualTokenReserves: 10_000_000_000n,
    virtualSolReserves: 1n,
    totalFeeBps: 125,
    slippageBps: 100
  }), /zero/i);
});
