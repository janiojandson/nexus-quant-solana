import assert from 'node:assert/strict';
import test from 'node:test';
import {
  JupiterTrafficCoordinator
} from './jupiterTrafficCoordinator.js';

test('P1 exit preempts queued P6 research while preserving FIFO within priority', async () => {
  const coordinator = new JupiterTrafficCoordinator({
    generalIntervalMs: 0,
    executeIntervalMs: 0
  });

  const order: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });

  const blocker = coordinator.schedule(6, async () => {
    order.push('blocker-start');
    await gate;
    order.push('blocker-end');
  }, 'general');

  await new Promise(resolve => setImmediate(resolve));

  const lowA = coordinator.schedule(6, async () => {
    order.push('low-a');
  }, 'general');
  const high = coordinator.schedule(1, async () => {
    order.push('stop');
  }, 'general');
  const lowB = coordinator.schedule(6, async () => {
    order.push('low-b');
  }, 'general');

  release();
  await Promise.all([blocker, lowA, high, lowB]);

  assert.deepEqual(order, [
    'blocker-start',
    'blocker-end',
    'stop',
    'low-a',
    'low-b'
  ]);
});

test('general and execute traffic have separate buckets and telemetry', async () => {
  const coordinator = new JupiterTrafficCoordinator({
    generalIntervalMs: 0,
    executeIntervalMs: 0
  });

  await Promise.all([
    coordinator.schedule(4, async () => 'order', 'general'),
    coordinator.schedule(1, async () => 'execute', 'execute')
  ]);

  const snapshot = coordinator.snapshot();
  assert.equal(snapshot.general.completed, 1);
  assert.equal(snapshot.execute.completed, 1);
  assert.equal(snapshot.general.running, 0);
  assert.equal(snapshot.execute.running, 0);
  assert.equal(snapshot.general.queued, 0);
  assert.equal(snapshot.execute.queued, 0);
});
