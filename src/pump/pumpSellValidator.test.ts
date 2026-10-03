import assert from 'node:assert/strict';
import test from 'node:test';
import { Keypair, PublicKey } from '@solana/web3.js';
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync
} from '@solana/spl-token';
import { PUMP_PROGRAM_ID, derivePumpBondingCurvePda } from './pumpBondingCurve.js';
import {
  PUMP_BUYBACK_FEE_RECIPIENTS,
  PUMP_NORMAL_FEE_RECIPIENTS,
  validatePumpSellState
} from './pumpSellValidator.js';

function pk(byte: number): PublicKey {
  return new PublicKey(Uint8Array.from({ length: 32 }, () => byte));
}

function curveData(creator: PublicKey, complete = false, mayhem = false): Buffer {
  const data = Buffer.alloc(115);
  Buffer.from([23, 183, 248, 55, 96, 216, 172, 96]).copy(data, 0);
  let offset = 8;
  for (const value of [1_073_000_000_000_000n, 30_000_000_000n, 500_000_000_000_000n, 10_000_000_000n, 1_000_000_000_000_000n]) {
    data.writeBigUInt64LE(value, offset);
    offset += 8;
  }
  data[offset++] = complete ? 1 : 0;
  creator.toBuffer().copy(data, offset); offset += 32;
  data[offset++] = mayhem ? 1 : 0;
  data[offset++] = 0;
  Buffer.alloc(32).copy(data, offset); // Pubkey::default => SOL paired.
  return data;
}

function validInput(tokenProgram = TOKEN_2022_PROGRAM_ID) {
  const mint = pk(1);
  const user = Keypair.fromSeed(Uint8Array.from({ length: 32 }, () => 2)).publicKey;
  const creator = pk(3);
  const bondingCurve = derivePumpBondingCurvePda(mint);
  return {
    mint,
    user,
    bondingCurve,
    bondingCurveAccount: { owner: PUMP_PROGRAM_ID, data: curveData(creator) },
    mintAccountOwner: tokenProgram,
    baseTokenProgram: tokenProgram,
    userBaseAta: getAssociatedTokenAddressSync(mint, user, false, tokenProgram),
    userBaseAtaAccountOwner: tokenProgram,
    curveBaseAta: getAssociatedTokenAddressSync(mint, bondingCurve, true, tokenProgram),
    curveBaseAtaAccountOwner: tokenProgram,
    feeRecipient: PUMP_NORMAL_FEE_RECIPIENTS[0],
    buybackFeeRecipient: PUMP_BUYBACK_FEE_RECIPIENTS[0]
  };
}

test('accepts canonical SOL-paired Pump state for Token-2022 and legacy SPL mints', () => {
  for (const tokenProgram of [TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID]) {
    const result = validatePumpSellState(validInput(tokenProgram));
    assert.equal(result.ok, true);
    assert.equal(result.state?.complete, false);
    assert.ok(result.state?.creator);
    assert.equal(result.state?.isMayhemMode, false);
  }
});

test('rejects wrong bonding-curve PDA or owner before signing', () => {
  const wrongPda = { ...validInput(), bondingCurve: pk(9) };
  assert.match(validatePumpSellState(wrongPda).reason || '', /bonding curve PDA/i);

  const wrongOwner = validInput();
  wrongOwner.bondingCurveAccount = { ...wrongOwner.bondingCurveAccount, owner: pk(8) };
  assert.match(validatePumpSellState(wrongOwner).reason || '', /program owner/i);
});

test('rejects completed curves and non-SOL quote mints', () => {
  const complete = validInput();
  complete.bondingCurveAccount = {
    owner: PUMP_PROGRAM_ID,
    data: curveData(pk(3), true)
  };
  assert.match(validatePumpSellState(complete).reason || '', /complete/i);

  const customQuote = validInput();
  const data = curveData(pk(3));
  pk(7).toBuffer().copy(data, 83);
  customQuote.bondingCurveAccount = { owner: PUMP_PROGRAM_ID, data };
  assert.match(validatePumpSellState(customQuote).reason || '', /SOL-paired/i);
});

test('rejects token-program/ATA mismatch and invalid fee recipients', () => {
  const ownerMismatch = validInput();
  ownerMismatch.mintAccountOwner = TOKEN_PROGRAM_ID;
  assert.match(validatePumpSellState(ownerMismatch).reason || '', /token program/i);

  const ataMismatch = validInput();
  ataMismatch.userBaseAta = pk(6);
  assert.match(validatePumpSellState(ataMismatch).reason || '', /user ATA/i);

  const badFee = validInput();
  badFee.feeRecipient = pk(5);
  assert.match(validatePumpSellState(badFee).reason || '', /fee recipient/i);

  const badBuyback = validInput();
  badBuyback.buybackFeeRecipient = pk(4);
  assert.match(validatePumpSellState(badBuyback).reason || '', /buyback/i);
});


test('rejects ATA accounts owned by the wrong token program', () => {
  const input = validInput();
  input.userBaseAtaAccountOwner = TOKEN_PROGRAM_ID;
  assert.match(validatePumpSellState(input).reason || '', /user ATA owner/i);
});
