import { test, describe } from 'node:test';
import assert from 'node:assert';
import { MaturityIncubator } from './maturityIncubator.js';

describe('MaturityIncubator - Pipeline de Maturação Ayla (15-60 min)', () => {
  test('deve reter tokens com menos de 15 minutos na fila de incubação', () => {
    const incubator = new MaturityIncubator({ minMaturityMinutes: 15, maxMaturityMinutes: 60 });
    const now = Date.now();

    // Token criado há 2 minutos
    const added = incubator.add({
      mint: 'MintBebe2Min',
      poolAddress: 'PoolBebe1',
      symbol: 'BABY',
      name: 'Baby Token',
      pairCreatedAt: now - (2 * 60 * 1000)
    }, now);

    assert.strictEqual(added, true);
    assert.strictEqual(incubator.size(), 1);

    const { waiting, mature, expiredCount } = incubator.sweep(now);
    assert.strictEqual(waiting.length, 1);
    assert.strictEqual(waiting[0].mint, 'MintBebe2Min');
    assert.strictEqual(mature.length, 0);
    assert.strictEqual(expiredCount, 0);
  });

  test('deve promover para maduro tokens entre 15 e 60 minutos', () => {
    const incubator = new MaturityIncubator({ minMaturityMinutes: 15, maxMaturityMinutes: 60 });
    const now = Date.now();

    // Token criado há 25 minutos
    incubator.add({
      mint: 'MintMaduro25Min',
      poolAddress: 'PoolMadura1',
      symbol: 'MATURE',
      pairCreatedAt: now - (25 * 60 * 1000)
    }, now);

    const { waiting, mature, expiredCount } = incubator.sweep(now);
    assert.strictEqual(waiting.length, 0);
    assert.strictEqual(mature.length, 1);
    assert.strictEqual(mature[0].mint, 'MintMaduro25Min');
    assert.strictEqual(expiredCount, 0);
  });

  test('deve expirar e purgar tokens com mais de 60 minutos', () => {
    const incubator = new MaturityIncubator({ minMaturityMinutes: 15, maxMaturityMinutes: 60 });
    const now = Date.now();

    // Token criado há 70 minutos
    incubator.add({
      mint: 'MintVelho70Min',
      poolAddress: 'PoolVelha1',
      pairCreatedAt: now - (70 * 60 * 1000)
    }, now);

    const { waiting, mature, expiredCount } = incubator.sweep(now);
    assert.strictEqual(waiting.length, 0);
    assert.strictEqual(mature.length, 0);
    assert.strictEqual(expiredCount, 1);
    assert.strictEqual(incubator.size(), 0);
  });

  test('não deve duplicar mints já presentes na incubadora', () => {
    const incubator = new MaturityIncubator();
    const now = Date.now();

    const add1 = incubator.add({ mint: 'DupeMint', poolAddress: 'Pool1' }, now);
    const add2 = incubator.add({ mint: 'DupeMint', poolAddress: 'Pool2' }, now);

    assert.strictEqual(add1, true);
    assert.strictEqual(add2, false);
    assert.strictEqual(incubator.size(), 1);
  });
});
