import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BASELINE_CURRENT,
  PARTIAL_HARVEST_EARLIER,
  TIERED_PROFIT_LOCK,
  replayExitPolicy
} from './exitPolicyReplay.js';

test('replays +370% peak and sharp reversal across policies without assuming a winner', () => {
  const path = [
    { atMs: 0, valueSol: 1 },
    { atMs: 10_000, valueSol: 1.10 },
    { atMs: 20_000, valueSol: 1.40 },
    { atMs: 30_000, valueSol: 2.50 },
    { atMs: 40_000, valueSol: 4.70 },
    { atMs: 50_000, valueSol: 4.00 },
    { atMs: 60_000, valueSol: 2.00 },
    { atMs: 70_000, valueSol: 0.90 }
  ];
  const results = [BASELINE_CURRENT, TIERED_PROFIT_LOCK, PARTIAL_HARVEST_EARLIER]
    .map(policy => replayExitPolicy(path, policy, { feeBps: 125, slippageBps: 100 }));

  for (const result of results) {
    assert.ok(Number.isFinite(result.netReturnPct));
    assert.ok(result.maxGiveBackFromPeakPct >= 0);
    assert.ok(result.realizedSlippageSol >= 0);
  }
  assert.ok(new Set(results.map(x => x.capturedNetSol.toFixed(6))).size > 1);
});

test('replay handles flat/choppy and straight-rising paths', () => {
  const flat = replayExitPolicy([
    { atMs: 0, valueSol: 1 }, { atMs: 10_000, valueSol: 1.03 }, { atMs: 20_000, valueSol: 0.93 }
  ], BASELINE_CURRENT, { feeBps: 0, slippageBps: 0 });
  assert.equal(flat.exitReason, 'STOP_LOSS');

  const rising = replayExitPolicy([
    { atMs: 0, valueSol: 1 }, { atMs: 10_000, valueSol: 1.4 }, { atMs: 20_000, valueSol: 2.0 }
  ], BASELINE_CURRENT, { feeBps: 0, slippageBps: 0 });
  assert.ok(rising.capturedNetSol > 1);
});
