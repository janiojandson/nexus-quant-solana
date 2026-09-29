import test from 'node:test';
import assert from 'node:assert';
import { wilsonCI, meanCI, calculateEV, calculateLift, gateVerdict } from './stats.js';

test('wilsonCI calcula intervalo de confiança corretamente', () => {
  const ci = wilsonCI(50, 100, 0.95);
  assert.strictEqual(ci.point, 0.5);
  assert.ok(ci.lower > 0.39 && ci.lower < 0.41, `lower ${ci.lower} fora do esperado`);
  assert.ok(ci.upper > 0.59 && ci.upper < 0.61, `upper ${ci.upper} fora do esperado`);

  const empty = wilsonCI(0, 0);
  assert.strictEqual(empty.point, 0);
  assert.strictEqual(empty.lower, 0);
  assert.strictEqual(empty.upper, 1);
});

test('meanCI calcula média e intervalo t-Student', () => {
  const data = [10, 12, 14, 16, 18];
  const ci = meanCI(data);
  assert.strictEqual(ci.mean, 14);
  assert.ok(ci.lower < 14);
  assert.ok(ci.upper > 14);

  const empty = meanCI([]);
  assert.strictEqual(empty.mean, 0);
});

test('calculateEV e calculateLift', () => {
  // winRate 60%, win 10%, loss -5%, costs 2.5%
  // EV = 0.6 * 10 - 0.4 * 5 - 2.5 = 6 - 2 - 2.5 = 1.5%
  const ev = calculateEV(0.6, 10, 5, 2.5);
  assert.strictEqual(Math.round(ev * 100) / 100, 1.5);

  const lift = calculateLift(2.5, 0.5);
  assert.strictEqual(lift, 2.0);
});

test('gateVerdict avalia corretamente com N >= 30 e N < 30', () => {
  assert.strictEqual(gateVerdict(3.0, 10, 30), 'INSUFFICIENT_DATA');
  assert.strictEqual(gateVerdict(2.5, 50, 30), 'KEEP');
  assert.strictEqual(gateVerdict(1.0, 50, 30), 'LOOSEN');
  assert.strictEqual(gateVerdict(0.0, 50, 30), 'TIGHTEN');
  assert.strictEqual(gateVerdict(-1.0, 50, 30), 'REMOVE');
});
