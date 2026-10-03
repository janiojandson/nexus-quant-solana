import assert from 'node:assert/strict';
import test from 'node:test';
import * as policies from './exitPolicyReplay.js';
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

test('replay deducts entry costs once and fixed transaction costs on every sale', () => {
  const costs = { feeBps: 0, slippageBps: 0, entryCostSol: 0.01, exitCostSol: 0.01 };
  const flat = replayExitPolicy([
    { atMs: 0, valueSol: 1 }, { atMs: 10_000, valueSol: 1 }
  ], BASELINE_CURRENT, costs);
  assert.ok(Math.abs(flat.netReturnPct - (-2)) < 1e-9);

  const partialAndRunner = replayExitPolicy([
    { atMs: 0, valueSol: 1 }, { atMs: 10_000, valueSol: 1.4 }, { atMs: 20_000, valueSol: 1.8 }
  ], BASELINE_CURRENT, costs);
  assert.ok(Math.abs(partialAndRunner.netReturnPct - 57) < 1e-9);
});

test('lab compares STOP alone and a full runner alongside the three existing policies', () => {
  const comparison = (policies as any).SHADOW_EXIT_POLICIES as Array<any> | undefined;
  assert.ok(comparison, 'The lab needs one shared comparison policy list.');
  assert.deepEqual(comparison.map(policy => policy.name).sort(), [
    'BASELINE_CURRENT', 'PARTIAL_HARVEST_EARLIER', 'RUNNER_ONLY', 'STOP_ONLY', 'TIERED_PROFIT_LOCK'
  ]);
  const path = [
    { atMs: 0, valueSol: 1 },
    { atMs: 10_000, valueSol: 1.4 },
    { atMs: 20_000, valueSol: 1.8 },
    { atMs: 30_000, valueSol: 1.6 },
    { atMs: 40_000, valueSol: 4 }
  ];
  const results = comparison.map(policy => replayExitPolicy(path, policy, { feeBps: 0, slippageBps: 0 }));
  const stop = results.find(row => row.policy === 'STOP_ONLY')!;
  const runner = results.find(row => row.policy === 'RUNNER_ONLY')!;
  assert.equal(stop.netReturnPct, 300);
  assert.equal(stop.exitReason, 'END_OF_PATH');
  assert.ok(Math.abs(runner.netReturnPct - 60) < 1e-9);
  assert.equal(runner.exitReason, 'TRAILING_STOP');
  assert.equal(runner.prematureExit, true);
});

test('profit-lock tiers act before the baseline runner on +100%, +200% and +300% reversals', () => {
  for (const { peak, reversal } of [
    { peak: 2, reversal: 1.83 },
    { peak: 3, reversal: 2.79 },
    { peak: 4, reversal: 3.69 }
  ]) {
    const path = [
      { atMs: 0, valueSol: 1 },
      { atMs: 10_000, valueSol: peak },
      { atMs: 20_000, valueSol: reversal },
      { atMs: 30_000, valueSol: peak * 0.9 - 0.01 }
    ];
    const baseline = replayExitPolicy(path, BASELINE_CURRENT, { feeBps: 125, slippageBps: 100 });
    const locked = replayExitPolicy(path, TIERED_PROFIT_LOCK, { feeBps: 125, slippageBps: 100 });
    assert.equal(locked.exitReason, 'PROFIT_LOCK');
    assert.equal(locked.exitAtMs, 20_000);
    assert.equal(baseline.exitAtMs, 30_000);
    assert.ok(locked.capturedNetSol > baseline.capturedNetSol);
  }
});
