import { PublicKey } from '@solana/web3.js';

export const PUMP_CREATE_EVENT_DISCRIMINATOR = Buffer.from([
  27, 114, 169, 77, 222, 235, 99, 118
]);

export interface PumpCreateEvent {
  name: string;
  symbol: string;
  uri: string;
  mint: string;
  bondingCurve: string;
  user: string;
  creator: string;
  timestamp: bigint;
  virtualTokenReserves: bigint;
  virtualSolReserves: bigint;
  realTokenReserves: bigint;
  tokenTotalSupply: bigint;
  tokenProgram: string;
  isMayhemMode: boolean;
  isCashbackEnabled: boolean;
  quoteMint: string;
  virtualQuoteReserves: bigint;
  creatorFeeBps: bigint;
  isHolderReward: boolean;
}

class BorshReader {
  private offset = 0;

  constructor(private readonly data: Buffer) {}

  private take(length: number): Buffer {
    if (!Number.isInteger(length) || length < 0 || this.offset + length > this.data.length) {
      throw new Error('Pump event truncated');
    }
    const out = this.data.subarray(this.offset, this.offset + length);
    this.offset += length;
    return out;
  }

  readU32(): number {
    return this.take(4).readUInt32LE(0);
  }

  readString(): string {
    const length = this.readU32();
    if (length > 16_384) throw new Error('Pump event string exceeds safety limit');
    return this.take(length).toString('utf8');
  }

  readPublicKey(): string {
    return new PublicKey(this.take(32)).toBase58();
  }

  readU64(): bigint {
    return this.take(8).readBigUInt64LE(0);
  }

  readI64(): bigint {
    return this.take(8).readBigInt64LE(0);
  }

  readBool(): boolean {
    const value = this.take(1)[0];
    if (value !== 0 && value !== 1) throw new Error('Invalid Pump boolean');
    return value === 1;
  }
}

export function decodePumpCreateEvent(data: Buffer): PumpCreateEvent | null {
  try {
    if (
      data.length < PUMP_CREATE_EVENT_DISCRIMINATOR.length ||
      !data.subarray(0, 8).equals(PUMP_CREATE_EVENT_DISCRIMINATOR)
    ) {
      return null;
    }

    const r = new BorshReader(data.subarray(8));
    return {
      name: r.readString(),
      symbol: r.readString(),
      uri: r.readString(),
      mint: r.readPublicKey(),
      bondingCurve: r.readPublicKey(),
      user: r.readPublicKey(),
      creator: r.readPublicKey(),
      timestamp: r.readI64(),
      virtualTokenReserves: r.readU64(),
      virtualSolReserves: r.readU64(),
      realTokenReserves: r.readU64(),
      tokenTotalSupply: r.readU64(),
      tokenProgram: r.readPublicKey(),
      isMayhemMode: r.readBool(),
      isCashbackEnabled: r.readBool(),
      quoteMint: r.readPublicKey(),
      virtualQuoteReserves: r.readU64(),
      creatorFeeBps: r.readU64(),
      isHolderReward: r.readBool()
    };
  } catch {
    return null;
  }
}

export function decodePumpCreateEventsFromLogs(logs: string[]): PumpCreateEvent[] {
  const events: PumpCreateEvent[] = [];
  for (const line of logs || []) {
    const match = /^Program data:\s+([A-Za-z0-9+/=]+)\s*$/.exec(line);
    if (!match) continue;
    try {
      const event = decodePumpCreateEvent(Buffer.from(match[1], 'base64'));
      if (event) events.push(event);
    } catch {
      // Malformed/unrelated log entry: fail closed and continue observing.
    }
  }
  return events;
}
