import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluatePumpStrategy } from './pumpStrategyEvaluator.js';

function samples(n: number, netReturnPct: number, executableExit = true) {
  return Array.from({ length: n }, (_, i) => ({
    cohort: 'BIRTH_0_15S' as const,
    venue: 'JUPITER_ROUTE' as const,
    executableEntry: true,
    executableExit,
    netReturnPct,
    entryLatencyMs: 500 + i,
    maxDrawdownPct: 10
  }));
}

test('insufficient samples remain INSUFFICIENT_DATA', () => {
  assert.equal(evaluatePumpStrategy(samples(10, 5)).state, 'INSUFFICIENT_DATA');
});

test('negative net expectancy is rejected even with executable exits', () => {
  assert.equal(evaluatePumpStrategy(samples(40, -1)).state, 'NEGATIVE_EXPECTANCY');
});

test('positive evidence becomes PROMISING_SHADOW before execution-candidate sample gate', () => {
  const result = evaluatePumpStrategy(samples(40, 4));
  assert.equal(result.state, 'PROMISING_SHADOW');
  assert.equal(result.executableExitRate, 1);
});

test('large positive cohort with healthy exitability can become EXECUTION_CANDIDATE', () => {
  const mixed = [
    ...samples(60, 5),
    ...samples(50, 2)
  ];
  const result = evaluatePumpStrategy(mixed);
  assert.equal(result.state, 'EXECUTION_CANDIDATE');
});

test('missing executable exits fails closed despite positive marks', () => {
  const result = evaluatePumpStrategy(samples(110, 20, false));
  assert.equal(result.state, 'NEGATIVE_EXPECTANCY');
});
