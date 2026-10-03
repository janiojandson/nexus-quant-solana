import assert from 'node:assert/strict';
import test from 'node:test';
import { buildWatchdogExitPlan } from './watchdogExitPolicy.js';

test('watchdog emergency reuses safe exit executor with P0 and full atomic lot', () => {
  const plan = buildWatchdogExitPlan({
    entrySol: 0.015,
    tokenAmountAtomic: 123456
  });

  assert.equal(plan.exitReason, 'WATCHDOG_EXIT');
  assert.equal(plan.pnlPct, -0.20);
  assert.ok(plan.exitSolValue > 0);
  assert.equal(plan.options.exitTokenAmount, 123456);
  assert.equal(plan.options.shouldCloseAta, true);
  assert.equal(plan.options.trafficPriority, 0);
  assert.equal(plan.options.initialSlippageBps, 600);
});
