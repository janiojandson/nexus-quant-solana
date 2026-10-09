import test from 'node:test';
import assert from 'node:assert/strict';
import { PublicKey } from '@solana/web3.js';
import { HeliusRpcHub } from '../../src/hubs/heliusRpcHub.js';
import { ConfirmedPoolReader } from '../../src/pump/confirmedPoolReader.js';

test('physical pool reader reaches STATE getSlot through actual hub while STATE broadcast stays forbidden', async () => {
  const methods: string[] = [];
  const hub = new HeliusRpcHub(
    [{ id: 'state', apiKey: 'fake-only', quotaGroupId: 'g', role: 'STATE', rps: 10 }],
    [{ id: 'g', rps: 10 }],
    async (_key, method, params) => {
      methods.push(method);
      if (method === 'getSlot') return { status: 200, headers: { get: () => null }, body: { jsonrpc: '2.0', result: 123 } };
      if (method === 'getMultipleAccounts') return { status: 200, headers: { get: () => null }, body: { jsonrpc: '2.0', result: { context: { slot: 123 }, value: (params[0] as string[]).map(() => null) } } };
      throw new Error('UNPLANNED_RPC_METHOD');
    },
    { now: Date.now, sleep: async ms => { await new Promise(resolve => setTimeout(resolve, ms)); }, random: () => 0 },
    { allowedRoles: ['STATE'] }
  );
  const mint = new PublicKey(Buffer.alloc(32, 5)).toBase58();
  const result = await new ConfirmedPoolReader(hub).read(mint);
  assert.deepEqual(result, { ok: false, code: 'POOL_NOT_FOUND' });
  assert.deepEqual(methods, ['getSlot', 'getMultipleAccounts']);
  await assert.rejects(hub.call('STATE', 'sendTransaction', ['fake']), /not allowed/);
  assert.deepEqual(methods, ['getSlot', 'getMultipleAccounts']);
});
