import test from 'node:test';
import assert from 'node:assert';
import {
  assertAtomicAmountToNumber,
  assertStoredAtomicNumberToNumber,
  InvalidAtomicAmountError
} from './atomicAmount.js';

test('assertStoredAtomicNumberToNumber: aceita o lote atômico real do trade Google', () => {
  const realAtomic = 5_257_875_685;
  assert.strictEqual(assertStoredAtomicNumberToNumber(realAtomic), realAtomic);
});

test('assertStoredAtomicNumberToNumber: rejeita uiAmount float e números inseguros', () => {
  for (const invalid of [5245.575701, 0, -1, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => assertStoredAtomicNumberToNumber(invalid),
      InvalidAtomicAmountError
    );
  }
});

test('assertAtomicAmountToNumber: continua rejeitando number genérico para não aceitar uiAmount silenciosamente', () => {
  assert.throws(
    () => assertAtomicAmountToNumber(5_257_875_685),
    InvalidAtomicAmountError
  );
  assert.strictEqual(
    assertAtomicAmountToNumber('5257875685'),
    5_257_875_685
  );
});
