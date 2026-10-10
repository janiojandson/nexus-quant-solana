import assert from 'node:assert/strict';
import test from 'node:test';
import { PositionExitEngine } from './positionExitEngine.js';
import { PUMP_SWAP_PROGRAM } from '../pump/confirmedPoolReader.js';

const now = Date.now();
const mint = 'token';
const pool = (sol: string, tokens = '100000') => ({
  kind: 'PHYSICAL_POOL_CONFIRMED', venue: 'PumpSwap', programId: PUMP_SWAP_PROGRAM.toBase58(),
  poolAddress: 'same-pool', baseMint: mint, quoteMint: 'So11111111111111111111111111111111111111112',
  baseVault: 'token-vault', quoteVault: 'sol-vault', slot: 123, observedAt: new Date(now).toISOString(),
  physicalSolLamports: sol, tokenReserveAtomic: tokens, poolCreatedAt: null
});
function engine(step = 0) {
  const result = new PositionExitEngine();
  result.addPosition({ mint, symbol: 'REAL', tokenAmount: 1000, entrySol: 1,
    entrySolValue: 1, entryPriceUsd: 1, entryTimestamp: now, accountingMode: 'SHADOW',
    entryPairAddress: 'same-pool', highestTpStepReached: step, stopLossPct: step ? 0 : -0.125 });
  return result;
}

test('gross spot -12.4% plus conservative net -12.9% holds before TP1', () => {
  const signal = engine().evaluateExitBySol(mint, 0.871, now,
    { initialGrossPoolEvidence: pool('87600000000') } as any);
  assert.equal(signal.shouldExit, false);
  assert.equal(signal.type, 'HOLD');
});

test('exact gross spot -12.5% stops the complete initial position before fees', () => {
  const signal = engine().evaluateExitBySol(mint, 0.9, now,
    { initialGrossPoolEvidence: pool('87500000000') } as any);
  assert.equal(signal.type, 'STOP_LOSS');
  assert.equal(signal.reasonDetail, 'INITIAL_STOP_LOSS');
  assert.equal(signal.exitTokenAmount, 1000);
});

test('initial stop compares rational integers without flooring a value above -12.5%', () => {
  const signal = engine().evaluateExitBySol(mint, 0.871, now,
    { initialGrossPoolEvidence: pool('87500000000001', '100000000') } as any);
  assert.equal(signal.type, 'HOLD'); // 875000000.00001 lamports: strictly above the boundary.
});

test('missing/stale/mismatched/nonpositive gross proof stays unknown even if net is deeply negative', () => {
  for (const proof of [null, { ...pool('87600000000'), poolAddress: 'other-pool' },
    { ...pool('87600000000'), baseMint: 'other-token' },
    { ...pool('87600000000'), observedAt: new Date(now - 15_001).toISOString() },
    { ...pool('87600000000'), physicalSolLamports: '0' },
    { ...pool('87600000000'), slot: 0 }]) {
    const signal = engine().evaluateExitBySol(mint, 0.65, now,
      { initialGrossPoolEvidence: proof } as any);
    assert.equal(signal.type, 'HOLD');
    assert.equal(signal.reasonDetail, 'GROSS_STOP_PROOF_UNAVAILABLE');
  }
});

test('physical floor and post-TP net protection still operate without gross proof', () => {
  assert.equal(engine().evaluateExitBySol(mint, 0.871, now,
    { physicalReservoirDrained: true }).exitTokenAmount, 1000);
  assert.equal(engine(1).evaluateExitBySol(mint, 0.99, now).type, 'STOP_LOSS');
  const runner = engine(2);
  runner.recordExitRouteObservation(mint, { executableSolValue: 2 });
  assert.equal(runner.evaluateExitBySol(mint, 1.8, now).type, 'TRAILING_STOP');
});

test('restart preserves pool identity and requires a fresh same-pool gross mark', () => {
  const restored = new PositionExitEngine();
  restored.addPosition(JSON.parse(JSON.stringify(engine().getPosition(mint))));
  assert.equal(restored.evaluateExitBySol(mint, 0.871, now,
    { initialGrossPoolEvidence: { ...pool('87500000000'), poolAddress: 'other-pool' } } as any).type, 'HOLD');
  assert.equal(restored.evaluateExitBySol(mint, 0.871, now,
    { initialGrossPoolEvidence: pool('87500000000') } as any).type, 'STOP_LOSS');
});

test('missing gross proof never blocks take-profit when the position is up', () => {
  const signal = engine().evaluateExitBySol(mint, 1.5, now, { initialGrossPoolEvidence: null });
  assert.equal(signal.shouldExit, true);
  assert.equal(signal.type, 'PARTIAL_TAKE_PROFIT_50');
});
