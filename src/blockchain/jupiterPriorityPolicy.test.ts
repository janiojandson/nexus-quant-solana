import assert from 'node:assert/strict';
import test from 'node:test';
import { priorityForJupiterWork } from './jupiterPriorityPolicy.js';

test('maps emergency and protective exits above monitoring and entries', () => {
  assert.equal(priorityForJupiterWork('EMERGENCY_EXIT'), 0);
  assert.equal(priorityForJupiterWork('PROTECTIVE_EXIT'), 1);
  assert.equal(priorityForJupiterWork('EXIT_CONFIRMATION'), 2);
  assert.equal(priorityForJupiterWork('POSITION_HEALTH'), 3);
  assert.equal(priorityForJupiterWork('ENTRY_ORDER'), 4);
  assert.equal(priorityForJupiterWork('ENTRY_SIZING'), 5);
  assert.equal(priorityForJupiterWork('PUMP_RESEARCH'), 6);
});
