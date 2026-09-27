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

test('PositionExitEngine: deve disparar STOP_LOSS quando valor em SOL cair <= 80% do investido', () => {
  const engine = new PositionExitEngine();
  const mint = 'TokenSolStop';

  engine.addPosition({
    mint,
    symbol: 'MEME',
    tokenAmount: 10000,
    entryPriceUsd: 0.0001,
    entryTimestamp: Date.now(),
    stopLossPct: -0.20,
    takeProfitPct: 0.50,
    entrySol: 0.015 // 0.015 SOL investidos
  });

  // Se o valor de saída for 0.0119 SOL (~ -20.67%)
  const signal = engine.evaluateExitBySol(mint, 0.0119);
  assert.strictEqual(signal.shouldExit, true);
  assert.strictEqual(signal.type, 'STOP_LOSS');
  assert.ok(signal.pnlPct <= -0.20);
});

test('PositionExitEngine: deve disparar TAKE_PROFIT quando valor em SOL atingir >= 150% do investido', () => {
  const engine = new PositionExitEngine();
  const mint = 'TokenSolTP';

  engine.addPosition({
    mint,
    symbol: 'MEME2',
    tokenAmount: 10000,
    entryPriceUsd: 0.0001,
    entryTimestamp: Date.now(),
    stopLossPct: -0.20,
    takeProfitPct: 0.50,
    entrySol: 0.015
  });

  // Se o valor de saída for 0.023 SOL (+53.3%)
  const signal = engine.evaluateExitBySol(mint, 0.023);
  assert.strictEqual(signal.shouldExit, true);
  assert.strictEqual(signal.type, 'TAKE_PROFIT');
  assert.ok(signal.pnlPct >= 0.50);
});

test('PositionExitEngine: deve disparar TIME_STOP após 15 minutos de estagnação', () => {
  const engine = new PositionExitEngine();
  const mint = 'TokenStagnant';
  const entryTime = Date.now() - (16 * 60 * 1000); // Entrou há 16 minutos

  engine.addPosition({
    mint,
    symbol: 'STAG',
    tokenAmount: 5000,
    entryPriceUsd: 0.001,
    entryTimestamp: entryTime,
    stopLossPct: -0.20,
    takeProfitPct: 0.50,
    entrySol: 0.015
  });

  // Preço quase inalterado (+2%), mas tempo estourou 15 min
  const signal = engine.evaluateExitBySol(mint, 0.0153, Date.now());
  assert.strictEqual(signal.shouldExit, true);
  assert.strictEqual(signal.type, 'TIME_STOP');
});

