import test from 'node:test';
import * as assert from 'node:assert/strict';
import {
  evaluateReconciliationState,
  isVerdictTerminal,
  OnChainReconciliationEvidence
} from '../../src/journal/reconciliation';
import { ExecutionAttempt } from '../../src/journal/types';

function createMockAttempt(overrides: Partial<ExecutionAttempt> = {}): ExecutionAttempt {
  return {
    attemptId: 'att_test_123' as any,
    intentId: 'intent_test_123' as any,
    provider: 'JUPITER_V2',
    requestedAmountAtomic: '5000000000',
    state: 'INITIALIZED',
    startedAtWallMs: 1_000_000 as any,
    ...overrides
  };
}

test('Nexus V2.1A — Reconciliation State Machine Pure Evaluator (C3)', async (t) => {
  // 1. INITIALIZED e ORDER_READY -> CAN_RETRY
  await t.test('1. tentativa INITIALIZED ou ORDER_READY sem envio on-chain retorna CAN_RETRY', () => {
    const attemptInit = createMockAttempt({ state: 'INITIALIZED' });
    const resInit = evaluateReconciliationState(attemptInit);
    assert.strictEqual(resInit.verdict, 'CAN_RETRY');
    assert.strictEqual(resInit.canRetry, true);
    assert.strictEqual(resInit.isTerminal, false);
    assert.strictEqual(resInit.requiresReconciliation, false);

    const attemptReady = createMockAttempt({ state: 'ORDER_READY' });
    const resReady = evaluateReconciliationState(attemptReady);
    assert.strictEqual(resReady.verdict, 'CAN_RETRY');
    assert.strictEqual(resReady.canRetry, true);
  });

  // 2. SIGNED sem evidência -> MUST_RECONCILE
  await t.test('2. tentativa SIGNED sem evidência exige reconciliação (MUST_RECONCILE)', () => {
    const attempt = createMockAttempt({
      state: 'SIGNED',
      signature: '5nwz7eVDSU4MnT3zzmXyP9kg6w1Uo99GDz8qiZtMkcqUebeLgLbXFMtPpgpZtZ36estEnFhS43JyoYGoKp5xHyTN' as any
    });
    const res = evaluateReconciliationState(attempt);
    assert.strictEqual(res.verdict, 'MUST_RECONCILE');
    assert.strictEqual(res.canRetry, false);
    assert.strictEqual(res.requiresReconciliation, true);
    assert.strictEqual(res.isTerminal, false);
  });

  // 3. SUBMITTED com signatureFound = true e err = null -> CONFIRMED
  await t.test('3. tentativa SUBMITTED encontrada com sucesso na blockchain retorna CONFIRMED', () => {
    const attempt = createMockAttempt({
      state: 'SUBMITTED',
      signature: '5nwz7eVDSU4MnT3zzmXyP9kg6w1Uo99GDz8qiZtMkcqUebeLgLbXFMtPpgpZtZ36estEnFhS43JyoYGoKp5xHyTN' as any
    });
    const evidence: OnChainReconciliationEvidence = {
      signatureFound: true,
      err: null,
      slot: 452790100,
      confirmationStatus: 'confirmed'
    };
    const res = evaluateReconciliationState(attempt, evidence);
    assert.strictEqual(res.verdict, 'CONFIRMED');
    assert.strictEqual(res.isTerminal, true);
    assert.strictEqual(res.canRetry, false);
    assert.strictEqual(res.onChainStatus, 'CONFIRMED');
  });

  // 4. SUBMITTED com signatureFound = true e err != null -> FAILED_DEFINITIVE
  await t.test('4. tentativa SUBMITTED que pousou on-chain com erro de instrução retorna FAILED_DEFINITIVE', () => {
    const attempt = createMockAttempt({
      state: 'SUBMITTED',
      signature: '5nwz7eVDSU4MnT3zzmXyP9kg6w1Uo99GDz8qiZtMkcqUebeLgLbXFMtPpgpZtZ36estEnFhS43JyoYGoKp5xHyTN' as any
    });
    const evidence: OnChainReconciliationEvidence = {
      signatureFound: true,
      err: { InstructionError: [2, { Custom: 6001 }] },
      slot: 452790105
    };
    const res = evaluateReconciliationState(attempt, evidence);
    assert.strictEqual(res.verdict, 'FAILED_DEFINITIVE');
    assert.strictEqual(res.isTerminal, true);
    assert.strictEqual(res.canRetry, true);
    assert.strictEqual(res.onChainStatus, 'FAILED');
  });

  // 5. SUBMITTED com signatureFound = false e blockhashExpired = true -> FAILED_DEFINITIVE
  await t.test('5. tentativa SUBMITTED não encontrada com blockhash expirado retorna FAILED_DEFINITIVE', () => {
    const attempt = createMockAttempt({
      state: 'SUBMITTED',
      signature: '5nwz7eVDSU4MnT3zzmXyP9kg6w1Uo99GDz8qiZtMkcqUebeLgLbXFMtPpgpZtZ36estEnFhS43JyoYGoKp5xHyTN' as any
    });
    const evidence: OnChainReconciliationEvidence = {
      signatureFound: false,
      blockhashExpired: true
    };
    const res = evaluateReconciliationState(attempt, evidence);
    assert.strictEqual(res.verdict, 'FAILED_DEFINITIVE');
    assert.strictEqual(res.isTerminal, true);
    assert.strictEqual(res.canRetry, true);
    assert.strictEqual(res.onChainStatus, 'DROPPED');
  });

  // 6. SUBMITTED com signatureFound = false e blockhash válido -> MUST_RECONCILE
  await t.test('6. tentativa SUBMITTED não encontrada com blockhash ainda válido retorna MUST_RECONCILE', () => {
    const attempt = createMockAttempt({
      state: 'SUBMITTED',
      signature: '5nwz7eVDSU4MnT3zzmXyP9kg6w1Uo99GDz8qiZtMkcqUebeLgLbXFMtPpgpZtZ36estEnFhS43JyoYGoKp5xHyTN' as any
    });
    const evidence: OnChainReconciliationEvidence = {
      signatureFound: false,
      blockhashExpired: false,
      blockhashValid: true
    };
    const res = evaluateReconciliationState(attempt, evidence);
    assert.strictEqual(res.verdict, 'MUST_RECONCILE');
    assert.strictEqual(res.isTerminal, false);
    assert.strictEqual(res.canRetry, false);
    assert.strictEqual(res.requiresReconciliation, true);
    assert.strictEqual(res.onChainStatus, 'PENDING');
  });

  // 7. INVARIANTE CRÍTICO: HTTP Timeout / RPC Error produz UNKNOWN e NUNCA FAILED_DEFINITIVE
  await t.test('7. invariante crítico: HTTP timeout produz UNKNOWN e JAMAIS FAILED_DEFINITIVE', () => {
    const attempt = createMockAttempt({
      state: 'SUBMITTED',
      signature: '5nwz7eVDSU4MnT3zzmXyP9kg6w1Uo99GDz8qiZtMkcqUebeLgLbXFMtPpgpZtZ36estEnFhS43JyoYGoKp5xHyTN' as any
    });

    const timeoutEvidence: OnChainReconciliationEvidence = {
      httpTimeout: true,
      rpcError: 'ETIMEDOUT: Connection to RPC node timed out after 5000ms'
    };

    const res = evaluateReconciliationState(attempt, timeoutEvidence);

    // REGRA DE OURO: UNKNOWN !== FAILED_DEFINITIVE
    assert.strictEqual(res.verdict, 'UNKNOWN');
    assert.notStrictEqual(res.verdict, 'FAILED_DEFINITIVE');
    assert.strictEqual(res.canRetry, false, 'Cannot retry when status is UNKNOWN (prevents double sell)');
    assert.strictEqual(res.requiresReconciliation, true);
    assert.strictEqual(res.isTerminal, false);
    assert.strictEqual(res.onChainStatus, 'UNKNOWN');
  });

  // 8. Teste de Terminalidade de Verdicts
  await t.test('8. isVerdictTerminal classifica corretamente apenas CONFIRMED e FAILED_DEFINITIVE como terminais', () => {
    assert.strictEqual(isVerdictTerminal('CONFIRMED'), true);
    assert.strictEqual(isVerdictTerminal('FAILED_DEFINITIVE'), true);
    assert.strictEqual(isVerdictTerminal('UNKNOWN'), false);
    assert.strictEqual(isVerdictTerminal('MUST_RECONCILE'), false);
    assert.strictEqual(isVerdictTerminal('CAN_RETRY'), false);
  });

  // 9. Determinismo: 100 avaliações com mesmos inputs produzem exatamente os mesmos outputs
  await t.test('9. avaliação é pura e determinística em 100 execuções idênticas', () => {
    const attempt = createMockAttempt({ state: 'SUBMITTED', signature: 'sig_deterministic' as any });
    const evidence: OnChainReconciliationEvidence = { signatureFound: true, err: null, slot: 100 };

    const first = JSON.stringify(evaluateReconciliationState(attempt, evidence));
    for (let i = 0; i < 100; i++) {
      const current = JSON.stringify(evaluateReconciliationState(attempt, evidence));
      assert.strictEqual(current, first);
    }
  });
});
