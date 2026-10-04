import { test } from 'node:test';
import assert from 'node:assert';
import {
  FinancialExitSafetyGuard,
  safeBigIntToNumber,
  parseAtomicAmountBigInt
} from '../../src/execution/financialExitSafetyGuard.js';

test('FinancialExitSafetyGuard: bloqueia in-flight collisions concorrentes para a mesma moeda', () => {
  const guard = new FinancialExitSafetyGuard();
  const mint = 'MintCollision111111111111111111111111111111111';

  const res1 = guard.acquireExitLock(mint, 1000n);
  assert.strictEqual(res1.allowed, true);

  const res2 = guard.acquireExitLock(mint, 500n);
  assert.strictEqual(res2.allowed, false);
  assert.strictEqual(res2.code, 'IN_FLIGHT_COLLISION');

  guard.releaseExitLock(mint);

  const res3 = guard.acquireExitLock(mint, 500n);
  assert.strictEqual(res3.allowed, true);
  guard.releaseExitLock(mint);
});

test('FinancialExitSafetyGuard: bloqueia qualquer saída quando há dívida/estado incerto registrado', () => {
  const guard = new FinancialExitSafetyGuard();
  const mint = 'MintUncertainDebt22222222222222222222222222222';

  guard.registerUnresolvedDebt(mint);
  assert.strictEqual(guard.hasUnresolvedDebt(mint), true);

  const res = guard.acquireExitLock(mint, 1000n);
  assert.strictEqual(res.allowed, false);
  assert.strictEqual(res.code, 'UNRESOLVED_RECONCILIATION_DEBT');

  const valRes = guard.validateExit(mint, 1000n);
  assert.strictEqual(valRes.allowed, false);
  assert.strictEqual(valRes.code, 'UNRESOLVED_RECONCILIATION_DEBT');

  guard.clearUnresolvedDebt(mint);
  assert.strictEqual(guard.hasUnresolvedDebt(mint), false);

  const resAfter = guard.acquireExitLock(mint, 1000n);
  assert.strictEqual(resAfter.allowed, true);
  guard.releaseExitLock(mint);
});

test('FinancialExitSafetyGuard: rejeita atomic amounts <= 0n', () => {
  const guard = new FinancialExitSafetyGuard();
  const mint = 'MintZeroAmount333333333333333333333333333333333';

  const resZero = guard.acquireExitLock(mint, 0n);
  assert.strictEqual(resZero.allowed, false);
  assert.strictEqual(resZero.code, 'INVALID_ATOMIC_AMOUNT');

  const resNeg = guard.acquireExitLock(mint, -500n);
  assert.strictEqual(resNeg.allowed, false);
  assert.strictEqual(resNeg.code, 'INVALID_ATOMIC_AMOUNT');
});

test('safeBigIntToNumber: rejeita conversão se valor exceder MAX_SAFE_INTEGER sem perder precisão silenciosamente', () => {
  assert.strictEqual(safeBigIntToNumber(0n), 0);
  assert.strictEqual(safeBigIntToNumber(1_000_000_000n), 1_000_000_000);
  assert.strictEqual(
    safeBigIntToNumber(BigInt(Number.MAX_SAFE_INTEGER)),
    Number.MAX_SAFE_INTEGER
  );

  const unsafeVal = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
  assert.throws(
    () => safeBigIntToNumber(unsafeVal, 'adversarial_test'),
    /exceeds Number\.MAX_SAFE_INTEGER/
  );

  assert.throws(
    () => safeBigIntToNumber(-10n, 'negative_test'),
    /Negative value not permitted/
  );
});

test('parseAtomicAmountBigInt: faz parse seguro de string, number inteiro e bigint', () => {
  assert.strictEqual(parseAtomicAmountBigInt('123456789'), 123456789n);
  assert.strictEqual(parseAtomicAmountBigInt(987654n), 987654n);
  assert.strictEqual(parseAtomicAmountBigInt(5000), 5000n);

  assert.throws(() => parseAtomicAmountBigInt('123.45'), /Invalid atomic string/);
  assert.throws(() => parseAtomicAmountBigInt(123.45), /not a safe integer/);
  assert.throws(() => parseAtomicAmountBigInt('abc'), /Invalid atomic string/);
});

test('Fail-Closed Logic: simula fluxo completo de panicToken FAILED, UNKNOWN e CONFIRMED', async () => {
  const guard = new FinancialExitSafetyGuard();
  const mockPositions = new Map<string, any>([
    ['MintA', { mint: 'MintA', symbol: 'TOKEN_A', tokenAmount: 100 }],
    ['MintB', { mint: 'MintB', symbol: 'TOKEN_B', tokenAmount: 200 }],
    ['MintC', { mint: 'MintC', symbol: 'TOKEN_C', tokenAmount: 300 }]
  ]);
  const closedAtas = new Set<string>();

  const executePanicTokenFlow = async (
    mint: string,
    mockSwapStatus: 'SUCCESS' | 'FAILED' | 'SUBMITTED_UNCONFIRMED',
    atomicAmountStr: string
  ) => {
    if (guard.hasUnresolvedDebt(mint)) {
      return {
        success: false,
        status: 'PENDING_RECONCILIATION',
        error: `UNRESOLVED_EXECUTION_DEBT:${mint}`
      };
    }

    const atomicAmount = parseAtomicAmountBigInt(atomicAmountStr);
    const lock = guard.acquireExitLock(mint, atomicAmount);
    if (!lock.allowed) {
      return {
        success: false,
        status: lock.code === 'UNRESOLVED_RECONCILIATION_DEBT' ? 'PENDING_RECONCILIATION' : 'FAILED_DEFINITIVE',
        error: lock.reason
      };
    }

    try {
      safeBigIntToNumber(atomicAmount);

      if (mockSwapStatus === 'SUBMITTED_UNCONFIRMED') {
        guard.registerUnresolvedDebt(mint);
        return {
          success: false,
          status: 'PENDING_RECONCILIATION',
          txid: 'tx_submitted_unconfirmed',
          error: 'Swap submetido mas não confirmado'
        };
      }

      if (mockSwapStatus === 'FAILED') {
        return {
          success: false,
          status: 'FAILED_DEFINITIVE',
          error: 'Jupiter swap failed'
        };
      }

      mockPositions.delete(mint);
      closedAtas.add(mint);
      return {
        success: true,
        status: 'CONFIRMED',
        txid: 'tx_confirmed_123'
      };
    } finally {
      guard.releaseExitLock(mint);
    }
  };

  // 1. Cenário FAILED
  const failRes = await executePanicTokenFlow('MintA', 'FAILED', '100000000');
  assert.strictEqual(failRes.success, false);
  assert.strictEqual(failRes.status, 'FAILED_DEFINITIVE');
  assert.strictEqual(mockPositions.has('MintA'), true, 'Posição NÃO deve ser removida quando swap falha');
  assert.strictEqual(closedAtas.has('MintA'), false, 'ATA NÃO deve ser fechada quando swap falha');

  // 2. Cenário UNKNOWN / SUBMITTED_UNCONFIRMED
  const unkRes = await executePanicTokenFlow('MintB', 'SUBMITTED_UNCONFIRMED', '200000000');
  assert.strictEqual(unkRes.success, false);
  assert.strictEqual(unkRes.status, 'PENDING_RECONCILIATION');
  assert.strictEqual(mockPositions.has('MintB'), true, 'Posição NÃO deve ser removida se inconclusivo');
  assert.strictEqual(closedAtas.has('MintB'), false, 'ATA NÃO deve ser fechada se inconclusivo');
  assert.strictEqual(guard.hasUnresolvedDebt('MintB'), true, 'Dívida registrada');

  // 3. Segunda tentativa após UNKNOWN deve ser bloqueada
  const retryUnkRes = await executePanicTokenFlow('MintB', 'SUCCESS', '200000000');
  assert.strictEqual(retryUnkRes.success, false);
  assert.strictEqual(retryUnkRes.status, 'PENDING_RECONCILIATION');

  // 4. Cenário CONFIRMED
  const confRes = await executePanicTokenFlow('MintC', 'SUCCESS', '300000000');
  assert.strictEqual(confRes.success, true);
  assert.strictEqual(confRes.status, 'CONFIRMED');
  assert.strictEqual(mockPositions.has('MintC'), false, 'Posição deve ser removida após confirmação');
  assert.strictEqual(closedAtas.has('MintC'), true, 'ATA deve ser fechada após confirmação');
});

test('Fail-Closed Logic: simula panicAll sem clearPositions antecipado e com contagem precisa de liquidações', async () => {
  const guard = new FinancialExitSafetyGuard();
  const mockPositions = new Map<string, any>([
    ['Mint1', { mint: 'Mint1', symbol: 'T1' }],
    ['Mint2', { mint: 'Mint2', symbol: 'T2' }],
    ['Mint3', { mint: 'Mint3', symbol: 'T3' }]
  ]);
  const closedAtas = new Set<string>();

  const tokens = [
    { mint: 'Mint1', status: 'SUCCESS' as const, atomicAmount: '1000' },
    { mint: 'Mint2', status: 'FAILED' as const, atomicAmount: '2000' },
    { mint: 'Mint3', status: 'SUBMITTED_UNCONFIRMED' as const, atomicAmount: '3000' }
  ];

  // Executa panicAll simulado
  const results: any[] = [];
  let liquidationsCount = 0;

  for (const t of tokens) {
    const atomicAmount = parseAtomicAmountBigInt(t.atomicAmount);
    const lock = guard.acquireExitLock(t.mint, atomicAmount);
    if (!lock.allowed) {
      results.push({ mint: t.mint, status: 'FAILED_DEFINITIVE', success: false });
      continue;
    }

    try {
      if (t.status === 'SUBMITTED_UNCONFIRMED') {
        guard.registerUnresolvedDebt(t.mint);
        results.push({ mint: t.mint, status: 'PENDING_RECONCILIATION', success: false });
      } else if (t.status === 'FAILED') {
        results.push({ mint: t.mint, status: 'FAILED_DEFINITIVE', success: false });
      } else {
        mockPositions.delete(t.mint);
        closedAtas.add(t.mint);
        liquidationsCount++;
        results.push({ mint: t.mint, status: 'CONFIRMED', success: true });
      }
    } finally {
      guard.releaseExitLock(t.mint);
    }
  }

  // Verificações
  assert.strictEqual(liquidationsCount, 1, 'Apenas 1 liquidação confirmada');
  assert.strictEqual(results.length, 3);
  assert.strictEqual(mockPositions.has('Mint1'), false, 'Mint1 confirmado deve ter posição removida');
  assert.strictEqual(mockPositions.has('Mint2'), true, 'Mint2 com falha deve PRESERVAR posição');
  assert.strictEqual(mockPositions.has('Mint3'), true, 'Mint3 inconclusivo deve PRESERVAR posição');
  assert.strictEqual(closedAtas.has('Mint1'), true);
  assert.strictEqual(closedAtas.has('Mint2'), false);
  assert.strictEqual(closedAtas.has('Mint3'), false);
  assert.strictEqual(guard.hasUnresolvedDebt('Mint3'), true);
});
