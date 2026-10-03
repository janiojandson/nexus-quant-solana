import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateExitCapacity } from './exitCapacityPolicy.js';

test('Free 1 RPS rejects two Jupiter-only positions monitored every 1.5s', () => {
  const result = evaluateExitCapacity({
    generalRps: 1,
    monitorIntervalMs: 1500,
    openPositions: 2,
    hasLocalExitSensor: false
  });

  assert.equal(result.admit, false);
  assert.ok(result.requiredRps > 1);
  assert.equal(result.availableRps, 1);
  assert.match(result.reason || '', /exit protection capacity/i);
});

test('local exit sensor removes high-frequency Jupiter monitoring dependency', () => {
  const result = evaluateExitCapacity({
    generalRps: 1,
    monitorIntervalMs: 1500,
    openPositions: 2,
    hasLocalExitSensor: true
  });

  assert.equal(result.admit, true);
  assert.equal(result.requiredRps, 0);
  assert.equal(result.availableRps, 1);
});
