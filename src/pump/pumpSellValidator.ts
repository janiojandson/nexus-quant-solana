import { PublicKey } from '@solana/web3.js';
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync
} from '@solana/spl-token';
import { PUMP_PROGRAM_ID, derivePumpBondingCurvePda } from './pumpBondingCurve.js';

export const PUMP_BONDING_CURVE_DISCRIMINATOR = Buffer.from([
  23, 183, 248, 55, 96, 216, 172, 96
]);

const asPublicKeys = (values: string[]): readonly PublicKey[] =>
  Object.freeze(values.map(value => new PublicKey(value)));

export const PUMP_NORMAL_FEE_RECIPIENTS = asPublicKeys([
  '62qc2CNXwrYqQScmEdiZFFAnJR262PxWEuNQtxfafNgV',
  '7VtfL8fvgNfhz17qKRMjzQEXgbdpnHHHQRh54R9jP2RJ',
  '7hTckgnGnLQR6sdH7YkqFTAA7VwTfYFaZ6EhEsU3saCX',
  '9rPYyANsfQZw3DnDmKE3YCQF5E8oD89UXoHn9JFEhJUz',
  'AVmoTthdrX6tKt4nDjco2D775W2YK3sDhxPcMmzUAmTY',
  'CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM',
  'FWsW1xNtWscwNmKv6wVsU1iTzRN6wmmk3MjxRP5tT7hz',
  'G5UZAVbAf46s7cKWoyKu8kYTip9DGTpbLZ2qa9Aq69dP'
]);

export const PUMP_MAYHEM_FEE_RECIPIENTS = asPublicKeys([
  'GesfTA3X2arioaHp8bbKdjG9vJtskViWACZoYvxp4twS',
  '4budycTjhs9fD6xw62VBducVTNgMgJJ5BgtKq7mAZwn6',
  '8SBKzEQU4nLSzcwF4a74F2iaUDQyTfjGndn6qUWBnrpR',
  '4UQeTP1T39KZ9Sfxzo3WR5skgsaP6NZa87BAkuazLEKH',
  '8sNeir4QsLsJdYpc9RZacohhK1Y5FLU3nC5LXgYB4aa6',
  'Fh9HmeLNUMVCvejxCtCL2DbYaRyBFVJ5xrWkLnMH6fdk',
  '463MEnMeGyJekNZFQSTUABBEbLnvMTALbT6ZmsxAbAdq',
  '6AUH3WEHucYZyC61hqpqYUWVto5qA5hjHuNQ32GNnNxA'
]);

export const PUMP_BUYBACK_FEE_RECIPIENTS = asPublicKeys([
  '5YxQFdt3Tr9zJLvkFccqXVUwhdTWJQc1fFg2YPbxvxeD',
  '9M4giFFMxmFGXtc3feFzRai56WbBqehoSeRE5GK7gf7',
  'GXPFM2caqTtQYC2cJ5yJRi9VDkpsYZXzYdwYpGnLmtDL',
  '3BpXnfJaUTiwXnJNe7Ej1rcbzqTTQUvLShZaWazebsVR',
  '5cjcW9wExnJJiqgLjq7DEG75Pm6JBgE1hNv4B2vHXUW6',
  'EHAAiTxcdDwQ3U4bU6YcMsQGaekdzLS3B5SmYo46kJtL',
  '5eHhjP8JaYkz83CWwvGU2uMUXefd3AazWGx4gpcuEEYD',
  'A7hAgCzFw14fejgCp387JUJRMNyz4j89JKnhtKU8piqW'
]);

export interface PumpSellBondingCurveState {
  virtualTokenReserves: bigint;
  virtualSolReserves: bigint;
  realTokenReserves: bigint;
  realSolReserves: bigint;
  tokenTotalSupply: bigint;
  complete: boolean;
  creator: PublicKey;
  isMayhemMode: boolean;
  isCashbackCoin: boolean;
  quoteMint: PublicKey;
}

export interface PumpSellValidationInput {
  mint: PublicKey;
  user: PublicKey;
  bondingCurve: PublicKey;
  bondingCurveAccount: { owner: PublicKey; data: Buffer };
  mintAccountOwner: PublicKey;
  baseTokenProgram: PublicKey;
  userBaseAta: PublicKey;
  userBaseAtaAccountOwner: PublicKey;
  curveBaseAta: PublicKey;
  curveBaseAtaAccountOwner: PublicKey;
  feeRecipient: PublicKey;
  buybackFeeRecipient: PublicKey;
}

export interface PumpSellValidationResult {
  ok: boolean;
  reason?: string;
  state?: PumpSellBondingCurveState;
}

function publicKeyIn(key: PublicKey, values: readonly PublicKey[]): boolean {
  return values.some(value => value.equals(key));
}

function decodeSellCurve(data: Buffer): PumpSellBondingCurveState | null {
  if (!Buffer.isBuffer(data) || data.length < 115) return null;
  if (!data.subarray(0, 8).equals(PUMP_BONDING_CURVE_DISCRIMINATOR)) return null;

  try {
    let offset = 8;
    const readU64 = (): bigint => {
      const value = data.readBigUInt64LE(offset);
      offset += 8;
      return value;
    };
    const virtualTokenReserves = readU64();
    const virtualSolReserves = readU64();
    const realTokenReserves = readU64();
    const realSolReserves = readU64();
    const tokenTotalSupply = readU64();
    const completeByte = data[offset++];
    if (completeByte !== 0 && completeByte !== 1) return null;
    const creator = new PublicKey(data.subarray(offset, offset + 32));
    offset += 32;
    const mayhemByte = data[offset++];
    const cashbackByte = data[offset++];
    if (![0, 1].includes(mayhemByte) || ![0, 1].includes(cashbackByte)) return null;
    const quoteMint = new PublicKey(data.subarray(offset, offset + 32));

    return {
      virtualTokenReserves,
      virtualSolReserves,
      realTokenReserves,
      realSolReserves,
      tokenTotalSupply,
      complete: completeByte === 1,
      creator,
      isMayhemMode: mayhemByte === 1,
      isCashbackCoin: cashbackByte === 1,
      quoteMint
    };
  } catch {
    return null;
  }
}

function fail(reason: string): PumpSellValidationResult {
  return { ok: false, reason };
}

export function validatePumpSellState(input: PumpSellValidationInput): PumpSellValidationResult {
  const expectedBondingCurve = derivePumpBondingCurvePda(input.mint);
  if (!input.bondingCurve.equals(expectedBondingCurve)) {
    return fail('Pump bonding curve PDA does not match the canonical mint PDA.');
  }
  if (!input.bondingCurveAccount.owner.equals(PUMP_PROGRAM_ID)) {
    return fail('Pump bonding curve program owner is not the canonical Pump program.');
  }

  const supportedTokenProgram =
    input.baseTokenProgram.equals(TOKEN_PROGRAM_ID) ||
    input.baseTokenProgram.equals(TOKEN_2022_PROGRAM_ID);
  if (!supportedTokenProgram || !input.mintAccountOwner.equals(input.baseTokenProgram)) {
    return fail('Pump base mint token program/owner mismatch.');
  }

  const state = decodeSellCurve(input.bondingCurveAccount.data);
  if (!state) return fail('Pump bonding curve data/discriminator is invalid or too short.');
  if (state.complete) return fail('Pump bonding curve is complete; use post-graduation routing.');

  // This first fallback intentionally supports only native-SOL Pump curves.
  // The on-chain state stores Pubkey::default() for SOL-paired curves.
  if (!state.quoteMint.equals(PublicKey.default)) {
    return fail('Pump direct sell fallback only supports SOL-paired bonding curves.');
  }
  if (state.creator.equals(PublicKey.default)) {
    return fail('Pump bonding curve creator is missing; creator-vault validation cannot be fail-closed.');
  }

  const expectedUserAta = getAssociatedTokenAddressSync(
    input.mint,
    input.user,
    false,
    input.baseTokenProgram
  );
  if (!input.userBaseAta.equals(expectedUserAta)) {
    return fail('Pump user ATA does not match the canonical associated token account.');
  }
  if (!input.userBaseAtaAccountOwner.equals(input.baseTokenProgram)) {
    return fail('Pump user ATA owner is not the base token program.');
  }

  const expectedCurveAta = getAssociatedTokenAddressSync(
    input.mint,
    input.bondingCurve,
    true,
    input.baseTokenProgram
  );
  if (!input.curveBaseAta.equals(expectedCurveAta)) {
    return fail('Pump bonding curve ATA does not match the canonical associated token account.');
  }
  if (!input.curveBaseAtaAccountOwner.equals(input.baseTokenProgram)) {
    return fail('Pump bonding curve ATA owner is not the base token program.');
  }

  const allowedFeeRecipients = state.isMayhemMode
    ? PUMP_MAYHEM_FEE_RECIPIENTS
    : PUMP_NORMAL_FEE_RECIPIENTS;
  if (!publicKeyIn(input.feeRecipient, allowedFeeRecipients)) {
    return fail('Pump fee recipient is not valid for this curve mode.');
  }
  if (!publicKeyIn(input.buybackFeeRecipient, PUMP_BUYBACK_FEE_RECIPIENTS)) {
    return fail('Pump buyback fee recipient is not in the official allowlist.');
  }

  return { ok: true, state };
}
