import assert from 'node:assert/strict';
import test from 'node:test';
import { PublicKey } from '@solana/web3.js';
import {
  PUMP_PROGRAM_ID,
  calculatePumpCurveProgress,
  decodePumpBondingCurve,
  derivePumpBondingCurvePda
} from './pumpBondingCurve.js';

function u64(value: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(value);
  return b;
}
function curveBuffer(realTokenReserves: bigint, complete: boolean): Buffer {
  return Buffer.concat([
    Buffer.alloc(8, 7),
    u64(1_000_000_000n),
    u64(30_000_000_000n),
    u64(realTokenReserves),
    u64(12_000_000_000n),
    u64(1_000_000_000n),
    Buffer.from([complete ? 1 : 0])
  ]);
}

test('derives the canonical bonding-curve PDA from mint', () => {
  const mint = new PublicKey(Uint8Array.from({ length: 32 }, () => 9));
  const [expected] = PublicKey.findProgramAddressSync(
    [Buffer.from('bonding-curve'), mint.toBuffer()],
    PUMP_PROGRAM_ID
  );
  assert.equal(derivePumpBondingCurvePda(mint).toBase58(), expected.toBase58());
});

test('decodes the stable prefix of a Pump bonding-curve account', () => {
  const curve = decodePumpBondingCurve(curveBuffer(500_000_000n, false));
  assert.ok(curve);
  assert.equal(curve.virtualTokenReserves, 1_000_000_000n);
  assert.equal(curve.virtualSolReserves, 30_000_000_000n);
  assert.equal(curve.realTokenReserves, 500_000_000n);
  assert.equal(curve.realSolReserves, 12_000_000_000n);
  assert.equal(curve.tokenTotalSupply, 1_000_000_000n);
  assert.equal(curve.complete, false);
});

test('curve progress is relative to the reserves observed at creation', () => {
  assert.equal(calculatePumpCurveProgress(800n, 800n, false), 0);
  assert.equal(calculatePumpCurveProgress(800n, 400n, false), 50);
  assert.equal(calculatePumpCurveProgress(800n, 0n, false), 100);
  assert.equal(calculatePumpCurveProgress(800n, 300n, true), 100);
});

test('curve decoder fails closed on truncated account data', () => {
  assert.equal(decodePumpBondingCurve(Buffer.alloc(20)), null);
});
