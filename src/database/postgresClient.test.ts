import test from 'node:test';
import assert from 'node:assert';
import { SolanaPostgresRepository, SolanaAuditRecord } from './postgresClient.js';

test('SolanaPostgresRepository: opera gracioso sem DATABASE_URL configurado', async () => {
  const repo = new SolanaPostgresRepository(); // sem URL
  assert.doesNotThrow(async () => {
    await repo.initTable();
    await repo.saveAudit({
      mint: 'TestMint1111111111111111111111111111111111111',
      symbol: 'TEST',
      name: 'Test Token',
      liquidityUsd: 15000,
      priceUsd: 0.05,
      isSafe: true,
      score: 95,
      validatedBy: 'TEST_VALIDATOR',
      dryRun: true
    });
    await repo.close();
  });
});
