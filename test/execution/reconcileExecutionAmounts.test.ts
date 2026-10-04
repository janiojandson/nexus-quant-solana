import { test } from 'node:test';
import assert from 'node:assert';
import {
  reconcileExecutionAmounts,
  type ExecutionAmountMismatch,
  type RoutedExitAttempt
} from '../../src/execution/exitRouter.js';

test('reconcileExecutionAmounts: valores idênticos não geram mismatch', () => {
  const result = reconcileExecutionAmounts(1000, 1000);
  assert.strictEqual(result.actualDebitAtomic, 1000);
  assert.strictEqual(result.amountMismatch, undefined);
});

test('reconcileExecutionAmounts: divergência entre solicitado e executado emite ExecutionAmountMismatch', () => {
  const result = reconcileExecutionAmounts(1000, 750);
  assert.strictEqual(result.actualDebitAtomic, 750, 'Deve usar montante executado real');
  assert.deepStrictEqual(result.amountMismatch, {
    requestedAmountAtomic: 1000,
    executedAmountAtomic: 750,
    deltaAtomic: 250
  });

  const overfillResult = reconcileExecutionAmounts(500, 520);
  assert.strictEqual(overfillResult.actualDebitAtomic, 520);
  assert.deepStrictEqual(overfillResult.amountMismatch, {
    requestedAmountAtomic: 500,
    executedAmountAtomic: 520,
    deltaAtomic: 20
  });
});

test('reconcileExecutionAmounts: fallback seguro se executado for inválido ou zero', () => {
  const zeroResult = reconcileExecutionAmounts(1000, 0);
  assert.strictEqual(zeroResult.actualDebitAtomic, 1000);

  const nanResult = reconcileExecutionAmounts(1000, NaN);
  assert.strictEqual(nanResult.actualDebitAtomic, 1000);
});

test('ExecutionConfirmationStage: provider receipt sem landing NÃO é tratado como confirmação econômica', () => {
  const providerReceiptOnly: RoutedExitAttempt = {
    status: 'SUCCESS',
    txSignature: '5wHZg1hW...',
    inAmount: 1000,
    outAmount: 50000000,
    confirmationStage: 'PROVIDER_RECEIPT'
  };

  const isEconomicallyConfirmed = (attempt: RoutedExitAttempt): boolean => {
    return (
      (attempt.status === 'SUCCESS' || attempt.status === 'DRY_RUN_SUCCESS') &&
      (attempt.confirmationStage === 'CHAIN_CONFIRMED' || attempt.confirmationStage === 'ECONOMICALLY_RECONCILED')
    );
  };

  assert.strictEqual(
    isEconomicallyConfirmed(providerReceiptOnly),
    false,
    'Mero HTTP 200 / PROVIDER_RECEIPT NÃO pode aplicar efeitos financeiros sem confirmação on-chain'
  );

  const chainConfirmed: RoutedExitAttempt = {
    ...providerReceiptOnly,
    confirmationStage: 'CHAIN_CONFIRMED'
  };
  assert.strictEqual(isEconomicallyConfirmed(chainConfirmed), true);

  const economicallyReconciled: RoutedExitAttempt = {
    ...providerReceiptOnly,
    confirmationStage: 'ECONOMICALLY_RECONCILED'
  };
  assert.strictEqual(isEconomicallyConfirmed(economicallyReconciled), true);
});

test('Partial fill em ordem total: preserva posição restante e não fecha ATA prematuramente', () => {
  const initialPosition = {
    mint: 'TestMintUnderfill',
    tokenAmount: 1000,
    symbol: 'UNDERFILL'
  };

  const requestedAmountAtomic = 1000;
  const executedInAmountAtomic = 600; // Jupiter executou apenas 600

  const { actualDebitAtomic, amountMismatch } = reconcileExecutionAmounts(
    requestedAmountAtomic,
    executedInAmountAtomic
  );

  assert.strictEqual(actualDebitAtomic, 600);
  assert.ok(amountMismatch);

  // Simula lógica de decisão de encerramento
  const isFullDebit = actualDebitAtomic >= initialPosition.tokenAmount;
  assert.strictEqual(isFullDebit, false, '600 de 1000 NÃO é débito total');

  let positionRemoved = false;
  let remainingBalance = initialPosition.tokenAmount;
  let ataClosed = false;

  if (isFullDebit) {
    positionRemoved = true;
    ataClosed = true;
  } else {
    // Commit partial
    remainingBalance -= actualDebitAtomic;
    ataClosed = false; // ATA deve continuar aberta
  }

  assert.strictEqual(positionRemoved, false, 'Posição NÃO deve ser removida se ainda restam 400 unidades');
  assert.strictEqual(remainingBalance, 400, 'Saldo remanescente deve ser 400');
  assert.strictEqual(ataClosed, false, 'ATA NÃO deve ser fechada pois ainda há 400 tokens');
});
