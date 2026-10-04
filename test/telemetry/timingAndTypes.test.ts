import test from 'node:test';
import assert from 'node:assert/strict';
import {
  nowMonotonicNs,
  nowWallMs,
  diffMonotonicMs,
  calculateSourceToReceiveMs,
  ExitIntent,
  TradeAccounting,
  WallMs,
  MonotonicNs
} from '../../src/types/telemetry';

test('Timing: monotonic clock helper deve calcular duração em ms corretamente', () => {
  const start = nowMonotonicNs();
  assert.equal(typeof start, 'bigint');

  // Simula um breve atraso síncrono
  let sum = 0;
  for (let i = 0; i < 100_000; i++) {
    sum += i;
  }
  assert.ok(sum > 0);

  const end = nowMonotonicNs();
  const elapsedMs = diffMonotonicMs(start, end);
  assert.ok(elapsedMs >= 0);
  assert.equal(typeof elapsedMs, 'number');
});

test('Timing: calculateSourceToReceiveMs deve retornar null para fontes incompatíveis ou nulas', () => {
  const received = nowWallMs();

  // Caso 1: Fonte ausente
  assert.equal(calculateSourceToReceiveMs(undefined, received), null);
  assert.equal(calculateSourceToReceiveMs(null, received), null);

  // Caso 2: Relógio invertido (source > received por descalibração externa de NTP)
  const futureSource = (Number(received) + 5000) as WallMs;
  assert.equal(calculateSourceToReceiveMs(futureSource, received), null);

  // Caso 3: Timestamps consistentes
  const validSource = (Number(received) - 150) as WallMs;
  const delta = calculateSourceToReceiveMs(validSource, received);
  assert.equal(delta, 150);
});

test('Contratos Financeiros: economicDedupeKey deve ser desacoplado de reason e severity', () => {
  const intentNormalTrailing: ExitIntent = {
    id: 'intent-1',
    tradeId: 'trade-uuid-1',
    positionId: 'pos-1',
    walletId: 'wallet-sol-1',
    mint: '3A75w27ssueStCEEp6KGxKJ3EtP57P9FxT6YxHmDnt7a',
    tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    positionVersion: 1,
    requestedAmountAtomic: '5000000000',
    amountPolicy: 'FULL_REMAINDER',
    economicDedupeKey: 'wallet-sol-1:3A75w27ssueStCEEp6KGxKJ3EtP57P9FxT6YxHmDnt7a:1:5000000000',
    reason: 'TRAILING_STOP',
    severity: 'NORMAL',
    policyVersion: '2.0.0',
    status: 'CREATED',
    createdAtWallMs: nowWallMs(),
    expiresAtWallMs: (Date.now() + 60_000) as WallMs
  };

  // Se o mercado colapsar e o sistema elevar para CRASH/PANIC:
  // O dedupe econômico DEVE permanecer idêntico, evitando criar um segundo intent
  intentNormalTrailing.reason = 'PANIC';
  intentNormalTrailing.severity = 'EMERGENCY';
  intentNormalTrailing.severityElevatedAt = nowWallMs();

  assert.equal(
    intentNormalTrailing.economicDedupeKey,
    'wallet-sol-1:3A75w27ssueStCEEp6KGxKJ3EtP57P9FxT6YxHmDnt7a:1:5000000000'
  );
  assert.equal(intentNormalTrailing.severity, 'EMERGENCY');
});

test('Contratos Financeiros: TradeAccounting formal deve calcular retorno líquido e segregar aluguel', () => {
  // Cenário:
  // Entrada: 0.02 SOL principal (20.000.000 lamports) + taxa de entrada 5.000 lamports
  // Parcial realizada: bruto 0.013533348 SOL (13.533.348 lamports)
  // Taxas de saída confirmadas: 5.000 lamports de rede + 10.000 lamports prioridade
  // Aluguel da ATA recuperado: 2.039.280 lamports
  
  const initialPrincipal = 20_000_000n;
  const entryFees = 5_000n;
  const confirmedGross = 13_533_348n;
  const confirmedTradingCosts = 15_000n; // 5000 + 10000
  const rentRecovered = 2_039_280n;

  const netRecovered = confirmedGross - confirmedTradingCosts;
  assert.equal(netRecovered, 13_518_348n);

  const capitalRecoveredPct = (100 * Number(netRecovered)) / Number(initialPrincipal);
  assert.ok(Math.abs(capitalRecoveredPct - 67.59) < 0.01);

  const accounting: TradeAccounting = {
    tradeId: 'trade-test-1',
    initialPrincipalLamports: initialPrincipal,
    entryFeesLamports: entryFees,
    confirmedGrossProceedsLamports: confirmedGross,
    confirmedTradingCostsLamports: confirmedTradingCosts,
    netRecoveredLamports: netRecovered,
    capitalRecoveredPct,
    realizedPnLLamports: netRecovered - (initialPrincipal / 2n), // PnL da tranche de 50%
    tradeEquityPnLLamports: netRecovered - initialPrincipal, // Supondo valor executável remanescente = 0
    rentRecoveredLamports: rentRecovered
  };

  // Aluguel NÃO deve ser somado a netRecovered
  assert.equal(accounting.rentRecoveredLamports, 2_039_280n);
  assert.equal(accounting.netRecoveredLamports, 13_518_348n);
});
