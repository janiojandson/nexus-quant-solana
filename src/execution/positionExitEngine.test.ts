import test from 'node:test';
import assert from 'node:assert';
import { PositionExitEngine } from './positionExitEngine.js';

test('PositionExitEngine: deve disparar TAKE_PROFIT quando ganho atingir +50%', () => {
  const engine = new PositionExitEngine();
  const mint = 'TokenTest111';

  engine.addPosition({
    mint,
    symbol: 'PEPE',
    tokenAmount: 100000,
    entryPriceUsd: 1.00,
    entryTimestamp: Date.now(),
    stopLossPct: -0.20, // -20%
    takeProfitPct: 0.50  // +50%
  });

  // Preço subiu para 1.55 (+55%)
  const signal = engine.evaluateExit(mint, 1.55);
  assert.strictEqual(signal.shouldExit, true);
  assert.strictEqual(signal.type, 'TAKE_PROFIT');
  assert.ok(signal.pnlPct >= 0.50);
});

test('PositionExitEngine: deve disparar STOP_LOSS quando perda atingir -20%', () => {
  const engine = new PositionExitEngine();
  const mint = 'TokenTest222';

  engine.addPosition({
    mint,
    symbol: 'DOGE',
    tokenAmount: 50000,
    entryPriceUsd: 2.00,
    entryTimestamp: Date.now(),
    stopLossPct: -0.20,
    takeProfitPct: 0.50
  });

  // Preço caiu para 1.50 (-25%)
  const signal = engine.evaluateExit(mint, 1.50);
  assert.strictEqual(signal.shouldExit, true);
  assert.strictEqual(signal.type, 'STOP_LOSS');
  assert.strictEqual(signal.pnlPct, -0.25);
});

test('PositionExitEngine: deve manter HOLD dentro da margem de oscilação normal', () => {
  const engine = new PositionExitEngine();
  const mint = 'TokenTest333';

  engine.addPosition({
    mint,
    symbol: 'WIF',
    tokenAmount: 200,
    entryPriceUsd: 10.0,
    entryTimestamp: Date.now(),
    stopLossPct: -0.20,
    takeProfitPct: 0.50
  });

  // Preço oscilou para 11.0 (+10%)
  const signal = engine.evaluateExit(mint, 11.0);
  assert.strictEqual(signal.shouldExit, false);
  assert.strictEqual(signal.type, 'HOLD');
});
