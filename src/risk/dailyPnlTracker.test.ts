import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DailyPnlTracker } from './dailyPnlTracker.js';

test('daily PnL tracker records losses without creating an entry block', () => {
  const now = Date.parse('2026-10-03T12:00:00Z');
  const tracker = new DailyPnlTracker(now);
  tracker.recordTradeResult(-0.20, now);
  assert.deepEqual(tracker.getState(now), {
    tier: 'ACTIVE_NO_DAILY_LIMIT',
    dailyPnlSol: -0.20,
    dailyTradeCount: 1,
    pausedUntil: null,
    lastResetDate: '2026-10-03'
  });
});

test('daily PnL telemetry resets at the UTC day boundary', () => {
  const start = Date.parse('2026-10-03T23:59:00Z');
  const tracker = new DailyPnlTracker(start);
  tracker.recordTradeResult(0.01, start);
  const nextDay = Date.parse('2026-10-04T00:01:00Z');
  assert.equal(tracker.getState(nextDay).dailyPnlSol, 0);
  assert.equal(tracker.getState(nextDay).dailyTradeCount, 0);
});
