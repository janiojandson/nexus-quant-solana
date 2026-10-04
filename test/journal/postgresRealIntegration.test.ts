/**
 * Nexus Quant Solana — V2.1B Real PostgreSQL Integration Test Suite
 *
 * Validates against a REAL, PHYSICAL PostgreSQL instance:
 * 1. Database version proof via SELECT version();
 * 2. Real migration execution & idempotency verification.
 * 3. Physical schema catalog inspection (information_schema, pg_indexes, pg_constraint, pg_trigger).
 * 4. Real append-only trigger: UPDATE and DELETE rejections on fill_ledger.
 * 5. Real FOR UPDATE SKIP LOCKED concurrency across 2 independent connections.
 * 6. Real partial unique index: uq_active_intent_wallet_mint blocking concurrent active intents with SQLSTATE 23505.
 * 7. Real fencing epoch rejection: rowCount = 0 mapped to StaleEpochError.
 * 8. Real fill concurrency: concurrent inserts result in exactly 1 row.
 * 9. Real crash / transaction boundary: atomic ROLLBACK vs COMMIT.
 * 10. Security audit: scan persisted data for secrets.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Pool } from 'pg';
import { PostgresJournalRepository } from '../../src/journal/postgresRepository';
import {
  StaleEpochError,
  ActiveIntentExclusionError,
  FillRecord,
  nowWallMs
} from '../../src/journal/types';
import { LeaseRecoveryBlockedError } from '../../src/journal/repository';

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ||
  'postgresql://test_nexus_user:descartavel_secret_pass_123@localhost:55432/test_nexus_journal';

describe('Nexus V2.1B — Real PostgreSQL Integration (V2.1B-H)', () => {
  let pool: Pool;
  let repo: PostgresJournalRepository;
  let pgVersionString: string = '';

  before(async () => {
    // Proibir terminantemente credenciais Railway
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

    repo = new PostgresJournalRepository(pool);
  });

  const resetTables = async () => {
    await pool.query('TRUNCATE TABLE fill_ledger, execution_reconciliation_events, intent_severity_events, execution_attempts, exit_intents CASCADE;');
  };

  after(async () => {
    if (pool) {
      await pool.end();
    }
  });

  it('1. Prova de Versão Real: executa SELECT version() e comprova PostgreSQL físico', async () => {
    const res = await pool.query('SELECT version();');
    assert.ok(res.rows.length > 0);
    pgVersionString = res.rows[0].version;
    console.log(`[REAL POSTGRES VERSION PROOF]: ${pgVersionString}`);

    assert.ok(
      pgVersionString.toLowerCase().includes('postgresql 16'),
      `Versão deve ser PostgreSQL 16 real. Obtido: ${pgVersionString}`
    );
  });

  it('2. Aplicação de Migration Real e Idempotência: aplica DDL e reaplica sem erros', async () => {
    const migrationPath = path.resolve(process.cwd(), 'migrations/001_v2_1_durable_exit_journal.sql');
    const ddl = fs.readFileSync(migrationPath, 'utf8');

    // Primeira aplicação (banco vazio ou existente)
    await pool.query(ddl);

    // Segunda aplicação (comprova idempotência estrita)
    await pool.query(ddl);
  });

  it('3. Inspeção de Catálogo Real: information_schema, pg_indexes, pg_constraint e pg_trigger', async () => {
    // Tabelas
    const tablesRes = await pool.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name"
    );
    const tableNames = tablesRes.rows.map((r: any) => r.table_name);
    assert.ok(tableNames.includes('exit_intents'), 'exit_intents deve existir fisicamente');
    assert.ok(tableNames.includes('execution_attempts'), 'execution_attempts deve existir fisicamente');
    assert.ok(tableNames.includes('intent_severity_events'), 'intent_severity_events deve existir fisicamente');
    assert.ok(tableNames.includes('fill_ledger'), 'fill_ledger deve existir fisicamente');
    assert.ok(tableNames.includes('execution_reconciliation_events'), 'execution_reconciliation_events deve existir fisicamente');

    // Colunas e Tipos
    const colsRes = await pool.query(
      "SELECT table_name, column_name, data_type, numeric_precision FROM information_schema.columns WHERE table_schema = 'public'"
    );
    const cols = colsRes.rows;

    const findCol = (t: string, c: string) => cols.find((x: any) => x.table_name === t && x.column_name === c);

    // NUMERIC(38,0)
    assert.strictEqual(findCol('exit_intents', 'requested_amount_atomic')?.data_type, 'numeric');
    assert.strictEqual(Number(findCol('exit_intents', 'requested_amount_atomic')?.numeric_precision), 38);

    // claim_epoch BIGINT
    assert.strictEqual(findCol('exit_intents', 'claim_epoch')?.data_type, 'bigint');

    // last_valid_block_height BIGINT
    assert.strictEqual(findCol('execution_attempts', 'last_valid_block_height')?.data_type, 'bigint');

    // Índices
    const idxRes = await pool.query(
      "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public'"
    );
    const uqActiveIdx = idxRes.rows.find((r: any) => r.indexname === 'uq_active_intent_wallet_mint');
    assert.ok(uqActiveIdx, 'Partial unique index uq_active_intent_wallet_mint deve existir no catálogo');
    assert.ok(uqActiveIdx.indexdef.includes('UNIQUE INDEX'));
    assert.ok(uqActiveIdx.indexdef.includes('WHERE'));

    // Triggers
    const trgRes = await pool.query(
      "SELECT tgname FROM pg_trigger WHERE tgname = 'trg_fill_ledger_immutable'"
    );
    assert.ok(trgRes.rows.length > 0, 'Trigger trg_fill_ledger_immutable deve existir no catálogo');
  });

  it('4. Trigger Append-Only Real: PostgreSQL bloqueia UPDATE e DELETE em fill_ledger', async () => {
    await resetTables();
    // 1. Cria intent e attempt para satisfazer FKs
    const wallet = '4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM';
    const mint = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
    const intentRes = await repo.createOrGetIntent({
      tradeId: 'trade_trg_test' as any,
      positionId: 'pos_trg_test' as any,
      walletId: wallet,
      mint,
      tokenProgram: 'prog',
      requestedAmountAtomic: '1000',
      amountPolicy: 'EXACT_ATOMIC',
      initialSeverity: 'ROUTINE',
      reason: 'TAKE_PROFIT_ROUTINE',
      policyVersion: 'v2.1'
    });

    const attempt = await repo.prepareAttempt({
      attemptId: 'att_trg_test' as any,
      intentId: intentRes.intent.id,
      provider: 'JUPITER_V2',
      requestedAmountAtomic: '1000'
    });

    const fillId = 'fill_trg_immutable_1';
    await repo.recordFill({
      id: fillId as any,
      tradeId: 'trade_trg_test' as any,
      positionId: 'pos_trg_test' as any,
      intentId: intentRes.intent.id,
      attemptId: attempt.attemptId,
      signature: 'sig_trg_immutable_999',
      realizationSequence: 1,
      chainLegIndex: 0,
      instructionIndex: 2,
      innerInstructionIndex: 0,
      assetMint: mint,
      requestedAmountAtomic: '1000',
      actualAmountAtomic: '1000',
      grossProceedsLamports: '100000000',
      networkFeeLamports: '5000',
      priorityFeeLamports: '10000',
      tipLamports: '0',
      rentMovementLamports: '0',
      confirmedAtWallMs: nowWallMs(),
      evidenceType: 'RPC_CONFIRMED',
      createdAtWallMs: nowWallMs()
    });

    // Tentativa real de UPDATE direto no PostgreSQL
    await assert.rejects(
      async () => {
        await pool.query(
          'UPDATE fill_ledger SET gross_proceeds_lamports = 999999999 WHERE id = $1',
          [fillId]
        );
      },
      (err: any) => {
        assert.ok(
          err.message.includes('MUTATION FORBIDDEN') || err.message.includes('fill_ledger is strictly append-only'),
          `Erro do PostgreSQL deve ser do trigger append-only. Obtido: ${err.message}`
        );
        return true;
      }
    );

    // Tentativa real de DELETE direto no PostgreSQL
    await assert.rejects(
      async () => {
        await pool.query('DELETE FROM fill_ledger WHERE id = $1', [fillId]);
      },
      (err: any) => {
        assert.ok(
          err.message.includes('MUTATION FORBIDDEN') || err.message.includes('fill_ledger is strictly append-only'),
          `Erro do PostgreSQL deve ser do trigger append-only. Obtido: ${err.message}`
        );
        return true;
      }
    );
  });

  it('5. FOR UPDATE SKIP LOCKED Real: duas conexões concorrentes - conexão B ignora linha bloqueada por A', async () => {
    await resetTables();
    // Insere dois intents independentes
    const intent1Res = await repo.createOrGetIntent({
      tradeId: 'trade_skip_1' as any,
      positionId: 'pos_skip_1' as any,
      walletId: 'w_skip_1',
      mint: 'm_skip_1',
      tokenProgram: 'prog',
      requestedAmountAtomic: '100',
      amountPolicy: 'EXACT_ATOMIC',
      initialSeverity: 'ROUTINE',
      reason: 'TAKE_PROFIT_ROUTINE',
      policyVersion: 'v2.1'
    });

    const intent2Res = await repo.createOrGetIntent({
      tradeId: 'trade_skip_2' as any,
      positionId: 'pos_skip_2' as any,
      walletId: 'w_skip_2',
      mint: 'm_skip_2',
      tokenProgram: 'prog',
      requestedAmountAtomic: '200',
      amountPolicy: 'EXACT_ATOMIC',
      initialSeverity: 'ROUTINE',
      reason: 'TAKE_PROFIT_ROUTINE',
      policyVersion: 'v2.1'
    });

    const connA = await pool.connect();

    try {
      // Conexão A abre transação e segura lock exclusivo em intent1
      await connA.query('BEGIN');
      const lockRes = await connA.query(
        'SELECT * FROM exit_intents WHERE id = $1 FOR UPDATE',
        [intent1Res.intent.id]
      );
      assert.strictEqual(lockRes.rows.length, 1);

      // Conexão B (via pool) executa claim com FOR UPDATE SKIP LOCKED
      // Graças ao SKIP LOCKED real do PostgreSQL, Conexão B NÃO bloqueia e reivindica intent2
      const claimedB = await repo.claimNextIntent({
        workerId: 'worker_b_real',
        leaseDurationMs: 15_000
      });

      assert.ok(claimedB, 'Conexão B deve receber um intent');
      assert.strictEqual(
        claimedB?.id,
        intent2Res.intent.id,
        'Conexão B deve pular intent1 bloqueado e reivindicar intent2'
      );
      assert.strictEqual(claimedB?.claimedBy, 'worker_b_real');

      // Conexão A finaliza sua transação
      await connA.query('COMMIT');
    } finally {
      connA.release();
    }
  });

  it('6. Partial Unique Index Real: PostgreSQL emite SQLSTATE 23505 para duplicatas ativas e autoriza após APPLIED', async () => {
    await resetTables();
    const runId = Date.now();
    const wallet = `Wallet_PU_${runId}`;
    const mint = `Mint_PU_${runId}`;

    // 1. Cria Intent A em CREATED
    const { intent: intentA, created: createdA } = await repo.createOrGetIntent({
      tradeId: `trade_pu_1_${runId}` as any,
      positionId: `pos_pu_1_${runId}` as any,
      walletId: wallet,
      mint,
      tokenProgram: 'prog',
      requestedAmountAtomic: '500',
      amountPolicy: 'EXACT_ATOMIC',
      initialSeverity: 'ROUTINE',
      reason: 'TAKE_PROFIT_ROUTINE',
      policyVersion: 'v2.1'
    });
    assert.strictEqual(createdA, true);

    // 2. Tentativa direta de INSERT no PostgreSQL violando o partial index
    await assert.rejects(
      async () => {
        await pool.query(
          `INSERT INTO exit_intents (
            id, trade_id, position_id, wallet_id, mint, token_program, requested_amount_atomic,
            amount_policy, initial_severity, current_severity, reason, policy_version,
            economic_dedupe_key, expires_at, status
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW() + INTERVAL '1 hour', 'CREATED')`,
          [
            `intent_b_conflict_${runId}`,
            `trade_pu_2_${runId}`,
            `pos_pu_1_${runId}`,
            wallet,
            mint,
            'prog',
            '800',
            'EXACT_ATOMIC',
            'CRITICAL',
            'CRITICAL',
            'STOP_LOSS',
            'v2.1',
            `dedupe_key_b_${runId}`
          ]
        );
      },
      (err: any) => {
        assert.strictEqual(err.code, '23505', 'PostgreSQL deve retornar SQLSTATE 23505 (unique_violation)');
        assert.ok(err.message.includes('uq_active_intent_wallet_mint'));
        return true;
      }
    );

    // 3. Testa quando Intent A transiciona para SUBMITTED, UNKNOWN, CONFIRMED
    const testStatuses = ['SUBMITTED', 'UNKNOWN', 'CONFIRMED'];
    for (const st of testStatuses) {
      await pool.query('UPDATE exit_intents SET status = $1 WHERE id = $2', [st, intentA.id]);

      await assert.rejects(
        async () => {
          await pool.query(
            `INSERT INTO exit_intents (
              id, trade_id, position_id, wallet_id, mint, token_program, requested_amount_atomic,
              amount_policy, initial_severity, current_severity, reason, policy_version,
              economic_dedupe_key, expires_at, status
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW() + INTERVAL '1 hour', 'CREATED')`,
            [
              `intent_b_conflict_${st}`,
              'trade_pu_2',
              'pos_pu_1',
              wallet,
              mint,
              'prog',
              '800',
              'EXACT_ATOMIC',
              'CRITICAL',
              'CRITICAL',
              'STOP_LOSS',
              'v2.1',
              `dedupe_key_${st}`
            ]
          );
        },
        (err: any) => {
          assert.strictEqual(err.code, '23505');
          return true;
        }
      );
    }

    // 4. Intent A torna-se terminal: APPLIED
    await pool.query("UPDATE exit_intents SET status = 'APPLIED' WHERE id = $1", [intentA.id]);

    // 5. Agora a inserção de Intent B para o mesmo (wallet, mint) DEVE ter sucesso no PostgreSQL real!
    const resB = await pool.query(
      `INSERT INTO exit_intents (
        id, trade_id, position_id, wallet_id, mint, token_program, requested_amount_atomic,
        amount_policy, initial_severity, current_severity, reason, policy_version,
        economic_dedupe_key, expires_at, status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW() + INTERVAL '1 hour', 'CREATED') RETURNING id`,
      [
        'intent_b_permitted_after_applied',
        'trade_pu_2',
        'pos_pu_1',
        wallet,
        mint,
        'prog',
        '800',
        'EXACT_ATOMIC',
        'CRITICAL',
        'CRITICAL',
        'STOP_LOSS',
        'v2.1',
        'dedupe_key_allowed'
      ]
    );
    assert.strictEqual(resB.rows.length, 1);
    assert.strictEqual(resB.rows[0].id, 'intent_b_permitted_after_applied');
  });

  it('7. Fencing Epoch Real: rowCount = 0 no UPDATE do PostgreSQL lança StaleEpochError', async () => {
    await resetTables();
    const { intent } = await repo.createOrGetIntent({
      tradeId: 'trade_fencing_real' as any,
      positionId: 'pos_fencing_real' as any,
      walletId: 'w_fencing_real',
      mint: 'm_fencing_real',
      tokenProgram: 'prog',
      requestedAmountAtomic: '333',
      amountPolicy: 'EXACT_ATOMIC',
      initialSeverity: 'ROUTINE',
      reason: 'TAKE_PROFIT_ROUTINE',
      policyVersion: 'v2.1'
    });

    // Worker A claims -> claim_epoch = 1
    const claimedA = await repo.claimIntent({
      intentId: intent.id,
      workerId: 'worker_a_real',
      leaseDurationMs: 100
    });
    assert.ok(claimedA);
    assert.strictEqual(claimedA?.claimEpoch, 1n);

    // Simula expiração de lease
    await pool.query(
      "UPDATE exit_intents SET lease_expires_at = NOW() - INTERVAL '10 seconds' WHERE id = $1",
      [intent.id]
    );

    // Worker B claims -> claim_epoch = 2
    const claimedB = await repo.claimIntent({
      intentId: intent.id,
      workerId: 'worker_b_real',
      leaseDurationMs: 30_000
    });
    assert.ok(claimedB);
    assert.strictEqual(claimedB?.claimEpoch, 2n);

    // Worker A (zombie) tenta atualizar com expectedEpoch = 1
    // No PostgreSQL real, a query WHERE claim_epoch = 1 retorna rowCount = 0
    await assert.rejects(
      async () => {
        await repo.updateIntentSeverity(
          intent.id,
          'CRITICAL',
          'STOP_LOSS_CRITICAL',
          'obs_zombie_real',
          1n // expectedEpoch defasado
        );
      },
      (err: any) => {
        assert.ok(err instanceof StaleEpochError);
        assert.strictEqual(BigInt(err.expectedEpoch), 1n);
        assert.strictEqual(BigInt(err.actualEpoch), 2n);
        return true;
      }
    );
  });

  it('8. Fill Concurrency Real: transações concorrentes inserindo mesmo fill resultam em exatamente 1 linha (COUNT(*) = 1)', async () => {
    await resetTables();
    const { intent } = await repo.createOrGetIntent({
      tradeId: 'trade_fill_conc_real' as any,
      positionId: 'pos_fill_conc_real' as any,
      walletId: 'w_fill_conc_real',
      mint: 'm_fill_conc_real',
      tokenProgram: 'prog',
      requestedAmountAtomic: '1000',
      amountPolicy: 'EXACT_ATOMIC',
      initialSeverity: 'ROUTINE',
      reason: 'TAKE_PROFIT_ROUTINE',
      policyVersion: 'v2.1'
    });

    const attempt = await repo.prepareAttempt({
      attemptId: 'att_fill_conc_real' as any,
      intentId: intent.id,
      provider: 'JUPITER_V2',
      requestedAmountAtomic: '1000'
    });

    const fillPayload: FillRecord = {
      id: 'fill_real_conc_1' as any,
      tradeId: intent.tradeId,
      positionId: intent.positionId,
      intentId: intent.id,
      attemptId: attempt.attemptId,
      signature: 'sig_fill_conc_unique_123',
      realizationSequence: 1,
      chainLegIndex: 0,
      instructionIndex: 3,
      innerInstructionIndex: 0,
      assetMint: 'm_fill_conc_real',
      requestedAmountAtomic: '1000',
      actualAmountAtomic: '1000',
      grossProceedsLamports: '350000000',
      networkFeeLamports: '5000',
      priorityFeeLamports: '10000',
      tipLamports: '0',
      rentMovementLamports: '0',
      confirmedAtWallMs: nowWallMs(),
      evidenceType: 'RPC_CONFIRMED',
      createdAtWallMs: nowWallMs()
    };

    // Dispara 2 gravações simultâneas através de 2 conexões distintas do pool
    const [res1, res2] = await Promise.all([
      repo.recordFill(fillPayload),
      repo.recordFill({ ...fillPayload, id: 'fill_real_conc_duplicate' as any })
    ]);

    // Uma delas deve reportar created: true, a outra created: false
    const createdCount = (res1.created ? 1 : 0) + (res2.created ? 1 : 0);
    assert.strictEqual(createdCount, 1, 'Exatamente 1 operação deve criar a linha no banco');

    // Confere via SELECT COUNT(*) no PostgreSQL real
    const countRes = await pool.query(
      'SELECT COUNT(*) FROM fill_ledger WHERE signature = $1',
      [fillPayload.signature]
    );
    assert.strictEqual(Number(countRes.rows[0].count), 1, 'COUNT(*) deve ser exatamente 1 no PostgreSQL');
  });

  it('9. Crash / Transaction Boundary Real: atomicidade com ROLLBACK vs COMMIT', async () => {
    await resetTables();
    const { intent } = await repo.createOrGetIntent({
      tradeId: 'trade_tx_boundary' as any,
      positionId: 'pos_tx_boundary' as any,
      walletId: 'w_tx_boundary',
      mint: 'm_tx_boundary',
      tokenProgram: 'prog',
      requestedAmountAtomic: '1000',
      amountPolicy: 'EXACT_ATOMIC',
      initialSeverity: 'ROUTINE',
      reason: 'TAKE_PROFIT_ROUTINE',
      policyVersion: 'v2.1'
    });

    const attempt = await repo.prepareAttempt({
      attemptId: 'att_tx_boundary' as any,
      intentId: intent.id,
      provider: 'JUPITER_V2',
      requestedAmountAtomic: '1000'
    });

    // Cenário 1: Crash simulado com ROLLBACK
    const client1 = await pool.connect();
    try {
      await client1.query('BEGIN');
      await client1.query(
        `INSERT INTO fill_ledger (
          id, trade_id, position_id, intent_id, attempt_id, signature, realization_sequence,
          requested_amount_atomic, actual_amount_atomic, gross_proceeds_lamports, evidence_type
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          'fill_aborted_by_crash',
          intent.tradeId,
          intent.positionId,
          intent.id,
          attempt.attemptId,
          'sig_aborted_111',
          1,
          '1000',
          '1000',
          '500000',
          'RPC_CONFIRMED'
        ]
      );
      await client1.query("UPDATE exit_intents SET status = 'APPLIED' WHERE id = $1", [intent.id]);

      // Processo morre / erro -> ROLLBACK
      await client1.query('ROLLBACK');
    } finally {
      client1.release();
    }

    // Comprova que NENHUM estado parcial foi gravado
    const checkFill1 = await pool.query('SELECT * FROM fill_ledger WHERE id = $1', ['fill_aborted_by_crash']);
    assert.strictEqual(checkFill1.rows.length, 0, 'Nenhum fill deve existir após ROLLBACK');

    const checkIntent1 = await pool.query('SELECT status FROM exit_intents WHERE id = $1', [intent.id]);
    assert.strictEqual(checkIntent1.rows[0].status, 'PREPARED', 'Status do intent não deve ter mudado');

    // Cenário 2: Execução atômica com COMMIT
    const client2 = await pool.connect();
    try {
      await client2.query('BEGIN');
      await client2.query(
        `INSERT INTO fill_ledger (
          id, trade_id, position_id, intent_id, attempt_id, signature, realization_sequence,
          requested_amount_atomic, actual_amount_atomic, gross_proceeds_lamports, evidence_type
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          'fill_committed_atomically',
          intent.tradeId,
          intent.positionId,
          intent.id,
          attempt.attemptId,
          'sig_committed_222',
          1,
          '1000',
          '1000',
          '500000',
          'RPC_CONFIRMED'
        ]
      );
      await client2.query("UPDATE exit_intents SET status = 'APPLIED', reconciliation_debt = false WHERE id = $1", [intent.id]);
      await client2.query('COMMIT');
    } finally {
      client2.release();
    }

    // Comprova que estado completo foi gravado
    const checkFill2 = await pool.query('SELECT * FROM fill_ledger WHERE id = $1', ['fill_committed_atomically']);
    assert.strictEqual(checkFill2.rows.length, 1);

    const checkIntent2 = await pool.query('SELECT status, reconciliation_debt FROM exit_intents WHERE id = $1', [intent.id]);
    assert.strictEqual(checkIntent2.rows[0].status, 'APPLIED');
    assert.strictEqual(checkIntent2.rows[0].reconciliation_debt, false);
  });

  it('10. Auditoria de Segurança no PostgreSQL Real: varredura de dados reais garante zero segredos', async () => {
    const resIntents = await pool.query('SELECT * FROM exit_intents');
    const resAttempts = await pool.query('SELECT * FROM execution_attempts');
    const resFills = await pool.query('SELECT * FROM fill_ledger');

    const allData = JSON.stringify({
      intents: resIntents.rows,
      attempts: resAttempts.rows,
      fills: resFills.rows
    });

    const forbidden = ['privatekey', 'secretkey', 'seed', 'bearer', 'authorization', 'jup_api_key'];
    for (const kw of forbidden) {
      assert.strictEqual(
        allData.toLowerCase().includes(kw),
        false,
        `Nenhum segredo (${kw}) deve constar nos dados persistidos no PostgreSQL real`
      );
    }
  });

});
