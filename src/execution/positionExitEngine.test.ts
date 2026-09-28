import test from 'node:test';
import assert from 'node:assert';
import { PositionExitEngine } from './positionExitEngine.js';

test('PositionExitEngine: deve disparar PARTIAL_TAKE_PROFIT_50 a +100% (+1.0R / 2x) e mover SL para Breakeven', () => {
  const engine = new PositionExitEngine();
  const mint = 'TestMint1111111111111111111111111111111111';
  engine.addPosition({
    mint,
    symbol: 'TEST',
    tokenAmount: 1000,
    entryPriceUsd: 1.0,
    entryTimestamp: Date.now(),
    stopLossPct: -0.20,
    takeProfitPct: 1.0,
    entrySol: 0.015
  });

  const eval1 = engine.evaluateExitBySol(mint, 0.030);
  assert.strictEqual(eval1.shouldExit, true);
  assert.strictEqual(eval1.type, 'PARTIAL_TAKE_PROFIT_50');
  assert.strictEqual(eval1.exitTokenAmount, 500);
  assert.strictEqual(eval1.shouldCloseAta, false);

  const pos = engine.getPosition(mint);
  assert.strictEqual(pos?.partialTaken, true);
  assert.strictEqual(pos?.tokenAmount, 500);
  assert.strictEqual(pos?.stopLossPct, 0.0);
});

test('PositionExitEngine: pos-parcial, deve encerrar TRAILING_STOP se recuar 15% do topo maximo', () => {
  const engine = new PositionExitEngine();
  const mint = 'TestMintTrailing15';
  engine.addPosition({
    mint,
    symbol: 'TEST',
    tokenAmount: 1000,
    entryPriceUsd: 1.0,
    entryTimestamp: Date.now(),
    stopLossPct: -0.20,
    takeProfitPct: 1.0,
    entrySol: 0.015
  });

  engine.evaluateExitBySol(mint, 0.030);
  engine.evaluateExitBySol(mint, 0.040);
  const evalTrailing = engine.evaluateExitBySol(mint, 0.0335);
  assert.strictEqual(evalTrailing.shouldExit, true);
  assert.strictEqual(evalTrailing.type, 'TRAILING_STOP');
  assert.strictEqual(evalTrailing.shouldCloseAta, true);
});

test('PositionExitEngine: deve disparar STOP_LOSS inicial a -20% antes da parcial e fechar ATA', () => {
  const engine = new PositionExitEngine();
  const mint = 'TestStopLoss';
  engine.addPosition({
    mint,
    symbol: 'TEST',
    tokenAmount: 1000,
    entryPriceUsd: 1.0,
    entryTimestamp: Date.now(),
    stopLossPct: -0.20,
    takeProfitPct: 1.0,
    entrySol: 0.015
  });

  const evalStop = engine.evaluateExitBySol(mint, 0.0119);
  assert.strictEqual(evalStop.shouldExit, true);
  assert.strictEqual(evalStop.type, 'STOP_LOSS');
  assert.strictEqual(evalStop.shouldCloseAta, true);
});

test('PositionExitEngine: deve disparar TIME_STOP apos 15 minutos de estagnacao e fechar ATA', () => {
  const engine = new PositionExitEngine();
  const mint = 'TestTimeStop';
  const now = Date.now();
  engine.addPosition({
    mint,
    symbol: 'TEST',
    tokenAmount: 1000,
    entryPriceUsd: 1.0,
    entryTimestamp: now - (16 * 60 * 1000),
    stopLossPct: -0.20,
    takeProfitPct: 1.0,
    entrySol: 0.015
  });

  const evalTime = engine.evaluateExitBySol(mint, 0.015, now);
  assert.strictEqual(evalTime.shouldExit, true);
  assert.strictEqual(evalTime.type, 'TIME_STOP');
  assert.strictEqual(evalTime.shouldCloseAta, true);
});

test('PositionExitEngine: deve manter HOLD dentro da margem de oscilacao normal', () => {
  const engine = new PositionExitEngine();
  const mint = 'TestHold';
  engine.addPosition({
    mint,
    symbol: 'TEST',
    tokenAmount: 1000,
    entryPriceUsd: 1.0,
    entryTimestamp: Date.now(),
    stopLossPct: -0.20,
    takeProfitPct: 1.0,
    entrySol: 0.015
  });

  const evalHold = engine.evaluateExitBySol(mint, 0.016);
  assert.strictEqual(evalHold.shouldExit, false);
  assert.strictEqual(evalHold.type, 'HOLD');
});

test('PositionExitEngine (Ayla Sentinela): deve disparar saida de emergencia por Alerta de Drenagem de Liquidez (> 30%)', () => {
  const engine = new PositionExitEngine();
  const mint = 'TestDrainToken';
  engine.addPosition({
    mint,
    symbol: 'DRAIN',
    tokenAmount: 1000,
    entryPriceUsd: 1.0,
    entryTimestamp: Date.now(),
    stopLossPct: -0.20,
    takeProfitPct: 1.0,
    entrySol: 0.015,
    entryLiquidityUsd: 50000,
    entryVolume5m: 5000
  });

  // Liquidez caiu de $50k para $30k (40% de perda > 30%)
  const evalDrain = engine.evaluateExitBySol(mint, 0.0145, Date.now(), {
    currentLiquidityUsd: 30000,
    currentVolume5m: 5000
  });

  assert.strictEqual(evalDrain.shouldExit, true);
  assert.strictEqual(evalDrain.type, 'STOP_LOSS');
  assert.strictEqual(evalDrain.shouldCloseAta, true);
  assert.ok(evalDrain.reasonDetail?.includes('AYLA_LIQUIDITY_DRAIN'));
});

test('PositionExitEngine (Ayla Sentinela): deve disparar TIME_STOP Dinamico apos 5min com volume estagnado e PnL entre -5% e -10%', () => {
  const engine = new PositionExitEngine();
  const mint = 'TestAylaDynamicTimeStop';
  const now = Date.now();
  engine.addPosition({
    mint,
    symbol: 'STAGNANT',
    tokenAmount: 1000,
    entryPriceUsd: 1.0,
    entryTimestamp: now - (6 * 60 * 1000),
    stopLossPct: -0.20,
    takeProfitPct: 1.0,
    entrySol: 0.015,
    entryLiquidityUsd: 40000,
    entryVolume5m: 2000
  });

  const currentSol = 0.015 * (1 - 0.07);
  const evalDynamic = engine.evaluateExitBySol(mint, currentSol, now, {
    currentLiquidityUsd: 40000,
    currentVolume5m: 2050
  });

  assert.strictEqual(evalDynamic.shouldExit, true);
  assert.strictEqual(evalDynamic.type, 'TIME_STOP');
  assert.strictEqual(evalDynamic.shouldCloseAta, true);
  assert.ok(evalDynamic.reasonDetail?.includes('AYLA_DYNAMIC_TIME_STOP'));
});

test('PositionExitEngine: deve exibir explicitamente SL Fixo e Trailing INATIVO antes da parcial', () => {
  const engine = new PositionExitEngine();
  const mint = 'TestStopStatusText';
  engine.addPosition({
    mint,
    symbol: 'PEPE',
    tokenAmount: 1000,
    entryPriceUsd: 0.0005,
    entryTimestamp: Date.now(),
    stopLossPct: -0.20,
    takeProfitPct: 1.0,
    entrySol: 0.015
  });

  // Antes da parcial
  const statusPre = engine.getStopStatusText(mint);
  assert.strictEqual(statusPre, 'Stop Ativo: SL Fixo (-20.00%) | Trailing: INATIVO (Aguardando Parcial)');

  // Aciona parcial em +100%
  engine.evaluateExitBySol(mint, 0.030);

  // Pós-parcial
  const statusPost = engine.getStopStatusText(mint);
  assert.ok(statusPost.includes('Stop Ativo: Trailing Dinâmico (-15% do Topo:'));
});

