import assert from 'node:assert/strict';
import test from 'node:test';
import { PublicKey } from '@solana/web3.js';
import {
  PUMP_CREATE_EVENT_DISCRIMINATOR,
  decodePumpCreateEvent,
  decodePumpCreateEventsFromLogs
} from './pumpCreateEvent.js';

function u32(value: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(value);
  return b;
}
function u64(value: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(value);
  return b;
}
function i64(value: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigInt64LE(value);
  return b;
}
function str(value: string): Buffer {
  const body = Buffer.from(value, 'utf8');
  return Buffer.concat([u32(body.length), body]);
}
function key(fill: number): PublicKey {
  return new PublicKey(Uint8Array.from({ length: 32 }, () => fill));
}

function createEventBuffer(): Buffer {
  return Buffer.concat([
    PUMP_CREATE_EVENT_DISCRIMINATOR,
    str('Nexus Pump Test'),
    str('NPT'),
    str('https://example.invalid/meta.json'),
    key(1).toBuffer(),
    key(2).toBuffer(),
    key(3).toBuffer(),
    key(4).toBuffer(),
    i64(1_791_043_200n),
    u64(1_000_000_000n),
    u64(30_000_000_000n),
    u64(800_000_000n),
    u64(1_000_000_000n),
    key(5).toBuffer(),
    Buffer.from([0]),
    Buffer.from([1]),
    key(6).toBuffer(),
    u64(30_000_000_000n),
    u64(95n),
    Buffer.from([1])
  ]);
}

test('decodes the current official Pump CreateEvent layout', () => {
  const event = decodePumpCreateEvent(createEventBuffer());
  assert.ok(event);
  assert.equal(event.name, 'Nexus Pump Test');
  assert.equal(event.symbol, 'NPT');
  assert.equal(event.mint, key(1).toBase58());
  assert.equal(event.bondingCurve, key(2).toBase58());
  assert.equal(event.creator, key(4).toBase58());
  assert.equal(event.timestamp, 1_791_043_200n);
  assert.equal(event.realTokenReserves, 800_000_000n);
  assert.equal(event.creatorFeeBps, 95n);
  assert.equal(event.isMayhemMode, false);
  assert.equal(event.isCashbackEnabled, true);
  assert.equal(event.isHolderReward, true);
});

test('ignores other Anchor events by discriminator', () => {
  const data = createEventBuffer();
  data[0] ^= 0xff;
  assert.equal(decodePumpCreateEvent(data), null);
});

test('malformed CreateEvent fails closed without throwing', () => {
  assert.equal(
    decodePumpCreateEvent(Buffer.concat([PUMP_CREATE_EVENT_DISCRIMINATOR, Buffer.from([1, 2, 3])])),
    null
  );
});

test('extracts only Pump CreateEvents from Program data log lines', () => {
  const data = createEventBuffer();
  const events = decodePumpCreateEventsFromLogs([
    'Program log: Instruction: CreateV2',
    'Program data: ' + Buffer.from('unrelated').toString('base64'),
    'Program data: ' + data.toString('base64')
  ]);
  assert.equal(events.length, 1);
  assert.equal(events[0].symbol, 'NPT');
});
