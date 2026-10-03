import assert from 'node:assert/strict';
import test from 'node:test';
import { ExitPathHealth } from './exitPathHealth.js';

test('first exit-route failure degrades entry safety and healthy quote recovers it', () => {
  const health = new ExitPathHealth({ emergencyFailures: 8 });

  health.recordFailure('MintA', 1, 'Jupiter /order unavailable');
  let snapshot = health.snapshot();
  assert.equal(snapshot.state, 'DEGRADED');
  assert.equal(snapshot.canOpenNewPosition, false);
  assert.equal(snapshot.canRunResearch, false);
  assert.deepEqual(snapshot.affectedMints, ['MintA']);
  assert.match(snapshot.reason || '', /Jupiter/);

  health.recordSuccess('MintA');
  snapshot = health.snapshot();
  assert.equal(snapshot.state, 'HEALTHY');
  assert.equal(snapshot.canOpenNewPosition, true);
  assert.equal(snapshot.canRunResearch, true);
  assert.deepEqual(snapshot.affectedMints, []);
});

test('eight consecutive failures escalate to EMERGENCY and one healthy route clears the mint', () => {
  const health = new ExitPathHealth({ emergencyFailures: 8 });

  health.recordFailure('MintA', 8, 'route unavailable');
  const emergency = health.snapshot();
  assert.equal(emergency.state, 'EMERGENCY');
  assert.equal(emergency.maxFailures, 8);

  health.recordSuccess('MintA');
  assert.equal(health.snapshot().state, 'HEALTHY');
});

test('prune removes stale failures for positions that are no longer open', () => {
  const health = new ExitPathHealth({ emergencyFailures: 8 });
  health.recordFailure('ClosedMint', 3, 'route unavailable');
  health.recordFailure('OpenMint', 2, 'route unavailable');

  health.retainOpenPositions(['OpenMint']);

  const snapshot = health.snapshot();
  assert.equal(snapshot.state, 'DEGRADED');
  assert.deepEqual(snapshot.affectedMints, ['OpenMint']);
});
