import test from 'node:test';
import assert from 'node:assert';
import { PositionExitEngine } from './positionExitEngine.js';

test('PositionExitEngine: deve disparar PARTIAL_TAKE_PROFIT_50 a +35% e mover SL para Breakeven', () => {
  const engine = new PositionExitEngine();
  const mint = 'TestMint1111111111111111111111111111111111';
  engine.addPosition({
    mint,
    symbol: 'TEST',
    tokenAmount: 1000,
    entryPriceUsd: 1.0,
    entryTimestamp: Date.now(),
    entrySol: 0.015
  });

  const eval1 = engine.evaluateExitBySol(mint, 0.02025); // +35%
  assert.strictEqual(eval1.shouldExit, true);
  assert.strictEqual(eval1.type, 'PARTIAL_TAKE_PROFIT_50');
  assert.strictEqual(eval1.exitTokenAmount, 500);
  assert.strictEqual(eval1.shouldCloseAta, false);

  const pos = engine.getPosition(mint);
  assert.strictEqual(pos?.partialTaken, true);
  assert.strictEqual(pos?.tokenAmount, 500);
  assert.strictEqual(pos?.stopLossPct, 0.01); // Breakeven (+1%)
});

test('PositionExitEngine: deve mover SL para Breakeven (+1%) ao atingir +12% de pico pré-parcial', () => {
  const engine = new PositionExitEngine();
  const mint = 'TestBreakevenTrigger';
  engine.addPosition({
    mint,
    symbol: 'TEST',
    tokenAmount: 1000,
    entryPriceUsd: 1.0,
    entryTimestamp: Date.now(),
    entrySol: 0.015
  });

  // Sobe para +12%
  engine.evaluateExitBySol(mint, 0.0168);
  const pos = engine.getPosition(mint);
  assert.strictEqual(pos?.stopLossPct, 0.01, 'Stop deve subir para +1% ao atingir +12%');

  // Recua para +0.5% (abaixo de +1%), deve acionar stop loss de breakeven
  const evalRecuo = engine.evaluateExitBySol(mint, 0.01507);
  assert.strictEqual(evalRecuo.shouldExit, true);
  assert.strictEqual(evalRecuo.type, 'STOP_LOSS');
  assert.strictEqual(evalRecuo.shouldCloseAta, true);
});

test('PositionExitEngine: pos-parcial, deve encerrar TRAILING_STOP se recuar 10% do topo maximo', () => {
  const engine = new PositionExitEngine();
  const mint = 'TestMintTrailing10';
  engine.addPosition({
    mint,
    symbol: 'TEST',
    tokenAmount: 1000,
    entryPriceUsd: 1.0,
    entryTimestamp: Date.now(),
    entrySol: 0.015
  });

  engine.evaluateExitBySol(mint, 0.02025); // Aciona parcial de +35%
  engine.evaluateExitBySol(mint, 0.030);   // Pico sobe para 0.030 SOL
  // Stop trailing a -10% de 0.030 = 0.027
  const evalTrailing = engine.evaluateExitBySol(mint, 0.0269);
  assert.strictEqual(evalTrailing.shouldExit, true);
  assert.strictEqual(evalTrailing.type, 'TRAILING_STOP');
  assert.strictEqual(evalTrailing.shouldCloseAta, true);
});

test('PositionExitEngine: deve disparar STOP_LOSS inicial a -8% antes da parcial e fechar ATA', () => {
  const engine = new PositionExitEngine();
  const mint = 'TestStopLoss';
  engine.addPosition({
    mint,
    symbol: 'TEST',
    tokenAmount: 1000,
    entryPriceUsd: 1.0,
    entryTimestamp: Date.now(),
    entrySol: 0.015
  });

  // -8% de 0.015 = 0.0138 SOL. 0.0137 dispara Stop Loss
  const evalStop = engine.evaluateExitBySol(mint, 0.0137);
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
  assert.ok(statusPost.includes('Stop Ativo: Trailing Dinâmico (-10% do Topo:'));
});

