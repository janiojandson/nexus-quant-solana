import assert from 'node:assert/strict';
import test from 'node:test';
import { PublicKey } from '@solana/web3.js';
import {
  PUMP_CREATE_EVENT_DISCRIMINATOR
} from './pumpCreateEvent.js';
import {
  PUMP_PROGRAM_ID,
  derivePumpBondingCurvePda
} from './pumpBondingCurve.js';
import { PumpObservatory } from './pumpObservatory.js';

function u32(value: number): Buffer { const b = Buffer.alloc(4); b.writeUInt32LE(value); return b; }
function u64(value: bigint): Buffer { const b = Buffer.alloc(8); b.writeBigUInt64LE(value); return b; }
function i64(value: bigint): Buffer { const b = Buffer.alloc(8); b.writeBigInt64LE(value); return b; }
function str(value: string): Buffer { const body = Buffer.from(value); return Buffer.concat([u32(body.length), body]); }
function key(fill: number): PublicKey { return new PublicKey(Uint8Array.from({ length: 32 }, () => fill)); }

function createEventBuffer(timestampSeconds: bigint, mintFill = 11): Buffer {
  return Buffer.concat([
    PUMP_CREATE_EVENT_DISCRIMINATOR,
    str('Observer Test'),
    str('OBS'),
    str('https://example.invalid/obs'),
    key(mintFill).toBuffer(),
    key(12).toBuffer(),
    key(13).toBuffer(),
    key(14).toBuffer(),
    i64(timestampSeconds),
    u64(1_000n),
    u64(30_000_000_000n),
    u64(800n),
    u64(1_000n),
    key(15).toBuffer(),
    Buffer.from([0, 0]),
    key(16).toBuffer(),
    u64(30_000_000_000n),
    u64(0n),
    Buffer.from([0])
  ]);
}
function curveBuffer(realTokenReserves: bigint, complete = false): Buffer {
  return Buffer.concat([
    Buffer.alloc(8),
    u64(1_000n),
    u64(30_000_000_000n),
    u64(realTokenReserves),
    u64(10_000_000_000n),
    u64(1_000n),
    Buffer.from([complete ? 1 : 0])
  ]);
}

test('observatory is read-only, subscribes to Pump and records creation timing + curve progress', async () => {
  let callback: any;
  let observedProgram: PublicKey | undefined;
  const mint = key(11);
  const expectedCurve = derivePumpBondingCurvePda(mint);
  let curveReads = 0;
  const rpc = {
    onLogs(programId: PublicKey, cb: any) {
      observedProgram = programId;
      callback = cb;
      return 77;
    },
    async removeOnLogsListener(id: number) {
      assert.equal(id, 77);
    },
    async getAccountInfo(address: PublicKey) {
      curveReads++;
      assert.equal(address.toBase58(), expectedCurve.toBase58());
      return { data: curveBuffer(400n) };
    }
  };

  let nowMs = 1_791_043_205_000;
  const observer = new PumpObservatory(rpc as any, { now: () => nowMs, refreshIntervalMs: 60_000 });
  await observer.start();
  assert.equal(observedProgram?.toBase58(), PUMP_PROGRAM_ID.toBase58());

  await callback(
    {
      err: null,
      signature: '5'.repeat(88),
      logs: ['Program data: ' + createEventBuffer(1_791_043_200n).toString('base64')]
    },
    { slot: 300_123_456 }
  );

  const initialSnapshot = observer.snapshot();
  assert.equal(curveReads, 0, 'CreateEvent não deve disparar uma leitura RPC por token');
  assert.equal(initialSnapshot.recent[0].progressPct, 0);

  await observer.refreshActiveCurves();
  const snapshot = observer.snapshot();
  assert.equal(curveReads, 1);
  assert.equal(snapshot.running, true);
  assert.equal(snapshot.totalCreatedObserved, 1);
  assert.equal(snapshot.activeCurves, 1);
  assert.equal(snapshot.graduatedCount, 0);
  assert.equal(snapshot.lastCreateToObserverLagMs, 5000);
  assert.equal(snapshot.recent.length, 1);
  assert.equal(snapshot.recent[0].progressPct, 50);
  assert.equal(snapshot.recent[0].mint, mint.toBase58());
  assert.match(snapshot.recent[0].solscanUrl, /solscan\.io\/token\//);
  assert.match(snapshot.recent[0].pumpUrl, /pump\.fun\/coin\//);

  await observer.stop();
  assert.equal(observer.snapshot().running, false);
});

test('observatory deduplicates the same signature/mint event', async () => {
  let callback: any;
  const rpc = {
    onLogs(_programId: PublicKey, cb: any) { callback = cb; return 1; },
    async removeOnLogsListener() {},
    async getAccountInfo() { return { data: curveBuffer(800n) }; }
  };
  const observer = new PumpObservatory(rpc as any, { now: () => 1_791_043_205_000, refreshIntervalMs: 60_000 });
  await observer.start();
  const notification = {
    err: null,
    signature: '6'.repeat(88),
    logs: ['Program data: ' + createEventBuffer(1_791_043_200n).toString('base64')]
  };
  await callback(notification, { slot: 123 });
  await callback(notification, { slot: 123 });
  assert.equal(observer.snapshot().totalCreatedObserved, 1);
  await observer.stop();
});


test('refreshes multiple recent curves with one batch RPC call when provider supports it', async () => {
  let callback: any;
  let singleReads = 0;
  let batchReads = 0;
  const rpc = {
    onLogs(_programId: PublicKey, cb: any) { callback = cb; return 22; },
    async removeOnLogsListener() {},
    async getAccountInfo() {
      singleReads++;
      return { data: curveBuffer(800n) };
    },
    async getMultipleAccountsInfo(addresses: PublicKey[]) {
      batchReads++;
      assert.equal(addresses.length, 2);
      return [
        { data: curveBuffer(600n) },
        { data: curveBuffer(200n) }
      ];
    }
  };

  const observer = new PumpObservatory(rpc as any, {
    now: () => 1_791_043_205_000,
    refreshIntervalMs: 60_000,
    refreshBatchSize: 50
  });
  await observer.start();

  await callback({
    err: null,
    signature: '7'.repeat(88),
    logs: ['Program data: ' + createEventBuffer(1_791_043_200n, 21).toString('base64')]
  }, { slot: 201 });
  await callback({
    err: null,
    signature: '8'.repeat(88),
    logs: ['Program data: ' + createEventBuffer(1_791_043_201n, 22).toString('base64')]
  }, { slot: 202 });

  await observer.refreshActiveCurves();
  const snapshot = observer.snapshot();
  assert.equal(singleReads, 0);
  assert.equal(batchReads, 1);
  assert.equal(snapshot.recent.length, 2);
  assert.equal(snapshot.recent[0].progressPct, 25); // criação mais recente recebe accounts[0]
  assert.equal(snapshot.recent[1].progressPct, 75);

  await observer.stop();
});


test('stores Dex first-seen/ready timing against the canonical Pump birth timestamp', async () => {
  let callback: any;
  const rpc = {
    onLogs(_programId: PublicKey, cb: any) { callback = cb; return 44; },
    async removeOnLogsListener() {},
    async getAccountInfo() { return null; }
  };
  const observer = new PumpObservatory(rpc as any, {
    now: () => 1_791_043_205_000,
    refreshIntervalMs: 60_000
  });
  await observer.start();

  await callback({
    err: null,
    signature: '9'.repeat(88),
    logs: ['Program data: ' + createEventBuffer(1_791_043_200n, 31).toString('base64')]
  }, { slot: 303 });

  const mint = key(31).toBase58();
  const apply = (observer as any).applyDexCorrelation;
  assert.equal(typeof apply, 'function');
  apply.call(observer, mint, {
    observedAtMs: 1_791_043_212_000,
    ready: true,
    pairAddress: 'DexPairABC',
    pairCreatedAtMs: 1_791_043_206_000,
    priceUsd: 0.00042,
    liquidityUsd: 42000,
    dexUrl: 'https://dexscreener.com/solana/dexpairabc'
  });

  const snapshot = observer.snapshot();
  const item = snapshot.recent[0];
  assert.equal(item.dexFirstSeenAtMs, 1_791_043_212_000);
  assert.equal(item.dexReadyAtMs, 1_791_043_212_000);
  assert.equal(item.pumpToDexFirstSeenLagMs, 12_000);
  assert.equal(item.pumpToDexReadyLagMs, 12_000);
  assert.equal(item.dexPairCreatedAtMs, 1_791_043_206_000);
  assert.equal(item.dexTimestampSkewMs, 6_000);
  assert.equal(item.dexLiquidityUsd, 42000);
  assert.equal(snapshot.dexIndexedCount, 1);
  assert.equal(snapshot.dexReadyCount, 1);
  assert.equal(snapshot.lastPumpToDexReadyLagMs, 12_000);

  await observer.stop();
});
