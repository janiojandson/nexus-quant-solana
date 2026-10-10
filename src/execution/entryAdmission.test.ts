import test from 'node:test';
import assert from 'node:assert/strict';
import { EntryAdmission } from './entryAdmission.js';
import { SolanaWalletService } from '../blockchain/solanaWallet.js';

const candidate = { mint: 'mint', symbol: 'REAL', name: 'Real', priceUsd: 0.01,
  liquidityUsd: 31000, pairAddress: 'pool' };
const capital = () => ({ available: true as const, lamports: 100_000_000, slot: 42,
  observedAtMs: Date.now(), provenance: 'FRESH_CONFIRMED_RPC' as const });
const accepted = { accepted: true as const, order: { requestId: 'order', transaction: 'unsigned', inAmount: '25000000', outAmount: '100' },
  evidence: { pool: { poolAddress: 'pool' } } };

test('discovery and Sentinel deny fresh RPC failure after cached positive capital before preflight, registration or new ACK', async () => {
  for (const source of ['discovery', 'sentinel']) {
    const effects: string[] = [];
    const wallet = new SolanaWalletService({ connection: {
      getBalance: async () => 1_000_000_000,
      getBalanceAndContext: async () => { throw new Error('RPC_UNAVAILABLE'); }
    } as any, executionEnv: { SHADOW_MODE: 'true' } });
    assert.equal(await wallet.getBalanceSol(), 1);
    const capitalObservation = await (wallet as any).readFreshBalance?.() ??
      { available: false, reason: 'WALLET_BALANCE_UNAVAILABLE' };
    const admission = new EntryAdmission({ run: async () => { effects.push('preflight'); return accepted; } } as any,
      { register: async () => { effects.push('register'); return { durable: true, positionRegistered: true,
        accountingMode: 'SHADOW', entryIntentId: 'intent', traceId: 'trace' }; } } as any);
    const result = await admission.attempt({ candidate, stakeLamports: 25_000_000,
      availableLamports: 1_000_000_000, reservedGasLamports: 5_000_000, capitalObservation,
      ...(source === 'sentinel' ? { lease: { mint: 'mint', leaseId: 'lease', assertLeaseActive: async () => {} } } : {}),
      verifySecurity: async () => ({ safe: true }) } as any);
    if (source === 'sentinel' && result.accepted) effects.push('new ACK');
    assert.deepEqual(result, { accepted: false, reason: 'ENTRY_CAPITAL_UNAVAILABLE' });
    assert.deepEqual(effects, []);
  }
});

test('common admission denies typed preflight rejection and absent durable registrar without acceptance', async () => {
  let registerCalls = 0;
  const denied = new EntryAdmission({ run: async () => ({ accepted: false as const, reason: 'MINT_AUTHORITY_ACTIVE' }) } as any,
    { register: async () => { registerCalls++; throw new Error('UNEXPECTED_REGISTER'); } } as any);
  const first = await denied.attempt({ candidate, stakeLamports: 25_000_000,
    capitalObservation: capital(),
    availableLamports: 100_000_000, reservedGasLamports: 5_000_000,
    verifySecurity: async () => ({ safe: true }) });
  assert.deepEqual(first, { accepted: false, reason: 'MINT_AUTHORITY_ACTIVE' });
  assert.equal(registerCalls, 0);
  const unavailable = new EntryAdmission({ run: async () => accepted } as any);
  const second = await unavailable.attempt({ candidate, stakeLamports: 25_000_000,
    capitalObservation: capital(),
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
    capitalObservation: capital(),
    availableLamports: 100_000_000, reservedGasLamports: 5_000_000,
    verifySecurity: async () => { active = false; return { safe: true }; } });
  assert.equal(first.accepted, false);
  assert.equal(effects, 0);
  active = true;
  loseDuringPreflight = true;
  const second = await admission.attempt({ candidate, stakeLamports: 25_000_000, lease,
    capitalObservation: capital(),
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
    capitalObservation: capital(),
    availableLamports: 100_000_000, reservedGasLamports: 5_000_000,
    verifySecurity: async () => ({ safe: true }) });
  assert.equal(amount, 25_000_000);
  assert.equal(result.accepted, true);
});

test('temporary security and preflight exceptions retain their stage-specific denial reasons', async () => {
  const security = new EntryAdmission({run:async()=>{ throw new Error('SHOULD_NOT_RUN'); }} as any);
  const input = {candidate,stakeLamports:25_000_000,availableLamports:100_000_000,
    capitalObservation: capital(),
    reservedGasLamports:5_000_000,verifySecurity:async()=>{ throw new Error('NETWORK_FAILURE'); }};
  assert.deepEqual(await security.attempt(input),{accepted:false,reason:'SECURITY_UNAVAILABLE'});
  const preflight = new EntryAdmission({run:async()=>{ throw new Error('HUB_TIMEOUT'); }} as any);
  assert.deepEqual(await preflight.attempt({...input,verifySecurity:async()=>({safe:true})}),
    {accepted:false,reason:'PREFLIGHT_UNAVAILABLE'});
});

test('committed registration with lease lost after commit returns a durable reconciliation receipt, never acceptance', async () => {
  let active = true;
  const receipt = { durable: true as const, positionRegistered: true as const,
    accountingMode: 'SHADOW' as const, entryIntentId: 'intent', traceId: 'trace' };
  const admission = new EntryAdmission({ run: async () => accepted } as any,
    { register: async () => { active = false; return receipt; } });
  const result = await admission.attempt({ candidate, stakeLamports: 25_000_000,
    capitalObservation: capital(),
    availableLamports: 100_000_000, reservedGasLamports: 5_000_000,
    lease: { mint: 'mint', leaseId: 'old', assertLeaseActive: async () => {
      if (!active) throw new Error('LEASE_LOST');
    } }, verifySecurity: async () => ({ safe: true }) });
  assert.deepEqual(result, { accepted: false, reason: 'DURABLE_COMMITTED_RECONCILE', receipt });
});

test('new fenced lease recovers an existing durable entry without re-running purchase preflight', async () => {
  const receipt = { durable: true as const, positionRegistered: true as const,
    accountingMode: 'SHADOW' as const, entryIntentId: 'intent', traceId: 'trace' };
  const admission = new EntryAdmission({ run: async () => {
    throw new Error('DUPLICATE_PREFLIGHT');
  } } as any, { register: async () => { throw new Error('DUPLICATE_REGISTER'); },
    recover: async () => receipt } as any);
  const result = await admission.attempt({ candidate, stakeLamports: 25_000_000,
    availableLamports: 100_000_000, reservedGasLamports: 5_000_000,
    lease: { mint: 'mint', leaseId: 'new', assertLeaseActive: async () => {} },
    verifySecurity: async () => { throw new Error('DUPLICATE_SECURITY'); } });
  assert.deepEqual(result, { accepted: true, receipt, recovered: true });
});
