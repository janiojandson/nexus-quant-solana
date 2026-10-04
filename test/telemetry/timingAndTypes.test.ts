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
  escalateIntentSeverity
} from '../../src/types/telemetry';

test('Timing: monotonic clock helper deve calcular duração em ms corretamente', () => {
  const start = nowMonotonicNs();
  assert.equal(typeof start, 'bigint');

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

// ==========================================
// HARDENING 2: SEVERITY ESCALATION AUDIT TRAIL
// ==========================================

test('Hardening 2: economicDedupeKey permanece idêntico, initialSeverity imutável e currentSeverity muta com audit trail', () => {
  const intent: ExitIntent = {
    id: 'intent-uuid-1',
    tradeId: 'trade-uuid-1',
    positionId: 'pos-1',
    walletId: 'wallet-sol-1',
    mint: '3A75w27ssueStCEEp6KGxKJ3EtP57P9FxT6YxHmDnt7a',
    tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    positionVersion: 1,
    requestedAmountAtomic: '5000000000',
    amountPolicy: 'FULL_REMAINDER',
    economicDedupeKey: 'wallet-sol-1:3A75w27ssueStCEEp6KGxKJ3EtP57P9FxT6YxHmDnt7a:1:5000000000',
    initialSeverity: 'NORMAL',
    currentSeverity: 'NORMAL',
    severityAuditTrail: [],
    reason: 'TRAILING_STOP',
    policyVersion: '2.0.0',
    status: 'CREATED',
    createdAtWallMs: nowWallMs(),
    expiresAtWallMs: (Date.now() + 60_000) as WallMs
  };

  const originalDedupeKey = intent.economicDedupeKey;

  // Escalada 1: NORMAL -> HIGH
  const event1 = escalateIntentSeverity(intent, 'HIGH', 'TRAILING_STOP', 'obs-101');

  // Escalada 2: HIGH -> EMERGENCY
  const event2 = escalateIntentSeverity(intent, 'EMERGENCY', 'PANIC', 'obs-102');

  // 1. economicDedupeKey permanece 100% idêntico
  assert.equal(intent.economicDedupeKey, originalDedupeKey);

  // 2. initialSeverity permanece NORMAL
  assert.equal(intent.initialSeverity, 'NORMAL');

  // 3. currentSeverity agora é EMERGENCY
  assert.equal(intent.currentSeverity, 'EMERGENCY');

  // 4. Audit trail contém os dois eventos com rastreabilidade completa
  assert.equal(intent.severityAuditTrail.length, 2);
  assert.equal(intent.severityAuditTrail[0].fromSeverity, 'NORMAL');
  assert.equal(intent.severityAuditTrail[0].toSeverity, 'HIGH');
  assert.equal(intent.severityAuditTrail[0].reason, 'TRAILING_STOP');

  assert.equal(intent.severityAuditTrail[1].fromSeverity, 'HIGH');
  assert.equal(intent.severityAuditTrail[1].toSeverity, 'EMERGENCY');
  assert.equal(intent.severityAuditTrail[1].reason, 'PANIC');

  // 5. Duas escaladas podem ser ordenadas cronologicamente
  assert.ok(event2.changedAtMonoNs >= event1.changedAtMonoNs);
  assert.ok(event2.changedAtWallMs >= event1.changedAtWallMs);
});

test('Contratos Financeiros: TradeAccounting formal deve calcular retorno líquido e segregar aluguel', () => {
  const initialPrincipal = 20_000_000n;
  const entryFees = 5_000n;
  const confirmedGross = 13_533_348n;
  const confirmedTradingCosts = 15_000n;
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
    realizedPnLLamports: netRecovered - (initialPrincipal / 2n),
    tradeEquityPnLLamports: netRecovered - initialPrincipal,
    rentRecoveredLamports: rentRecovered
  };

  assert.equal(accounting.rentRecoveredLamports, 2_039_280n);
  assert.equal(accounting.netRecoveredLamports, 13_518_348n);
});
