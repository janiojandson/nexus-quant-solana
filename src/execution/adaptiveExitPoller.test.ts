import assert from 'node:assert/strict';
import test from 'node:test';
import { AdaptiveExitPoller } from './adaptiveExitPoller.js';

test('fake clock produces 40 one-position or 48 staggered two-position checks per minute', async () => {
  let now = 0;
  const checks: Array<[string, number]> = [];
  const poller = new AdaptiveExitPoller(() => now, async mint => { checks.push([mint, now]); });
  for (now = 0; now < 60_000; now += 250) {
    poller.tick(['A']); await Promise.resolve();
  }
  assert.equal(checks.length, 40);
  checks.length = 0; poller.reset();
  for (now = 0; now < 60_000; now += 250) {
    poller.tick(['A', 'B']); await Promise.resolve();
  }
  assert.equal(checks.length, 48);
  assert.equal(checks.filter(([mint]) => mint === 'A').length, 24);
  assert.equal(checks.filter(([mint]) => mint === 'B').length, 24);
  assert.equal(checks[1][1] - checks[0][1], 1250);
});

test('a slow position never blocks another and per-position in-flight checks stay bounded', async () => {
  let now = 0;
  let releaseA!: () => void;
  const seen: string[] = [];
  const poller = new AdaptiveExitPoller(() => now, mint => {
    seen.push(mint);
    if (mint === 'A') return new Promise<void>(resolve => { releaseA = resolve; });
    return Promise.resolve();
  });
  for (now = 0; now < 6_000; now += 250) { poller.tick(['A', 'B']); await Promise.resolve(); }
  assert.equal(seen.filter(mint => mint === 'A').length, 1);
  assert.ok(seen.filter(mint => mint === 'B').length >= 2);
  releaseA(); await Promise.resolve();
});
