import { PublicKey } from '@solana/web3.js';

export const PUMP_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');

export interface PumpBondingCurveState {
  virtualTokenReserves: bigint;
  virtualSolReserves: bigint;
  realTokenReserves: bigint;
  realSolReserves: bigint;
  tokenTotalSupply: bigint;
  complete: boolean;
}

export function derivePumpBondingCurvePda(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('bonding-curve'), mint.toBuffer()],
    PUMP_PROGRAM_ID
  )[0];
}

export function decodePumpBondingCurve(data: Buffer): PumpBondingCurveState | null {
  // 8-byte Anchor account discriminator + 5 u64 + bool.
  const minimumLength = 8 + (8 * 5) + 1;
  if (!Buffer.isBuffer(data) || data.length < minimumLength) return null;

  try {
    let offset = 8;
    const readU64 = () => {
      const value = data.readBigUInt64LE(offset);
      offset += 8;
      return value;
    };

    const virtualTokenReserves = readU64();
    const virtualSolReserves = readU64();
    const realTokenReserves = readU64();
    const realSolReserves = readU64();
    const tokenTotalSupply = readU64();
    const completeByte = data[offset];
    if (completeByte !== 0 && completeByte !== 1) return null;

    return {
      virtualTokenReserves,
      virtualSolReserves,
      realTokenReserves,
      realSolReserves,
      tokenTotalSupply,
      complete: completeByte === 1
    };
  } catch {
    return null;
  }
}

export function calculatePumpCurveProgress(
  initialRealTokenReserves: bigint,
  currentRealTokenReserves: bigint,
  complete: boolean
): number {
  if (complete) return 100;
  if (initialRealTokenReserves <= 0n) return currentRealTokenReserves <= 0n ? 100 : 0;

  const boundedCurrent = currentRealTokenReserves < 0n
    ? 0n
    : currentRealTokenReserves > initialRealTokenReserves
      ? initialRealTokenReserves
      : currentRealTokenReserves;
  const consumed = initialRealTokenReserves - boundedCurrent;
  const basisPoints = Number((consumed * 10_000n) / initialRealTokenReserves);
  return Math.max(0, Math.min(100, basisPoints / 100));
}
