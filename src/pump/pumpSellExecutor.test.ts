import assert from 'node:assert/strict';
import test from 'node:test';
import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync
} from '@solana/spl-token';
import { derivePumpBondingCurvePda, PUMP_PROGRAM_ID } from './pumpBondingCurve.js';
import {
  PUMP_BONDING_CURVE_DISCRIMINATOR,
  PUMP_NORMAL_FEE_RECIPIENTS,
  PUMP_BUYBACK_FEE_RECIPIENTS
} from './pumpSellValidator.js';
import {
  PUMP_SELL_V2_DISCRIMINATOR,
  PumpSellExecutor,
  derivePumpFeeConfigPda,
  derivePumpGlobalPda
} from './pumpSellExecutor.js';

function pk(byte: number): PublicKey {
  return new PublicKey(Uint8Array.from({ length: 32 }, () => byte));
}

function curveData(creator: PublicKey, complete = false): Buffer {
  const data = Buffer.alloc(115);
  PUMP_BONDING_CURVE_DISCRIMINATOR.copy(data, 0);
  let offset = 8;
  for (const value of [1_073_000_000_000_000n, 30_000_000_000n, 500_000_000_000_000n, 10_000_000_000n, 1_000_000_000_000_000n]) {
    data.writeBigUInt64LE(value, offset);
    offset += 8;
  }
  data[offset++] = complete ? 1 : 0;
  creator.toBuffer().copy(data, offset); offset += 32;
  data[offset++] = 0;
  data[offset++] = 0;
  Buffer.alloc(32).copy(data, offset);
  return data;
}

class FakeConnection {
  accounts = new Map<string, { owner: PublicKey; data: Buffer }>();
  simulateErr: unknown = null;
  sendCalls = 0;
  blockhashCalls = 0;

  async getAccountInfo(key: PublicKey) {
    return this.accounts.get(key.toBase58()) ?? null;
  }
  async getLatestBlockhash() {
    this.blockhashCalls++;
    return { blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 123 };
  }
  async simulateTransaction() {
    return { value: { err: this.simulateErr, unitsConsumed: 222_000 } };
  }
  async sendRawTransaction() {
    this.sendCalls++;
    return 'direct_pump_sig';
  }
  async confirmTransaction() {
    return { value: { err: null } };
  }
}

function fixture(complete = false) {
  const connection = new FakeConnection();
  const userKeypair = Keypair.fromSeed(Uint8Array.from({ length: 32 }, () => 7));
  const mint = pk(1);
  const creator = pk(3);
  const curve = derivePumpBondingCurvePda(mint);
  const userAta = getAssociatedTokenAddressSync(mint, userKeypair.publicKey, false, TOKEN_2022_PROGRAM_ID);
  const curveAta = getAssociatedTokenAddressSync(mint, curve, true, TOKEN_2022_PROGRAM_ID);

  connection.accounts.set(mint.toBase58(), { owner: TOKEN_2022_PROGRAM_ID, data: Buffer.alloc(82) });
  connection.accounts.set(curve.toBase58(), { owner: PUMP_PROGRAM_ID, data: curveData(creator, complete) });
  connection.accounts.set(userAta.toBase58(), { owner: TOKEN_2022_PROGRAM_ID, data: Buffer.alloc(165) });
  connection.accounts.set(curveAta.toBase58(), { owner: TOKEN_2022_PROGRAM_ID, data: Buffer.alloc(165) });
  connection.accounts.set(derivePumpGlobalPda().toBase58(), { owner: PUMP_PROGRAM_ID, data: Buffer.alloc(256) });
  connection.accounts.set(derivePumpFeeConfigPda().toBase58(), {
    owner: new PublicKey('pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ'),
    data: Buffer.alloc(128)
  });

  return { connection, userKeypair, mint };
}

test('buildSell encodes exact atomic amount/min-out and canonical 26 sell_v2 accounts', async () => {
  const { connection, userKeypair, mint } = fixture();
  const executor = new PumpSellExecutor(connection as any);
  const built = await executor.buildSell({
    mint,
    userKeypair,
    tokenAmountAtomic: 100_000_000_000n,
    slippageBps: 500,
    totalFeeBps: 125,
    priorityFeeMicroLamports: 100_000
  });

  const sellIx = built.transaction.instructions.at(-1)!;
  assert.equal(sellIx.programId.toBase58(), PUMP_PROGRAM_ID.toBase58());
  assert.equal(sellIx.keys.length, 26);
  assert.deepEqual([...sellIx.data.subarray(0, 8)], [...PUMP_SELL_V2_DISCRIMINATOR]);
  assert.equal(sellIx.data.readBigUInt64LE(8), 100_000_000_000n);
  assert.equal(sellIx.data.readBigUInt64LE(16), built.quote.minSolOutputLamports);
  assert.equal(sellIx.keys[13].pubkey.toBase58(), userKeypair.publicKey.toBase58());
  assert.equal(sellIx.keys[13].isSigner, true);
  assert.equal(sellIx.keys[23].pubkey.toBase58(), SystemProgram.programId.toBase58());
  assert.equal(built.feeRecipient.toBase58(), PUMP_NORMAL_FEE_RECIPIENTS[0].toBase58());
  assert.equal(built.buybackFeeRecipient.toBase58(), PUMP_BUYBACK_FEE_RECIPIENTS[0].toBase58());
});

test('completed curve fails before blockhash/signing and unsafe caps fail closed', async () => {
  const completed = fixture(true);
  const executor = new PumpSellExecutor(completed.connection as any);
  await assert.rejects(() => executor.buildSell({
    mint: completed.mint,
    userKeypair: completed.userKeypair,
    tokenAmountAtomic: 1_000n,
    slippageBps: 500
  }), /complete/i);
  assert.equal(completed.connection.blockhashCalls, 0);

  const valid = fixture();
  const capped = new PumpSellExecutor(valid.connection as any);
  await assert.rejects(() => capped.buildSell({
    mint: valid.mint,
    userKeypair: valid.userKeypair,
    tokenAmountAtomic: 1_000n,
    slippageBps: 751
  }), /slippage/i);
  await assert.rejects(() => capped.buildSell({
    mint: valid.mint,
    userKeypair: valid.userKeypair,
    tokenAmountAtomic: 1_000n,
    slippageBps: 500,
    priorityFeeMicroLamports: 1_000_001
  }), /priority fee/i);
});

test('simulation rejection prevents any broadcast', async () => {
  const { connection, userKeypair, mint } = fixture();
  connection.simulateErr = { InstructionError: [2, { Custom: 6003 }] };
  const executor = new PumpSellExecutor(connection as any);

  const result = await executor.executeSell({
    mint,
    userKeypair,
    tokenAmountAtomic: 1_000_000n,
    slippageBps: 500
  });

  assert.equal(result.status, 'FAILED');
  assert.match(result.error || '', /simulation/i);
  assert.equal(connection.sendCalls, 0);
});
