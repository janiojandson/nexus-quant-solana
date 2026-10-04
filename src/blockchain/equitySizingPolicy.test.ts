import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildEquitySizingPolicy } from './equitySizingPolicy.js';

test('equity sizing derives the first stake from the whole bankroll', () => {
  const policy = buildEquitySizingPolicy({
    cashBalanceSol: 0.223,
    positions: []
  });
  assert.equal(policy.portfolioEquitySol, 0.223);
  assert.equal(policy.targetEntrySol, 0.0223);
  assert.equal(policy.selectedEntryCapSol, 0.0223);
  assert.deepEqual(policy.ladderSol, [0.0223, 0.01561, 0.00892, 0.00446, 0.001]);
});

test('second stake includes the executable value of the first position', () => {
  const policy = buildEquitySizingPolicy({
    cashBalanceSol: 0.20,
    positions: [{ costBasisSol: 0.0223, executableValueSol: 0.018 }]
  });
  assert.equal(policy.portfolioEquitySol, 0.218);
  assert.equal(policy.targetEntrySol, 0.0218);
  assert.equal(policy.remainingAllocationSol, 0.0213);
  assert.equal(policy.selectedEntryCapSol, 0.0213);
  assert.equal(policy.slotsRemaining, 1);
});

test('cash reserve and total allocation prevent borrowed sizing', () => {
  const policy = buildEquitySizingPolicy({
    cashBalanceSol: 0.012,
    positions: [{ costBasisSol: 0.001, executableValueSol: 0.001 }]
  });
  assert.equal(policy.gasReserveSol, 0.01);
  assert.equal(policy.spendableCashSol, 0.002);
  assert.equal(policy.selectedEntryCapSol, 0.0013);
  assert.ok(policy.ladderSol.every(value => value <= 0.0013));
});

test('no third stake is produced when both slots are occupied', () => {
  const policy = buildEquitySizingPolicy({
    cashBalanceSol: 1,
    positions: [
      { costBasisSol: 0.02, executableValueSol: 0.02 },
      { costBasisSol: 0.02, executableValueSol: 0.02 }
    ]
  });
  assert.equal(policy.slotsRemaining, 0);
  assert.equal(policy.canOpenNextPosition, false);
});
