/**
 * Nexus Quant Solana — V2.3A Real PostgreSQL Position Integration Test Suite
 *
 * Validates against a REAL, PHYSICAL PostgreSQL 16 instance:
 * 1. Database version proof via SELECT version();
 * 2. Physical application of migration 002_v2_3_position_versioning.sql & idempotency;
 * 3. Physical schema catalog inspection (nexus_positions_v2, nexus_position_mutations_v2, partial unique indexes);
 * 4. Real CAS version update & rowCount = 0 mapping to StalePositionVersionError;
 * 5. Real concurrent CAS competition across 2 independent connections;
 * 6. Real atomic fill application with duplicate fill idempotency (uq_position_fill_mutation);
 * 7. Real partial fill sequence: v1 (1.000.000) -> v2 (600.000) -> reprocess (v2) -> v3 (0, CLOSED);
 * 8. Real restart recovery: fresh repository instance reconstructs exact version, balance, and state;
 * 9. Real atomic rollback boundary: error during mutation rolls back all table updates.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Pool } from 'pg';
import { PostgresPositionRepository } from '../../src/position/postgresPositionRepository.js';
import {
  StalePositionVersionError,
  ActivePositionConflictError
} from '../../src/position/types.js';

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ||
  'postgresql://test_nexus_user:descartavel_secret_pass_123@localhost:55432/test_nexus_journal';

describe('Nexus V2.3A — Real PostgreSQL Position Integration', () => {
  let pool: Pool;
  let repo: PostgresPositionRepository;

  before(async () => {
    assert.strictEqual(
      Boolean(TEST_DB_URL.includes('railway.internal') || TEST_DB_URL.includes('rlwy.net')),
      false,
      'PROIBIDO usar banco Railway para testes'
    );

    pool = new Pool({
      connectionString: TEST_DB_URL,
      max: 10,
      connectionTimeoutMillis: 5000
    });

    repo = new PostgresPositionRepository(pool);
  });

  const resetPositionTables = async () => {
    await pool.query('TRUNCATE TABLE nexus_position_mutations_v2, nexus_positions_v2 CASCADE;');
  };

  after(async () => {
    if (pool) {
      await pool.end();
    }
  });

  it('1. Prova de Versão Real: executa SELECT version() e comprova PostgreSQL físico', async () => {
    const res = await pool.query('SELECT version();');
    assert.ok(res.rows.length > 0);
    const pgVersion = res.rows[0].version;
    assert.ok(
      pgVersion.toLowerCase().includes('postgresql 16'),
      `Versão deve ser PostgreSQL 16 real. Obtido: ${pgVersion}`
    );
  });

  it('2. Aplicação de Migration Real 002 e Idempotência', async () => {
    const migrationPath = path.resolve(process.cwd(), 'migrations/002_v2_3_position_versioning.sql');
    const ddl = fs.readFileSync(migrationPath, 'utf8');

    // Primeira aplicação
    await pool.query(ddl);

    // Segunda aplicação (idempotência estrita)
    await pool.query(ddl);
  });

  it('3. Inspeção de Catálogo Real: nexus_positions_v2, nexus_position_mutations_v2 e índices', async () => {
    const tablesRes = await pool.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name;"
    );
    const tableNames = tablesRes.rows.map((r: any) => r.table_name);
    assert.ok(tableNames.includes('nexus_positions_v2'), 'nexus_positions_v2 deve existir fisicamente');
    assert.ok(tableNames.includes('nexus_position_mutations_v2'), 'nexus_position_mutations_v2 deve existir fisicamente');

    const indexRes = await pool.query(
      "SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'nexus_positions_v2';"
    );
    const indexNames = indexRes.rows.map((r: any) => r.indexname);
    assert.ok(indexNames.includes('uq_active_position_wallet_mint'), 'uq_active_position_wallet_mint deve existir fisicamente');
  });

  it('4. Real CAS Version Update e detecção de StalePositionVersionError no PostgreSQL Real', async () => {
    await resetPositionTables();

    const created = await repo.createPosition({
      positionId: 'pg-pos-cas-1',
      tradeId: 'pg-trade-cas-1',
      walletId: 'pg-wallet-cas-1',
      mint: 'pg-mint-cas-1',
      initialAmountAtomic: 500_000n,
      initialPrincipalLamports: 15_000_000n
    });
    assert.strictEqual(created.positionVersion, 1n);

    // CAS com expectedVersion = 1n -> Sucesso (v2)
    const casRes = await repo.updatePositionCAS({
      positionId: 'pg-pos-cas-1',
      expectedVersion: 1n,
      newAmountAtomic: 300_000n,
      mutationType: 'PARTIAL_FILL'
    });
    assert.strictEqual(casRes.position.positionVersion, 2n);
    assert.strictEqual(casRes.position.tokenAmountAtomic, 300_000n);

    // CAS com expectedVersion = 1n (stale!) -> Erro
    await assert.rejects(
      async () => {
        await repo.updatePositionCAS({
          positionId: 'pg-pos-cas-1',
          expectedVersion: 1n,
          newAmountAtomic: 200_000n,
          mutationType: 'PARTIAL_FILL'
        });
      },
      (err: any) => {
        assert(err instanceof StalePositionVersionError);
        assert.strictEqual(err.expectedVersion, 1n);
        assert.strictEqual(err.actualVersion, 2n);
        return true;
      }
    );
  });

  it('5. Concorrência Real de CAS: duas conexões simultâneas competindo sobre mesma versão', async () => {
    await resetPositionTables();

    await repo.createPosition({
      positionId: 'pg-pos-conc-1',
      tradeId: 'pg-trade-conc-1',
      walletId: 'pg-wallet-conc-1',
      mint: 'pg-mint-conc-1',
      initialAmountAtomic: 10_000n,
      initialPrincipalLamports: 15_000_000n,
      initialVersion: 7n
    });

    const clientA = new PostgresPositionRepository(pool);
    const clientB = new PostgresPositionRepository(pool);

    const promiseA = clientA.updatePositionCAS({
      positionId: 'pg-pos-conc-1',
      expectedVersion: 7n,
      newAmountAtomic: 6_000n,
      mutationType: 'PARTIAL_FILL'
    });

    const promiseB = clientB.updatePositionCAS({
      positionId: 'pg-pos-conc-1',
      expectedVersion: 7n,
      newAmountAtomic: 4_000n,
      mutationType: 'PARTIAL_FILL'
    });

    const results = await Promise.allSettled([promiseA, promiseB]);
    const fulfilled = results.filter(r => r.status === 'fulfilled');
    const rejected = results.filter(r => r.status === 'rejected');

    assert.strictEqual(fulfilled.length, 1, 'Exatamente um worker deve vencer o CAS');
    assert.strictEqual(rejected.length, 1, 'Exatamente um worker deve ser rejeitado');

    const rejectionReason: any = (rejected[0] as PromiseRejectedResult).reason;
    assert(rejectionReason instanceof StalePositionVersionError);
  });

  it('6. Requisito 13 & 12 no PostgreSQL Real: Partial Fill + Reprocessamento Idempotente', async () => {
    await resetPositionTables();

    // 1. Position: v1, balance 1.000.000
    await repo.createPosition({
      positionId: 'pg-pos-partial-req13',
      tradeId: 'pg-trade-req13',
      walletId: 'pg-wallet-req13',
      mint: 'pg-mint-req13',
      initialAmountAtomic: 1_000_000n,
      initialPrincipalLamports: 15_000_000n
    });

    // 2. Partial Fill: 400.000 debitados -> version 2, balance 600.000
    const fill1 = await repo.applyFill({
      positionId: 'pg-pos-partial-req13',
      expectedVersion: 1n,
      fillId: 'pg-fill-1',
      signature: 'pg-sig-1',
      fillAmountAtomic: 400_000n,
      proceedsLamports: 6_000_000n
    });
    assert.strictEqual(fill1.alreadyApplied, false);
    assert.strictEqual(fill1.position.positionVersion, 2n);
    assert.strictEqual(fill1.position.tokenAmountAtomic, 600_000n);

    // 3. Reprocessar mesmo Fill -> version continua 2, balance continua 600.000
    const fill1Dup = await repo.applyFill({
      positionId: 'pg-pos-partial-req13',
      expectedVersion: 2n,
      fillId: 'pg-fill-1',
      signature: 'pg-sig-1',
      fillAmountAtomic: 400_000n,
      proceedsLamports: 6_000_000n
    });
    assert.strictEqual(fill1Dup.alreadyApplied, true);
    assert.strictEqual(fill1Dup.position.positionVersion, 2n);
    assert.strictEqual(fill1Dup.position.tokenAmountAtomic, 600_000n);

    // 4. Segundo fill novo: 600.000 -> version 3, balance 0, status CLOSED
    const fill2 = await repo.applyFill({
      positionId: 'pg-pos-partial-req13',
      expectedVersion: 2n,
      fillId: 'pg-fill-2',
      signature: 'pg-sig-2',
      fillAmountAtomic: 600_000n,
      proceedsLamports: 9_000_000n,
      isFinal: true
    });
    assert.strictEqual(fill2.alreadyApplied, false);
    assert.strictEqual(fill2.position.positionVersion, 3n);
    assert.strictEqual(fill2.position.tokenAmountAtomic, 0n);
    assert.strictEqual(fill2.position.status, 'CLOSED');
  });

  it('7. Requisito 29 no PostgreSQL Real: Restart Test com Preservação de Versão e Saldo', async () => {
    await resetPositionTables();

    // 1. Criar e mutar na instância 1
    await repo.createPosition({
      positionId: 'pg-pos-restart',
      tradeId: 'pg-trade-restart',
      walletId: 'pg-wallet-restart',
      mint: 'pg-mint-restart',
      initialAmountAtomic: 800_000n,
      initialPrincipalLamports: 15_000_000n
    });
    await repo.applyFill({
      positionId: 'pg-pos-restart',
      expectedVersion: 1n,
      fillId: 'pg-fill-restart-1',
      signature: 'pg-sig-restart-1',
      fillAmountAtomic: 300_000n,
      proceedsLamports: 5_000_000n
    });

    // 2. Destruir repositório e instanciar NOVO repositório (simulando boot)
    const freshRepo = new PostgresPositionRepository(pool);
    const restored = await freshRepo.getPosition('pg-pos-restart');
    assert.ok(restored, 'Posição deve existir após restart');
    assert.strictEqual(restored.positionVersion, 2n);
    assert.strictEqual(restored.tokenAmountAtomic, 500_000n);
    assert.strictEqual(restored.confirmedProceedsLamports, 5_000_000n);

    // 3. Re-aplicação do mesmo fill pós-restart é idempotente
    const dupRes = await freshRepo.applyFill({
      positionId: 'pg-pos-restart',
      expectedVersion: 2n,
      fillId: 'pg-fill-restart-1',
      signature: 'pg-sig-restart-1',
      fillAmountAtomic: 300_000n,
      proceedsLamports: 5_000_000n
    });
    assert.strictEqual(dupRes.alreadyApplied, true);
    assert.strictEqual(dupRes.position.positionVersion, 2n);
    assert.strictEqual(dupRes.position.tokenAmountAtomic, 500_000n);
  });

  it('8. Atomicidade de Rollback no PostgreSQL Real: erro na mutação reverte tudo', async () => {
    await resetPositionTables();

    await repo.createPosition({
      positionId: 'pg-pos-rollback',
      tradeId: 'pg-trade-rollback',
      walletId: 'pg-wallet-rollback',
      mint: 'pg-mint-rollback',
      initialAmountAtomic: 100_000n,
      initialPrincipalLamports: 15_000_000n
    });

    // Tentativa com versão errada deve dar rollback limpo
    await assert.rejects(
      async () => {
        await repo.updatePositionCAS({
          positionId: 'pg-pos-rollback',
          expectedVersion: 999n, // Stale
          newAmountAtomic: 50_000n,
          mutationType: 'PARTIAL_FILL'
        });
      },
      StalePositionVersionError
    );

    // Posição deve continuar inalterada na versão 1n com 100.000 tokens
    const pos = await repo.getPosition('pg-pos-rollback');
    assert.strictEqual(pos?.positionVersion, 1n);
    assert.strictEqual(pos?.tokenAmountAtomic, 100_000n);

    // Tabela de mutações deve conter apenas a mutação inicial ENTRY_OPEN
    const mutRes = await pool.query(
      'SELECT COUNT(*) FROM nexus_position_mutations_v2 WHERE position_id = $1;',
      ['pg-pos-rollback']
    );
    assert.strictEqual(Number(mutRes.rows[0].count), 1);
  });
});
