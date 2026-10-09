import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveExecutionMode, readSigningSecretKey, isHypotheticalExecution } from './executionMode.js';

test('execution policy fails safe for absent and malformed flags', () => {
  for (const env of [{}, { SHADOW_MODE: 'false' }, { DRY_RUN_MODE: 'false' },
    { SHADOW_MODE: '0', DRY_RUN_MODE: 'false' },
    { SHADOW_MODE: 'false', DRY_RUN_MODE: 'off' }]) {
    assert.deepEqual(resolveExecutionMode(env), { shadow: true, canSign: false, canBroadcast: false });
  }
});

test('either true flag overrides an explicit false flag', () => {
  for (const env of [
    { SHADOW_MODE: ' TRUE ', DRY_RUN_MODE: 'false' },
    { SHADOW_MODE: 'false', DRY_RUN_MODE: ' TrUe ' }
  ]) {
    assert.deepEqual(resolveExecutionMode(env), { shadow: true, canSign: false, canBroadcast: false });
  }
});

test('only two explicit false flags allow live capability', () => {
  assert.deepEqual(resolveExecutionMode({ SHADOW_MODE: ' FALSE ', DRY_RUN_MODE: ' FaLsE ' }),
    { shadow: false, canSign: true, canBroadcast: true });
});

test('bootstrap credential helper never touches secret getter in shadow', () => {
  const env = {
    SHADOW_MODE: 'true', DRY_RUN_MODE: 'false',
    get AGENT_SOLANA_PRIVATE_KEY(): string { throw new Error('secret read'); }
  };
  assert.equal(readSigningSecretKey(env), undefined);
});

test('a dry-run quote cannot be treated as a confirmed trade', () => {
  assert.equal(isHypotheticalExecution({ status: 'DRY_RUN_SUCCESS', isDryRun: true }), true);
  assert.equal(isHypotheticalExecution({ status: 'SUCCESS', isDryRun: false }), false);
});
