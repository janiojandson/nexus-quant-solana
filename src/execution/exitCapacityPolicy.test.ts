import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateExitCapacity } from './exitCapacityPolicy.js';

test('one and two positions fit the protection organization with 20/12 requests per minute reserved', () => {
  const one = evaluateExitCapacity({ generalRps: 1, monitorIntervalMs: 1500,
    openPositions: 1, hasLocalExitSensor: false });
  assert.equal(one.admit, true);
  assert.equal(one.pollIntervalMs, 1500);
  assert.equal(one.requiredRps, 40 / 60);
  assert.equal(one.availableRps, 40 / 60);
  const two = evaluateExitCapacity({ generalRps: 1, monitorIntervalMs: 1500,
    openPositions: 2, hasLocalExitSensor: false });
  assert.equal(two.admit, true);
  assert.equal(two.pollIntervalMs, 2500);
  assert.equal(two.requiredRps, 48 / 60);
  assert.equal(two.availableRps, 48 / 60);
});

test('third open position is rejected even with a local exit sensor', () => {
  const result = evaluateExitCapacity({ generalRps: 100, monitorIntervalMs: 1500,
    openPositions: 3, hasLocalExitSensor: true });
  assert.equal(result.admit, false);
  assert.match(result.reason || '', /maximum.*2/i);
});

test('role capacity fails closed when protection organization has fewer than reserved requests', () => {
  const result = evaluateExitCapacity({ generalRps: 100, monitorIntervalMs: 1500,
    openPositions: 2, hasLocalExitSensor: false, protectionRequestsPerMinute: 50 });
  assert.equal(result.admit, false);
  assert.equal(result.availableRps, 38 / 60);
});
