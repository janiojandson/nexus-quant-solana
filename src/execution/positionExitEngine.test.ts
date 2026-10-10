import test from 'node:test';
import assert from 'node:assert';
import { PositionExitEngine } from './positionExitEngine.js';

for (const [value, detail] of [[0.00047, 'SOLANA_SOL_DRAIN'], [0.01225, 'SOLANA_SOL_DRAIN'], [0.0153125, 'INITIAL_STOP_LOSS']] as const) {
  test(`PUMP regression: armed trailing must yield to loss at ${value} SOL`, () => {
    const engine = new PositionExitEngine();
    engine.addPosition({ mint: 'pump', symbol: 'PUMP', tokenAmount: 1000, entryPriceUsd: 1, entryTimestamp: Date.now(), entrySol: 0.0175 });
    engine.evaluateExitBySol('pump', 0.020766678);
    const signal = engine.evaluateExitBySol('pump', value);
    assert.strictEqual(signal.type, 'STOP_LOSS');
    assert.strictEqual(signal.reasonDetail, detail);
  });
}

test('liquidity collapse precedes armed trailing even at positive PnL', () => {
  const engine = new PositionExitEngine();
  engine.addPosition({ mint: 'drain', symbol: 'DRAIN', tokenAmount: 1000, entryPriceUsd: 1, entryTimestamp: Date.now(), entrySol: 1, entryLiquidityUsd: 50000 });
  engine.evaluateExitBySol('drain', 1.2);
  const signal = engine.evaluateExitBySol('drain', 1.1, Date.now(), { currentLiquidityUsd: 30000 });
  assert.strictEqual(signal.type, 'STOP_LOSS');
  assert.match(signal.reasonDetail || '', /LIQUIDITY_DRAIN/);
});

test('USD exit path classifies catastrophic loss', () => {
  const engine = new PositionExitEngine();
  engine.addPosition({ mint: 'usd', symbol: 'USD', tokenAmount: 100, entryPriceUsd: 1, entryTimestamp: Date.now() });
  assert.strictEqual(engine.evaluateExit('usd', 0.7).reasonDetail, 'SOLANA_SOL_DRAIN');
});

test('USD catastrophic boundary handles decimal prices independently of a looser stop', () => {
  const engine = new PositionExitEngine();
  engine.addPosition({ mint: 'decimal', symbol: 'DEC', tokenAmount: 100, entryPriceUsd: 0.015, entryTimestamp: Date.now(), stopLossPct: -0.5 });
  const signal = engine.evaluateExit('decimal', 0.0105);
  assert.strictEqual(signal.type, 'STOP_LOSS');
  assert.strictEqual(signal.reasonDetail, 'SOLANA_SOL_DRAIN');
});

test('PositionExitEngine: parcial só altera estado depois da confirmação do swap', () => {
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
  assert.strictEqual(eval1.exitTokenAmount, 741);
  assert.strictEqual(eval1.shouldCloseAta, false);

  let pos = engine.getPosition(mint);
  assert.notStrictEqual(pos?.partialTaken, true, 'sinal não pode fingir venda antes da confirmação');
  assert.strictEqual(pos?.tokenAmount, 1000);

  assert.strictEqual(engine.commitPartialExit(mint, 741, 0.02025), true);
  pos = engine.getPosition(mint);
  assert.strictEqual(pos?.partialTaken, true);
  assert.strictEqual(pos?.tokenAmount, 259);
  assert.strictEqual(pos?.entrySol, 0.003885);
  assert.strictEqual(pos?.stopLossPct, 0);
});

test('confirmed physical reservoir drain exits fully while unknown reserve does not invent drain', () => {
  const engine = new PositionExitEngine();
  engine.addPosition({ mint: 'physical', symbol: 'PHY', tokenAmount: 1000,
    entryPriceUsd: 1, entryTimestamp: Date.now(), entrySol: 1 });
  assert.equal(engine.evaluateExitBySol('physical', 1.1, Date.now(), {}).shouldExit, false);
  const drain = engine.evaluateExitBySol('physical', 1.1, Date.now(),
    { physicalReservoirDrained: true });
  assert.equal(drain.shouldExit, true);
  assert.equal(drain.type, 'STOP_LOSS');
  assert.equal(drain.exitTokenAmount, 1000);
  assert.match(drain.reasonDetail || '', /PHYSICAL_RESERVOIR_DRAIN/);
});

test('TP1 triggers at exactly 35%, sells the atomic ceiling of principal recovery, and leaves pre-TP2 runner untrailed', () => {
  const engine = new PositionExitEngine();
  engine.addPosition({ mint: 'exact', symbol: 'EXACT', tokenAmount: 1000,
    entryPriceUsd: 1, entryTimestamp: Date.now(), entrySol: 1 });
  assert.equal(engine.evaluateExitBySol('exact', 1.349999).shouldExit, false);
  const signal = engine.evaluateExitBySol('exact', 1.35);
  assert.equal(signal.exitTokenAmount, 741); // ceil(1000 * 20/27)
  assert.equal(signal.type, 'PARTIAL_TAKE_PROFIT_50');
  engine.commitPartialExit('exact', 741, 1.35);
  const remaining = engine.getPosition('exact')!;
  assert.equal(remaining.highestTpStepReached, 1);
  assert.equal(remaining.stopLossPct, 0);
  assert.equal(engine.evaluateExitBySol('exact', 0.34).type, 'HOLD');
});

test('TP2 sells half the remaining atomic amount; only the moonbag then trails 10%', () => {
  const engine = new PositionExitEngine();
  engine.addPosition({ mint: 'moon', symbol: 'MOON', tokenAmount: 1000,
    entryPriceUsd: 1, entryTimestamp: Date.now(), entrySol: 1 });
  engine.evaluateExitBySol('moon', 1.35);
  engine.commitPartialExit('moon', 741, 1.35);
  const tp2 = engine.evaluateExitBySol('moon', 0.518);
  assert.equal(tp2.exitTokenAmount, 130); // ceil(259/2)
  engine.commitPartialExit('moon', 130, 0.518);
  assert.equal(engine.getPosition('moon')?.tokenAmount, 129);
  const held = engine.evaluateExitBySol('moon', 0.30);
  assert.equal(held.type, 'HOLD');
  const trail = engine.evaluateExitBySol('moon', 0.22);
  assert.equal(trail.type, 'TRAILING_STOP');
});

test('pre-TP1 +12% peak retains the initial -12.5% stop', () => {
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
  assert.strictEqual(pos?.stopLossPct, -0.125);

  // Breakeven crossed: stop loss now has priority over the armed trailing.
  const evalRecuo = engine.evaluateExitBySol(mint, 0.01507);
  assert.strictEqual(evalRecuo.shouldExit, false);
});

test('trailing 10% activates only after TP2', () => {
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

  const partial = engine.evaluateExitBySol(mint, 0.02025); // Sinaliza parcial de +35%
  engine.commitPartialExit(mint, partial.exitTokenAmount || 500, 0.02025);
  const tp2 = engine.evaluateExitBySol(mint, 0.008);
  engine.commitPartialExit(mint, tp2.exitTokenAmount || 1, 0.008);
  engine.evaluateExitBySol(mint, 0.010);
  const evalTrailing = engine.evaluateExitBySol(mint, 0.0089);
  assert.strictEqual(evalTrailing.shouldExit, true);
  assert.strictEqual(evalTrailing.type, 'TRAILING_STOP');
  assert.strictEqual(evalTrailing.shouldCloseAta, true);
});

test('PositionExitEngine: deve disparar STOP_LOSS inicial a -12.5% antes da parcial e fechar ATA', () => {
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

  // 0.015 SOL spent: the -12.5% trigger is 0.013125 SOL in executable value.
  assert.strictEqual(engine.evaluateExitBySol(mint, 0.013875).shouldExit, false, '-7.5% is above the new initial stop');
  const evalStop = engine.evaluateExitBySol(mint, 0.013125);
  assert.strictEqual(evalStop.shouldExit, true);
  assert.strictEqual(evalStop.type, 'STOP_LOSS');
  assert.strictEqual(evalStop.shouldCloseAta, true);
});

test('PositionExitEngine: deve disparar TIME_STOP apos 10 minutos de estagnacao com PnL negativo e fechar ATA', () => {
  const engine = new PositionExitEngine();
  const mint = 'TestTimeStop';
  const now = Date.now();
  engine.addPosition({
    mint,
    symbol: 'TEST',
    tokenAmount: 1000,
    entryPriceUsd: 1.0,
    entryTimestamp: now - (11 * 60 * 1000),
    entrySol: 0.015,
    entryVolume5m: 1000
  });

  // PnL = -4% (< -3%), volume estagnado -> deve encerrar aos 10min
  const evalTime = engine.evaluateExitBySol(mint, 0.0144, now, {
    currentVolume5m: 1000
  });
  assert.strictEqual(evalTime.shouldExit, true);
  assert.strictEqual(evalTime.type, 'TIME_STOP');
  assert.strictEqual(evalTime.shouldCloseAta, true);
});

test('PositionExitEngine: deve estender TIME_STOP para 25min quando PnL > 0% apos 8min', () => {
  const engine = new PositionExitEngine();
  const mint = 'TestTimeStopExtended';
  const now = Date.now();
  engine.addPosition({
    mint,
    symbol: 'TEST',
    tokenAmount: 1000,
    entryPriceUsd: 1.0,
    entryTimestamp: now - (12 * 60 * 1000),
    entrySol: 0.015,
    entryVolume5m: 1000
  });

  // PnL = +5% (> 0%), deve NÃO encerrar aos 12min (estendido para 25min)
  const evalHold = engine.evaluateExitBySol(mint, 0.01575, now, {
    currentVolume5m: 1500
  });
  assert.strictEqual(evalHold.shouldExit, false);
  assert.strictEqual(evalHold.type, 'HOLD');

  // Mas deve encerrar aos 26min
  const evalTimeout = engine.evaluateExitBySol(mint, 0.01575, now + (14 * 60 * 1000));
  assert.strictEqual(evalTimeout.shouldExit, true);
  assert.strictEqual(evalTimeout.type, 'TIME_STOP');
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

test('PositionExitEngine (Sentinela Solana): deve disparar saida de emergencia por Alerta de Drenagem de Liquidez (> 30%)', () => {
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
  assert.ok(evalDrain.reasonDetail?.includes('SOLANA_LIQUIDITY_DRAIN'));
});

test('PositionExitEngine (Sentinela Solana): deve disparar TIME_STOP Dinamico apos 5min com volume estagnado e PnL entre -5% e -10%', () => {
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
  assert.ok(evalDynamic.reasonDetail?.includes('SOLANA_DYNAMIC_TIME_STOP'));
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
  assert.strictEqual(statusPre, 'Stop Ativo: Piso Fixo (-20.00%) | Trailing: INATIVO');

  // Sinaliza e confirma parcial em +100%
  const partial = engine.evaluateExitBySol(mint, 0.030);
  engine.commitPartialExit(mint, partial.exitTokenAmount || 500, 0.030);

  // TP1 keeps trailing inactive; TP2 arms it.
  const statusPost = engine.getStopStatusText(mint);
  assert.ok(statusPost.includes('Trailing: INATIVO'));
});

test('PositionExitEngine (Watchdog): deve emitir aviso em 5 falhas e disparar contingência em 8 falhas', () => {
  const engine = new PositionExitEngine();
  const mint = 'WatchdogTestMint';

  engine.addPosition({
    mint,
    symbol: 'WATCHDOG',
    tokenAmount: 1000,
    entryPriceUsd: 0.001,
    entryTimestamp: Date.now()
  });

  // 1 a 4 falhas: sem aviso nem emergência
  for (let i = 1; i <= 4; i++) {
    const res = engine.recordQuoteFailure(mint);
    assert.strictEqual(res.failures, i);
    assert.strictEqual(res.shouldWarn, false);
    assert.strictEqual(res.shouldEmergencyExit, false);
  }

  // 5 falhas: emite aviso
  const res5 = engine.recordQuoteFailure(mint);
  assert.strictEqual(res5.failures, 5);
  assert.strictEqual(res5.shouldWarn, true);
  assert.strictEqual(res5.shouldEmergencyExit, false);

  // 6 e 7 falhas: continua aviso
  engine.recordQuoteFailure(mint); // 6
  engine.recordQuoteFailure(mint); // 7

  // 8 falhas: dispara saída de emergência
  const res8 = engine.recordQuoteFailure(mint);
  assert.strictEqual(res8.failures, 8);
  assert.strictEqual(res8.shouldEmergencyExit, true);

  // Se cotação suceder, zera o contador
  engine.recordQuoteSuccess(mint);
  assert.strictEqual(engine.getQuoteFailures(mint), 0);
});


test('pre-TP1 momentum does not activate a conflicting early trailing stop', () => {
  const engine = new PositionExitEngine();
  const mint = 'EarlyMomentumTrailing';
  engine.addPosition({
    mint,
    symbol: 'MOMO',
    tokenAmount: 1000,
    entryPriceUsd: 1,
    entryTimestamp: Date.now(),
    entrySol: 0.015
  });

  const peak = engine.evaluateExitBySol(mint, 0.0165); // +10%
  assert.strictEqual(peak.shouldExit, false);

  const reversal = engine.evaluateExitBySol(mint, 0.01545); // +3%, abaixo do trailing de 6% do topo
  assert.strictEqual(reversal.shouldExit, false);
});


test('PositionExitEngine: deve reidratar watermark persistido do trailing após restart', () => {
  const engine = new PositionExitEngine();
  const mint = 'PersistedRunnerPeak';
  engine.addPosition({
    mint,
    symbol: 'RUNNER',
    tokenAmount: 500,
    entryPriceUsd: 1,
    entryTimestamp: Date.now(),
    entrySol: 0.015,
    partialTaken: true,
    highestTpStepReached: 2,
    peakSolValue: 0.030
  });

  assert.strictEqual(engine.getPeakSolValue(mint), 0.030);

  // O pico persistido mantém o trailing em 0.027 SOL mesmo depois do restart.
  const signal = engine.evaluateExitBySol(mint, 0.0269);
  assert.strictEqual(signal.shouldExit, true);
  assert.strictEqual(signal.type, 'TRAILING_STOP');
  assert.ok((signal.trailingStopSolValue || 0) >= 0.027 - 1e-12);
});


test('PositionExitEngine: separa pico observado do executável e outage Jupiter não apaga watermarks', () => {
  const engine = new PositionExitEngine();
  const mint = 'SovereignWatermark';
  engine.addPosition({
    mint,
    symbol: 'SOV',
    tokenAmount: 1000,
    entryPriceUsd: 1,
    entryTimestamp: Date.now(),
    entrySol: 0.015
  });

  engine.recordExitRouteObservation(mint, {
    observableSolValue: 0.040,
    executableSolValue: 0.030,
    jupiterExecutableSolValue: 0.030,
    healthyAtMs: 1000
  });

  engine.recordExitRouteObservation(mint, {
    observableSolValue: 0.050
  });

  const beforeFailure = engine.getExitWatermarks(mint);
  assert.strictEqual(beforeFailure.observablePeakSolValue, 0.050);
  assert.strictEqual(beforeFailure.executablePeakSolValue, 0.030);
  assert.strictEqual(beforeFailure.lastJupiterExecutableSolValue, 0.030);
  assert.strictEqual(beforeFailure.lastHealthyExitRouteAt, 1000);
  assert.strictEqual(engine.getPeakSolValue(mint), 0.030);

  engine.recordQuoteFailure(mint);

  assert.deepStrictEqual(engine.getExitWatermarks(mint), beforeFailure);

  engine.recordExitRouteObservation(mint, {
    executableSolValue: 0.025,
    jupiterExecutableSolValue: 0.025,
    healthyAtMs: 2000
  });

  const afterRecovery = engine.getExitWatermarks(mint);
  assert.strictEqual(afterRecovery.observablePeakSolValue, 0.050);
  assert.strictEqual(afterRecovery.executablePeakSolValue, 0.030);
  assert.strictEqual(afterRecovery.lastJupiterExecutableSolValue, 0.025);
  assert.strictEqual(afterRecovery.lastHealthyExitRouteAt, 2000);
  assert.strictEqual(engine.getPeakSolValue(mint), 0.030);
});

test('Tesla: restored runner gap closes entire position at observed executable value', () => {
 const engine = new PositionExitEngine();
 engine.addPosition({mint:'TeslaGap',symbol:'TESLA',tokenAmount:2187913065,entryPriceUsd:1,entryTimestamp:Date.now(),
 entrySol:0.01,partialTaken:true,executablePeakSolValue:0.047647,peakSolValue:0.047647});
 const signal=engine.evaluateExitBySol('TeslaGap',0.000041149);
 assert.strictEqual(signal.type,'STOP_LOSS');
 assert.strictEqual(signal.reasonDetail,'SOLANA_SOL_DRAIN');
 assert.strictEqual(signal.exitTokenAmount,2187913065);
 assert.strictEqual(signal.currentPriceUsd,0.000041149);
});
test('partial confirmation preserves proportional executable high-water mark',()=>{
 const engine = new PositionExitEngine();
 engine.addPosition({mint:'Peak',symbol:'PEAK',tokenAmount:1000,entryPriceUsd:1,entryTimestamp:Date.now(),entrySol:0.02});
 engine.evaluateExitBySol('Peak',0.04);
 assert.strictEqual(engine.commitPartialExit('Peak',500,0.03),true);
 assert.strictEqual(engine.getPosition('Peak')?.executablePeakSolValue,0.02);
 assert.strictEqual(engine.evaluateExitBySol('Peak',0.015).type,'HOLD');
});
test('full protective exits precede profit partials after a pullback or liquidity drain',()=>{
 for (const kind of ['pullback','drain']) {
 const engine = new PositionExitEngine();
 engine.addPosition({mint:kind,symbol:kind,tokenAmount:1000,entryPriceUsd:1,entryTimestamp:Date.now(),entrySol:0.02,entryLiquidityUsd:1000});
 if(kind==='pullback')engine.evaluateExitBySol(kind,0.04);
 const signal=engine.evaluateExitBySol(kind,0.03,Date.now(),{currentLiquidityUsd:kind==='drain'?500:1000});
 if (kind === 'drain') { assert.strictEqual(signal.shouldExit,true);assert.strictEqual(signal.exitTokenAmount,1000);
   assert.notStrictEqual(signal.type,'PARTIAL_TAKE_PROFIT_50'); }
 else { assert.strictEqual(signal.type, 'PARTIAL_TAKE_PROFIT_50'); }
 }
});

test('4D ladder recovers nominal principal then halves remaining, with no TP3 liquidation', () => {
  const engine = new PositionExitEngine();
  const mint = 'LadderMint4D';
  engine.addPosition({
    mint,
    symbol: 'LADDER',
    tokenAmount: 1000,
    entryPriceUsd: 1.0,
    entryTimestamp: Date.now(),
    entrySol: 0.015
  });

  // Degrau 1: +35% -> Vende 50% do total (500 tokens)
  const tp1 = engine.evaluateExitBySol(mint, 0.02025);
  assert.strictEqual(tp1.shouldExit, true);
  assert.strictEqual(tp1.type, 'PARTIAL_TAKE_PROFIT_50');
  assert.strictEqual(tp1.exitTokenAmount, 741);
  assert.strictEqual(tp1.shouldCloseAta, false);
  assert.ok(tp1.reasonDetail?.includes('TP_LADDER_STEP_1_35PCT'));
  engine.commitPartialExit(mint, 741, 0.02025);

  let pos = engine.getPosition(mint);
  assert.strictEqual(pos?.highestTpStepReached, 1);
  assert.strictEqual(pos?.tokenAmount, 259);
  assert.strictEqual(pos?.stopLossPct, 0);

  // Degrau 2: +100% -> Vende 50% do saldo restante (50% de 500 = 250 tokens)
  const tp2 = engine.evaluateExitBySol(mint, 0.008); // PnL > +100% sobre custo restante
  assert.strictEqual(tp2.shouldExit, true);
  assert.strictEqual(tp2.type, 'PARTIAL_TAKE_PROFIT_50');
  assert.strictEqual(tp2.exitTokenAmount, 130);
  assert.strictEqual(tp2.shouldCloseAta, false);
  assert.ok(tp2.reasonDetail?.includes('TP_LADDER_STEP_2_100PCT'));
  engine.commitPartialExit(mint, 130, 0.008);

  pos = engine.getPosition(mint);
  assert.strictEqual(pos?.highestTpStepReached, 2);
  assert.strictEqual(pos?.tokenAmount, 129);

  // Degrau 3: +300% -> Vende 100% (250 tokens) e fecha ATA (Hard Cap / Rug Prevention)
  const moonbag = engine.evaluateExitBySol(mint, 0.0155);
  assert.strictEqual(moonbag.shouldExit, false);
});

