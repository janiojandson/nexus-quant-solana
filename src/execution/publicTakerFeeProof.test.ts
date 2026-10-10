import test from 'node:test';
import assert from 'node:assert/strict';
import { shadowLiquidableValue } from './shadowQuoteValue.js';
import { feeQuoteFixture, TEST_TAKER, TEST_TOKEN_MINT, TEST_SOL_MINT,
  TEST_SPONSOR, unsignedFeeOrder } from './unsignedFeeProof.testFixture.js';
import { PositionExitEngine } from './positionExitEngine.js';
import { PUMP_SWAP_PROGRAM } from '../pump/confirmedPoolReader.js';
import { VersionedTransaction } from '@solana/web3.js';

const quote = (rawQuote: Record<string, unknown>) => ({ inAmount: 1000, outAmount: 1_400_000_000, rawQuote });
const raw = () => ({ ...feeQuoteFixture('1350000000', 1000, 1_400_000_000), feeBps: 2 });

test('no-taker HTTP200 zeros/null with empty transaction never proves free fee-bearing execution', () => {
  const noTaker = { ...raw(), taker: undefined, transaction: '', signatureFeeLamports: 0,
    signatureFeePayer: null, prioritizationFeeLamports: 0, prioritizationFeePayer: null,
    rentFeeLamports: 0, rentFeePayer: null };
  assert.throws(() => shadowLiquidableValue(quote(noTaker), 1000, TEST_TAKER),
    /SHADOW_QUOTE_PROOF_UNAVAILABLE/);
});

test('explicit gasless sponsor fees do not become taker charges; taker rent remains reserved', () => {
  const value = shadowLiquidableValue(quote({ ...raw(), signatureFeeLamports: 10_000,
    signatureFeePayer: TEST_SPONSOR, prioritizationFeeLamports: 118,
    prioritizationFeePayer: TEST_SPONSOR, rentFeeLamports: 1_488_440,
    rentFeePayer: TEST_TAKER }), 1000, TEST_TAKER);
  assert.equal(value.networkFeeLamports, 0);
  assert.equal(value.rentReserveLamports, 1_488_440);
  assert.equal(value.netLamports, 1_348_241_560);
});

test('payer mismatch, different taker, signed taker or malformed constructed transaction is unknown', () => {
  for (const changed of [{ signatureFeePayer: TEST_TAKER }, { taker: TEST_SPONSOR },
    { transaction: 'not-base64' }, { transaction: unsignedFeeOrder(TEST_SPONSOR) }])
    assert.throws(() => shadowLiquidableValue(quote({ ...raw(), ...changed }), 1000, TEST_TAKER),
      /SHADOW_QUOTE_PROOF_UNAVAILABLE/);
});

test('INPUT and OUTPUT fee denomination keep conservative net and independent before-cost spot stop separate', () => {
  const now = Date.now();
  for (const feeMint of [TEST_TOKEN_MINT, TEST_SOL_MINT]) {
    const net = shadowLiquidableValue(quote({ ...raw(), feeMint }), 1000, TEST_TAKER);
    assert.equal(net.netLamports, 1_349_730_000); // Extra conservative haircut, not actual platform fee.
    const engine = new PositionExitEngine();
    engine.addPosition({ mint: TEST_TOKEN_MINT, symbol: 'REAL', tokenAmount: 1000,
      entrySol: 1, entryPriceUsd: 1, entryTimestamp: now, entryPairAddress: 'pool', accountingMode: 'SHADOW' });
    assert.equal(engine.evaluateExitBySol(TEST_TOKEN_MINT, 0.871, now, {
      initialGrossPoolEvidence: { kind: 'PHYSICAL_POOL_CONFIRMED', venue: 'PumpSwap',
        programId: PUMP_SWAP_PROGRAM.toBase58(), poolAddress: 'pool', slot: 123,
        observedAt: new Date(now).toISOString(), baseMint: TEST_TOKEN_MINT, quoteMint: TEST_SOL_MINT,
        baseVault: 'token-vault', quoteVault: 'sol-vault', physicalSolLamports: '87600000000',
        tokenReserveAtomic: '100000', poolCreatedAt: null }
    }).type, 'HOLD');
  }
  assert.throws(() => shadowLiquidableValue(quote({ ...raw(), feeMint: TEST_SPONSOR }),
    1000, TEST_TAKER), /SHADOW_QUOTE_PROOF_UNAVAILABLE/);
});

test('missing fee denomination cannot masquerade as missing input mint', () => {
  assert.throws(() => shadowLiquidableValue(quote({ ...raw(), inputMint: undefined,
    feeMint: undefined }), 1000, TEST_TAKER), /SHADOW_QUOTE_PROOF_UNAVAILABLE/);
});

test('provider sponsor bytes are quote-only context; nonzero taker signature is rejected', () => {
  const tx = VersionedTransaction.deserialize(Buffer.from(raw().transaction, 'base64'));
  tx.signatures[0][0] = 1; // Fixture bytes, not a signature operation or validity proof.
  const sponsorContext = { ...raw(), transaction: Buffer.from(tx.serialize()).toString('base64') };
  assert.equal(shadowLiquidableValue(quote(sponsorContext), 1000, TEST_TAKER).networkFeeLamports, 0);
  tx.signatures[1][0] = 1;
  assert.throws(() => shadowLiquidableValue(quote({ ...raw(), transaction:
    Buffer.from(tx.serialize()).toString('base64') }), 1000, TEST_TAKER), /SHADOW_QUOTE_PROOF_UNAVAILABLE/);
});
