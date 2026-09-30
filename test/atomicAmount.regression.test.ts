import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  assertAtomicAmount,
  assertAtomicAmountToNumber,
  atomicToUiAmount,
  evaluateCapitalReturn,
  uiAmountToAtomic,
  InvalidAtomicAmountError,
  MAX_ROUNDTRIP_LOSS_SOL
} from '../src/execution/atomicAmount.js';

/**
 * Regressão do incidente do canário: 5.389317 JUP (6 decimais) foi lido como
 * uiAmount e convertido com Math.floor, resultando em 5 lamports enviados à
 * Jupiter. O swap retornou SUCCESS, a posição ficou presa na carteira e o
 * relatório acusou lucro. Estes testes existem para que a troca de escala
 * nunca mais passe silenciosamente.
 */

describe('atomicAmount - Escala de decimais SPL', () => {
  it('deve preservar a escala: 5.389267 tokens com 6 decimais = "5389267" unidades básicas', () => {
    assert.strictEqual(uiAmountToAtomic(5.389267, 6), '5389267');
    assert.strictEqual(uiAmountToAtomic('5.389267', 6), '5389267');
  });

  it('deve converter atomic para ui preservando o valor', () => {
    assert.strictEqual(atomicToUiAmount('5389267', 6), 5.389267);
  });

  it('deve fazer round-trip sem perda entre as duas escalas', () => {
    const samples: Array<[string, number]> = [
      ['5389267', 6],   // 5.389267 JUP
      ['123456789', 6], // 123.456789
      ['1', 6],         // token mais ínfimo
      ['1000000', 6]    // 1.000000
    ];
    for (const [atomic, decimals] of samples) {
      assert.strictEqual(uiAmountToAtomic(atomicToUiAmount(atomic, decimals), decimals), atomic);
    }
  });

  it('deve rejeitar uiAmount com mais casas decimais que o mint suporta', () => {
    assert.throws(
      () => uiAmountToAtomic(1.1234567, 6),
      /mais que 6 casas decimais/
    );
  });
});

describe('assertAtomicAmount - Rejeição de entrada em escala UI/float', () => {
  it('deve ACEITAR o bruto atômico em string', () => {
    assert.strictEqual(assertAtomicAmount('5389267'), 5389267n);
  });

  it('deve REJEITAR o valor em uiAmount decimal (o bug do canário)', () => {
    assert.throws(() => assertAtomicAmount('5.389267'), InvalidAtomicAmountError);
    assert.throws(() => assertAtomicAmount(5.389267), InvalidAtomicAmountError);
  });

  it('deve rejeitar o resultado de Math.floor sobre uiAmount (5 lamports)', () => {
    // Este é o valor exato que foi enviado à Jupiter no incidente.
    assert.throws(() => assertAtomicAmount(Math.floor(5.389267)), InvalidAtomicAmountError);
  });

  it('deve rejeitar notação científica, hex, negativos e vazios', () => {
    for (const bad of ['1e6', '0x10', '-1', '', ' ', 'abc', '1,000', '+1', '5.0', null, undefined, {}]) {
      assert.throws(() => assertAtomicAmount(bad), InvalidAtomicAmountError, `deveria rejeitar ${JSON.stringify(bad)}`);
    }
  });

  it('deve rejeitar zero (nada a trocar)', () => {
    assert.throws(() => assertAtomicAmount('0'), InvalidAtomicAmountError);
    assert.throws(() => assertAtomicAmount(0n), InvalidAtomicAmountError);
  });

  it('deve aceitar BigInt positivo e devolver número seguro', () => {
    assert.strictEqual(assertAtomicAmountToNumber(5389267n), 5389267);
    assert.strictEqual(assertAtomicAmountToNumber('5389267'), 5389267);
  });

  it('deve rejeitar BigInt acima de Number.MAX_SAFE_INTEGER', () => {
    assert.throws(
      () => assertAtomicAmountToNumber('9007199254740993'),
      InvalidAtomicAmountError
    );
  });
});

describe('evaluateCapitalReturn - Veredito do canário', () => {
  const base = {
    initialBalanceSol: 0.291104,
    remainingAtomicAmount: '0',
    ataClosed: true
  };

  it('deve APROVAR quando perda esta dentro da tolerancia e nao restou token', () => {
    const v = evaluateCapitalReturn({ ...base, finalBalanceSol: 0.29 });
    assert.strictEqual(v.ok, true, v.reason);
    assert.ok(v.lossSol <= MAX_ROUNDTRIP_LOSS_SOL);
  });

  it('deve REPROVAR quando a perda excede 0.0015 SOL', () => {
    const v = evaluateCapitalReturn({ ...base, finalBalanceSol: 0.261546 });
    assert.strictEqual(v.ok, false);
    assert.match(v.reason, /excede a tolerancia/);
  });

  it('deve REPROVAR quando ainda restam tokens na ATA', () => {
    const v = evaluateCapitalReturn({
      ...base,
      finalBalanceSol: 0.291104,
      remainingAtomicAmount: '5389267'
    });
    assert.strictEqual(v.ok, false);
    assert.match(v.reason, /saldo remanescente de 5389267/);
  });

  it('deve REPROVAR quando a ATA nao foi fechada', () => {
    const v = evaluateCapitalReturn({ ...base, ataClosed: false, finalBalanceSol: 0.291104 });
    assert.strictEqual(v.ok, false);
    assert.match(v.reason, /ATA nao foi fechada/);
  });

  it('deve REPROVAR o cenário real do incidente (perda + tokens presos)', () => {
    const v = evaluateCapitalReturn({
      initialBalanceSol: 0.291104,
      finalBalanceSol: 0.261546,
      remainingAtomicAmount: '5389267',
      ataClosed: false
    });
    assert.strictEqual(v.ok, false);
    // As tres causas devem ser apontadas, nao apenas a primeira.
    assert.match(v.reason, /saldo remanescente/);
    assert.match(v.reason, /ATA nao foi fechada/);
    assert.match(v.reason, /excede a tolerancia/);
  });

  it('deve tolerar perda exatamente no limite', () => {
    // Valores escolhidos para que a subtração seja exata em ponto flutuante,
    // isolando a comparação `lossSol > toleranceSol` da aritmética do teste.
    const v = evaluateCapitalReturn({
      initialBalanceSol: 1.0,
      remainingAtomicAmount: '0',
      ataClosed: true,
      finalBalanceSol: 1.0 - MAX_ROUNDTRIP_LOSS_SOL
    });
    assert.strictEqual(v.ok, true, `perda=${v.lossSol} tol=${v.toleranceSol} :: ${v.reason}`);
  });

  it('deve reprovar saldo remanescente ilegivel em vez de assumir zero', () => {
    const v = evaluateCapitalReturn({
      ...base,
      remainingAtomicAmount: 'NaN',
      finalBalanceSol: 0.291104
    });
    assert.strictEqual(v.ok, false);
    assert.match(v.reason, /ilegível/);
  });
});
