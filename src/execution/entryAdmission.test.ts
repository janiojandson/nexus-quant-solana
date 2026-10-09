import test from 'node:test';
import assert from 'node:assert/strict';
import { EntryAdmission } from './entryAdmission.js';

const candidate = { mint: 'mint', symbol: 'REAL', name: 'Real', priceUsd: 0.01,
  liquidityUsd: 31000, pairAddress: 'pool' };
const accepted = { accepted: true as const, order: { requestId: 'order', transaction: 'unsigned', inAmount: '25000000', outAmount: '100' },
  evidence: { pool: { poolAddress: 'pool' } } };

test('common admission denies typed preflight rejection and absent durable registrar without acceptance', async () => {
  let registerCalls = 0;
  const denied = new EntryAdmission({ run: async () => ({ accepted: false as const, reason: 'MINT_AUTHORITY_ACTIVE' }) } as any,
    { register: async () => { registerCalls++; throw new Error('UNEXPECTED_REGISTER'); } } as any);
  const first = await denied.attempt({ candidate, stakeLamports: 25_000_000,
    availableLamports: 100_000_000, reservedGasLamports: 5_000_000,
    verifySecurity: async () => ({ safe: true }) });
  assert.deepEqual(first, { accepted: false, reason: 'MINT_AUTHORITY_ACTIVE' });
  assert.equal(registerCalls, 0);
  const unavailable = new EntryAdmission({ run: async () => accepted } as any);
  const second = await unavailable.attempt({ candidate, stakeLamports: 25_000_000,
    availableLamports: 100_000_000, reservedGasLamports: 5_000_000,
    verifySecurity: async () => ({ safe: true }) });
  assert.deepEqual(second, { accepted: false, reason: 'PERSISTENCE_UNAVAILABLE' });
});

test('lost handoff lease after security or preflight await has zero acceptance effects', async () => {
  let effects = 0;
  let active = true;
  let loseDuringPreflight = false;
  const registrar = { register: async () => { effects++; return { durable: true, positionRegistered: true,
    accountingMode: 'SHADOW', entryIntentId: 'intent', traceId: 'trace' }; } };
  const preflight = { run: async () => { effects++; if (loseDuringPreflight) active = false; return accepted; } };
  const admission = new EntryAdmission(preflight as any, registrar as any);
  const lease = { mint: 'mint', leaseId: 'lease', assertLeaseActive: async () => { if (!active) throw new Error('LEASE_LOST'); } };
  const first = await admission.attempt({ candidate, stakeLamports: 25_000_000, lease,
    availableLamports: 100_000_000, reservedGasLamports: 5_000_000,
    verifySecurity: async () => { active = false; return { safe: true }; } });
  assert.equal(first.accepted, false);
  assert.equal(effects, 0);
  active = true;
  loseDuringPreflight = true;
  const second = await admission.attempt({ candidate, stakeLamports: 25_000_000, lease,
    availableLamports: 100_000_000, reservedGasLamports: 5_000_000,
    verifySecurity: async () => ({ safe: true }) });
  assert.equal(second.accepted, false);
  assert.equal(effects, 1); // preflight completed, registration did not begin
});

test('accepted admission requires durable SHADOW receipt after the exact allocated stake', async () => {
  let amount = 0;
  const admission = new EntryAdmission({ run: async (request: any) => { amount = request.stakeLamports; return accepted; } } as any,
    { register: async (input: any) => {
      assert.equal(input.stakeLamports, 25_000_000);
      assert.equal(input.accepted.order.requestId, 'order');
      return { durable: true, positionRegistered: true, accountingMode: 'SHADOW', entryIntentId: 'intent', traceId: 'trace' };
    } } as any);
  const result = await admission.attempt({ candidate, stakeLamports: 25_000_000,
    availableLamports: 100_000_000, reservedGasLamports: 5_000_000,
    verifySecurity: async () => ({ safe: true }) });
  assert.equal(amount, 25_000_000);
  assert.equal(result.accepted, true);
});

test('temporary security and preflight exceptions retain their stage-specific denial reasons', async () => {
  const security = new EntryAdmission({run:async()=>{ throw new Error('SHOULD_NOT_RUN'); }} as any);
  const input = {candidate,stakeLamports:25_000_000,availableLamports:100_000_000,
    reservedGasLamports:5_000_000,verifySecurity:async()=>{ throw new Error('NETWORK_FAILURE'); }};
  assert.deepEqual(await security.attempt(input),{accepted:false,reason:'SECURITY_UNAVAILABLE'});
  const preflight = new EntryAdmission({run:async()=>{ throw new Error('HUB_TIMEOUT'); }} as any);
  assert.deepEqual(await preflight.attempt({...input,verifySecurity:async()=>({safe:true})}),
    {accepted:false,reason:'PREFLIGHT_UNAVAILABLE'});
});
