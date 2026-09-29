import test from 'node:test';
import assert from 'node:assert';
import { DrawdownBreaker } from './drawdownBreaker.js';

test('DrawdownBreaker: deve permitir trades quando PnL diário está acima dos limiares', () => {
  const breaker = new DrawdownBreaker();
  assert.strictEqual(breaker.canOpenNewPosition(), true);
  assert.strictEqual(breaker.getTier(), 'ACTIVE');
});

test('DrawdownBreaker: Tier 1 deve pausar por 4h ao atingir -0.02 SOL', () => {
  const breaker = new DrawdownBreaker();
  const now = Date.now();

  breaker.recordTradeResult(-0.01, now);
  assert.strictEqual(breaker.canOpenNewPosition(now), true);

  breaker.recordTradeResult(-0.01, now); // Total: -0.02 SOL
  assert.strictEqual(breaker.canOpenNewPosition(now), false);
  assert.strictEqual(breaker.getTier(), 'PAUSED_DRAWDOWN_TIER1');

  // Após 4h deve liberar
  const after4h = now + 4 * 60 * 60 * 1000 + 1;
  assert.strictEqual(breaker.canOpenNewPosition(after4h), true);
});

test('DrawdownBreaker: Tier 2 deve pausar até meia-noite UTC ao atingir -0.04 SOL', () => {
  const breaker = new DrawdownBreaker();
  const now = Date.now();

  breaker.recordTradeResult(-0.04, now);
  assert.strictEqual(breaker.canOpenNewPosition(now), false);
  assert.strictEqual(breaker.getTier(), 'PAUSED_DRAWDOWN_TIER2');

  const state = breaker.getState(now);
  assert.strictEqual(state.dailyPnlSol, -0.04);
  assert.strictEqual(state.dailyTradeCount, 1);
  assert.ok(state.pausedUntil !== null);
});

test('DrawdownBreaker: deve resetar automaticamente na virada de dia UTC', () => {
  const breaker = new DrawdownBreaker();
  const now = Date.now();

  breaker.recordTradeResult(-0.03, now);
  assert.strictEqual(breaker.canOpenNewPosition(now), false);

  // Simula virada de dia: adiciona 25 horas para garantir dia diferente
  const nextDay = now + 25 * 60 * 60 * 1000;
  assert.strictEqual(breaker.canOpenNewPosition(nextDay), true);
  assert.strictEqual(breaker.getTier(), 'ACTIVE');

  const state = breaker.getState(nextDay);
  assert.strictEqual(state.dailyPnlSol, 0);
  assert.strictEqual(state.dailyTradeCount, 0);
});

test('DrawdownBreaker: trades positivos devem registrar sem acionar pausa', () => {
  const breaker = new DrawdownBreaker();
  const now = Date.now();

  breaker.recordTradeResult(0.01, now);
  breaker.recordTradeResult(0.02, now);
  assert.strictEqual(breaker.canOpenNewPosition(now), true);

  const state = breaker.getState(now);
  assert.strictEqual(state.dailyPnlSol, 0.03);
  assert.strictEqual(state.dailyTradeCount, 2);
});
