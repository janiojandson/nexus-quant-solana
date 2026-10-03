import assert from 'node:assert/strict';
import test from 'node:test';
import { createShadowTrade, recordShadowExitMark } from './pumpShadowTrade.js';

test('mark-only price increase never becomes profit without executable exit', () => {
  const trade = createShadowTrade({
    mint: 'Mint1', cohort: 'BIRTH_0_15S', venue: 'PUMP_DIRECT_MODEL',
    entryAtMs: 1_000, entryPrincipalSol: 1,
    entryFeeBps: 125, entrySlippageBps: 50,
    priorityFeeLamports: 10_000, networkFeeLamports: 5_000
  });
  const mark = recordShadowExitMark(trade, {
    horizon: '15s', observedAtMs: 16_000, grossExitValueSol: 2,
    executable: false, exitFeeBps: 125, exitSlippageBps: 50
  });
  assert.equal(mark.executable, false);
  assert.equal(mark.netPnlSol, undefined);
  assert.equal(mark.netReturnPct, undefined);
});

test('executable shadow exit includes entry and exit fees, slippage and network costs', () => {
  const trade = createShadowTrade({
    mint: 'Mint2', cohort: 'EARLY_1_5M', venue: 'JUPITER_ROUTE',
    entryAtMs: 1_000, entryPrincipalSol: 1,
    entryFeeBps: 125, entrySlippageBps: 50,
    priorityFeeLamports: 100_000, networkFeeLamports: 10_000
  });
  const mark = recordShadowExitMark(trade, {
    horizon: '1m', observedAtMs: 61_000, grossExitValueSol: 1.2,
    executable: true, exitFeeBps: 125, exitSlippageBps: 75
  });
  assert.ok((mark.netPnlSol ?? 1) < 0.20);
  assert.ok((mark.netPnlSol ?? 0) > 0.15);
  assert.equal(trade.exitMarks.length, 1);
});
