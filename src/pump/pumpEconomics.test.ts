import assert from 'node:assert/strict';
import test from 'node:test';
import {
  calculateNetTradeEconomics,
  PUMP_BONDING_CURVE_TOTAL_FEE_BPS,
  resolveTieredFeeBps
} from './pumpEconomics.js';

test('bonding curve round-trip accounts for 1.25% fee on entry and exit plus slippage/network costs', () => {
  const result = calculateNetTradeEconomics({
    entryPrincipalSol: 1,
    grossExitValueSol: 1.20,
    entryFeeBps: PUMP_BONDING_CURVE_TOTAL_FEE_BPS,
    exitFeeBps: PUMP_BONDING_CURVE_TOTAL_FEE_BPS,
    entrySlippageBps: 50,
    exitSlippageBps: 75,
    priorityFeeLamports: 100_000,
    networkFeeLamports: 10_000
  });

  assert.equal(PUMP_BONDING_CURVE_TOTAL_FEE_BPS, 125);
  assert.ok(result.totalCostSol > 0.037);
  assert.ok(result.netPnlSol < 0.20);
  assert.ok(result.netPnlSol > 0.15);
  assert.ok(result.netReturnPct > 15 && result.netReturnPct < 20);
});

test('tiered fee resolver selects PumpSwap-style market-cap bands', () => {
  const tiers = [
    { maxExclusive: 420, feeBps: 125 },
    { maxExclusive: 1470, feeBps: 120 },
    { maxExclusive: Number.POSITIVE_INFINITY, feeBps: 30 }
  ];

  assert.equal(resolveTieredFeeBps(100, tiers), 125);
  assert.equal(resolveTieredFeeBps(1000, tiers), 120);
  assert.equal(resolveTieredFeeBps(100_000, tiers), 30);
});

test('fixed plan allocation is included in net economics', () => {
  const result = calculateNetTradeEconomics({
    entryPrincipalSol: 0.5,
    grossExitValueSol: 0.55,
    entryFeeBps: 0,
    exitFeeBps: 0,
    entrySlippageBps: 0,
    exitSlippageBps: 0,
    priorityFeeLamports: 0,
    networkFeeLamports: 0,
    fixedPlanAllocationSol: 0.01
  });

  assert.equal(result.totalCostSol, 0.01);
  assert.ok(Math.abs(result.netPnlSol - 0.04) < 1e-12);
});


test('current PumpSwap SOL fee schedule matches documented market-cap bands', async () => {
  const economics = await import('./pumpEconomics.js');
  assert.equal(economics.resolveCurrentPumpSwapSolFeeBps(100), 125);
  assert.equal(economics.resolveCurrentPumpSwapSolFeeBps(500), 120);
  assert.equal(economics.resolveCurrentPumpSwapSolFeeBps(10_000), 95);
  assert.equal(economics.resolveCurrentPumpSwapSolFeeBps(100_000), 30);
});
