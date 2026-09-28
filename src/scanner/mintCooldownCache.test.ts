import { test, describe } from 'node:test';
import assert from 'node:assert';
import { MintCooldownCache } from './mintCooldownCache.js';

describe('MintCooldownCache - L1 Cache Anti-Redundância', () => {
  test('deve permitir processar novo mint e bloquear reprocessamento após rejeição', () => {
    const cache = new MintCooldownCache(5); // 5 minutos TTL
    const mint = 'So11111111111111111111111111111111111111112';

    assert.strictEqual(cache.shouldProcess(mint), true);
    cache.recordRejection(mint);
    assert.strictEqual(cache.shouldProcess(mint), false, 'Deve bloquear reprocessamento dentro do TTL');
  });

  test('deve expirar e liberar mint após TTL', () => {
    const cache = new MintCooldownCache(0.001); // ~60ms TTL
    const mint = 'TokenExpiravel1111111111111111111111111111';

    cache.recordRejection(mint);
    assert.strictEqual(cache.shouldProcess(mint), false);

    return new Promise<void>((resolve) => {
      setTimeout(() => {
        assert.strictEqual(cache.shouldProcess(mint), true, 'Deve liberar após expiração');
        resolve();
      }, 100);
    });
  });

  test('deve limpar itens antigos e respeitar tamanho', () => {
    const cache = new MintCooldownCache(5);
    cache.recordRejection('mint1');
    cache.recordRejection('mint2');
    assert.strictEqual(cache.size(), 2);
    cache.clear();
    assert.strictEqual(cache.size(), 0);
  });
});
