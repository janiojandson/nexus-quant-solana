import test from 'node:test';
import assert from 'node:assert/strict';
import { scheduleEntryAdvisory } from './entryAdvisory.js';

test('advisory returns immediately while Laya is pending and records VETO passively', async () => {
  let resolve!: (value: any) => void;
  const pending = new Promise<any>(r => { resolve = r; });
  const telemetry = scheduleEntryAdvisory({ facts: {} as any, evaluate: () => pending });
  assert.equal(telemetry.status, 'SCHEDULED');
  assert.equal(telemetry.mode, 'SHADOW');
  resolve({ action: 'VETO', score: 0 });
  await new Promise(r => setImmediate(r));
  assert.equal(telemetry.status, 'COMPLETED');
  assert.equal(telemetry.action, 'VETO');
});

test('advisory catches synchronous throws, timeout and abstention without rejecting the caller', async () => {
  for (const evaluate of [
    () => { throw new Error('timeout'); },
    () => Promise.reject(new Error('API down')),
    () => Promise.resolve({ action: 'ABSTAIN', score: 0 })
  ]) {
    const telemetry = scheduleEntryAdvisory({ facts: {} as any, evaluate: evaluate as any });
    await new Promise(r => setImmediate(r));
    assert.ok(['ERROR', 'COMPLETED'].includes(telemetry.status));
  }
});

test('missing facts are passive telemetry and never call Laya', () => {
  const telemetry = scheduleEntryAdvisory({ evaluate: async () => { throw new Error('must not call'); } });
  assert.equal(telemetry.status, 'MISSING_FACTS');
});
