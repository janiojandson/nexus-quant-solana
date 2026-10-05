import test from 'node:test';
import * as assert from 'node:assert/strict';
import { Pool } from 'pg';
import { InMemoryJournalRepository } from '../../src/journal/repository';
import { PostgresJournalRepository } from '../../src/journal/postgresRepository';
import { StaleEpochError, computeEconomicDedupeKey } from '../../src/journal/types';

test('Nexus V2.3 — BigInt Fencing & Precision Preservation (Hardening Pre-Flight)', async (t) => {
  const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER); // 9_007_199_254_740_991n
  const EPOCH_A = 9_007_199_254_740_995n; // > MAX_SAFE_INTEGER
  const EPOCH_B = 9_007_199_254_740_996n; // > MAX_SAFE_INTEGER (differs by 1)

  await t.test('1. Prova matemática de falha de precisão no Number do JavaScript', () => {
    // Prova irrefutável de que Number() colapsa inteiros de 64 bits distintos
    const numA = Number(EPOCH_A);
    const numB = Number(EPOCH_B);
    assert.strictEqual(
      numA === numB,
      true,
      'Number() deve perder precisão e colidir valores distintos acima de MAX_SAFE_INTEGER'
    );

    // Com BigInt, a igualdade é estrita e preservada
    assert.notStrictEqual(
      EPOCH_A,
      EPOCH_B,
      'BigInt deve distinguir perfeitamente 9007199254740995n de 9007199254740996n'
    );
  });

  await t.test('2. InMemoryJournalRepository: fencing funciona acima de MAX_SAFE_INTEGER', async () => {
    const repo = new InMemoryJournalRepository();
    const { intent } = await repo.createOrGetIntent({
      tradeId: 'trade_bigint_1' as any,
      positionId: 'pos_bigint_1' as any,
      walletId: 'Wallet1111111111111111111111111111111111',
      mint: '3A75w27ssueStCEEp6KGxKJ3EtP57P9FxT6YxHmDnt7a',
      tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      positionVersion: 1n,
      requestedAmountAtomic: '5000000000',
      amountPolicy: 'FULL_REMAINDER',
      initialSeverity: 'NORMAL',
      reason: 'TRAILING_STOP',
      policyVersion: '2026-10-04'
    });

    // Simula claim_epoch escalado acima de MAX_SAFE_INTEGER
    intent.claimEpoch = EPOCH_A;

    // Tentar atualizar com EPOCH_B (diferença de apenas 1 acima de MAX_SAFE_INTEGER)
    // Se usasse Number(), Number(EPOCH_A) === Number(EPOCH_B) e autorizaria incorretamente!
    await assert.rejects(
      async () => {
        await repo.updateIntentSeverity(
          intent.id,
          'HIGH',
          'PANIC',
          undefined,
          EPOCH_B
        );
      },
      (err: any) => {
        assert.ok(err instanceof StaleEpochError);
        assert.strictEqual(err.expectedEpoch, EPOCH_B);
        assert.strictEqual(err.actualEpoch, EPOCH_A);
        return true;
      },
      'Fencing com BigInt deve rejeitar com StaleEpochError'
    );

    // Atualização com o epoch exato de 64 bits passa com sucesso
    const updated = await repo.updateIntentSeverity(
      intent.id,
      'HIGH',
      'PANIC',
      undefined,
      EPOCH_A
    );
    assert.strictEqual(updated.toSeverity, 'HIGH');
    assert.strictEqual(intent.claimEpoch, EPOCH_A);
  });

  await t.test('3. PostgresJournalRepository & PostgreSQL 16 Real: fencing de 64 bits acima de MAX_SAFE_INTEGER', async () => {
    const testDbUrl = process.env.TEST_DATABASE_URL || 'postgresql://test_nexus_user:descartavel_secret_pass_123@localhost:55432/test_nexus_journal';
    const pool = new Pool({ connectionString: testDbUrl });

    // Requirement 41: Fail-closed verification - no silent catch { return; } false-green
    await pool.query('SELECT 1');

    const repo = new PostgresJournalRepository(pool);

    const { intent } = await repo.createOrGetIntent({
      id: `intent_bigint_fencing_${Date.now()}` as any,
      tradeId: 'trade_bigint_pg' as any,
      positionId: 'pos_bigint_pg' as any,
      walletId: 'WalletBigInt11111111111111111111111111111',
      mint: 'MintBigInt1111111111111111111111111111111',
      tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      positionVersion: 1n,
      requestedAmountAtomic: '5000000000',
      amountPolicy: 'FULL_REMAINDER',
      initialSeverity: 'NORMAL',
      reason: 'TRAILING_STOP',
      policyVersion: '2026-10-04'
    });

    // Força claim_epoch no PostgreSQL real para EPOCH_A
    await pool.query('UPDATE exit_intents SET claim_epoch = $1 WHERE id = $2', [String(EPOCH_A), intent.id]);

    const reloaded = await repo.getIntentById(intent.id);
    assert.ok(reloaded);
    assert.strictEqual(typeof reloaded?.claimEpoch, 'bigint');
    assert.strictEqual(reloaded?.claimEpoch, EPOCH_A);

    // Tentar atualizar com EPOCH_B (diferença de 1 acima de MAX_SAFE_INTEGER)
    await assert.rejects(
      async () => {
        await repo.updateIntentSeverity(
          intent.id,
          'HIGH',
          'PANIC',
          undefined,
          EPOCH_B
        );
      },
      (err: any) => {
        assert.ok(err instanceof StaleEpochError);
        assert.strictEqual(BigInt(err.expectedEpoch), EPOCH_B);
        assert.strictEqual(BigInt(err.actualEpoch), EPOCH_A);
        return true;
      }
    );

    // Atualização com epoch exato funciona no banco real
    const ev = await repo.updateIntentSeverity(
      intent.id,
      'HIGH',
      'PANIC',
      undefined,
      EPOCH_A
    );
    assert.strictEqual(ev.toSeverity, 'HIGH');

    await pool.end();
  });

  await t.test('4. positionVersion com BigInt preserva unicidade e integridade acima de MAX_SAFE_INTEGER', () => {
    const versionA = 9_007_199_254_740_995n;
    const versionB = 9_007_199_254_740_996n;

    const keyA = computeEconomicDedupeKey({
      walletId: 'W1',
      mint: 'M1',
      positionVersion: versionA,
      requestedAmountAtomic: '1000',
      amountPolicy: 'FULL_REMAINDER'
    });

    const keyB = computeEconomicDedupeKey({
      walletId: 'W1',
      mint: 'M1',
      positionVersion: versionB,
      requestedAmountAtomic: '1000',
      amountPolicy: 'FULL_REMAINDER'
    });

    assert.notStrictEqual(
      keyA,
      keyB,
      'Versões econômicas acima de MAX_SAFE_INTEGER devem produzir dedupe keys distintas'
    );
  });
});
