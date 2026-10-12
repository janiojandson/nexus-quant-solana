import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, PublicKey } from '@solana/web3.js';
import { verifyLpLockedOrBurnedOnChain } from './lpBurnResolver.js';

const MINT = Keypair.generate().publicKey;
const INCINERATOR = new PublicKey('1nc1nerator11111111111111111111111111111111'); // OFF-curve
const SYSTEM_PROGRAM = new PublicKey('11111111111111111111111111111111'); // ON-curve (destino de queima)
const LOCKER_PDA = PublicKey.findProgramAddressSync(
  [Buffer.from('locker-vault'), MINT.toBuffer()],
  new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
)[0]; // OFF-curve

function ataData(owner: PublicKey): string {
  const buf = Buffer.alloc(72);
  MINT.toBuffer().copy(buf, 0);
  owner.toBuffer().copy(buf, 32);
  buf.writeBigUInt64LE(1000n, 64);
  return buf.toString('base64');
}

function makeRpc(owners: Array<{ amount: number; owner: PublicKey }>) {
  const accounts = owners.map((o, i) => ({ address: `acct-${i}`, amount: String(o.amount) }));
  return {
    call: async (_work: string, method: string, params: unknown[]) => {
      if (method === 'getTokenSupply') return { value: { amount: '1000' } };
      if (method === 'getTokenLargestAccounts') return { value: accounts };
      if (method === 'getAccountInfo') {
        const addr = params[0] as string;
        const idx = accounts.findIndex(a => a.address === addr);
        if (idx < 0) return { value: null };
        return { value: { data: [ataData(owners[idx].owner), 'base64'] } };
      }
      throw new Error(`unexpected rpc method ${method}`);
    }
  };
}

test('LP 100% queimada no incinerador (OFF-curve) => imobilizada', async () => {
  const rpc = makeRpc([{ amount: 1000, owner: INCINERATOR }]);
  assert.equal(await verifyLpLockedOrBurnedOnChain(rpc as any, MINT), true);
});

test('LP 100% queimada no System Program (ON-curve) => imobilizada', async () => {
  const rpc = makeRpc([{ amount: 1000, owner: SYSTEM_PROGRAM }]);
  assert.equal(await verifyLpLockedOrBurnedOnChain(rpc as any, MINT), true);
});

test('LP 100% em PDA genérico (OFF-curve) => NÃO imobilizada (fail-closed)', async () => {
  const rpc = makeRpc([{ amount: 1000, owner: LOCKER_PDA }]);
  assert.equal(await verifyLpLockedOrBurnedOnChain(rpc as any, MINT), false);
});

test('LP 100% em EOA (ON-curve) => não imobilizada', async () => {
  const rpc = makeRpc([{ amount: 1000, owner: Keypair.generate().publicKey }]);
  assert.equal(await verifyLpLockedOrBurnedOnChain(rpc as any, MINT), false);
});

test('LP 90% queimada no incinerador + 10% EOA => imobilizada (>= 90%)', async () => {
  const rpc = makeRpc([
    { amount: 900, owner: INCINERATOR },
    { amount: 100, owner: Keypair.generate().publicKey }
  ]);
  assert.equal(await verifyLpLockedOrBurnedOnChain(rpc as any, MINT), true);
});

test('LP 90% em PDA genérico + 10% EOA => NÃO imobilizada (PDA não prova lock)', async () => {
  const rpc = makeRpc([
    { amount: 900, owner: LOCKER_PDA },
    { amount: 100, owner: Keypair.generate().publicKey }
  ]);
  assert.equal(await verifyLpLockedOrBurnedOnChain(rpc as any, MINT), false);
});

test('LP 80% queimada no incinerador + 20% EOA => não imobilizada (< 90%)', async () => {
  const rpc = makeRpc([
    { amount: 800, owner: INCINERATOR },
    { amount: 200, owner: Keypair.generate().publicKey }
  ]);
  assert.equal(await verifyLpLockedOrBurnedOnChain(rpc as any, MINT), false);
});
