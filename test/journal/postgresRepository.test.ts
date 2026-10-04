import test from 'node:test';
import * as assert from 'node:assert/strict';
import { PostgresJournalRepository } from '../../src/journal/postgresRepository';
import {
  EconomicConflictError,
  LeaseRecoveryBlockedError
} from '../../src/journal/repository';
import {
  StaleEpochError,
  ActiveIntentExclusionError
} from '../../src/journal/types';

test('Nexus V2.1B — PostgresJournalRepository Implementation & Contract Tests (C1)', async (t) => {
  // 1. Instanciação e mapeamento de pool
  await t.test('1. PostgresJournalRepository instancia com pool e expõe IExitJournalRepository', () => {
    const mockPool: any = { query: async () => ({ rows: [] }) };
    const repo = new PostgresJournalRepository(mockPool);
    assert.ok(repo.getPool());
    assert.strictEqual(typeof repo.createOrGetIntent, 'function');
    assert.strictEqual(typeof repo.claimIntent, 'function');
    assert.strictEqual(typeof repo.updateAttemptState, 'function');
    assert.strictEqual(typeof repo.recordFill, 'function');
  });

  // 2. createOrGetIntent executa validação de colisão de dedupeKey e exclusão ativa
  await t.test('2. createOrGetIntent emite queries corretas com ON CONFLICT (economic_dedupe_key)', async () => {
    const executedQueries: Array<{ sql: string; params: any[] }> = [];

    const mockPool: any = {
      query: async (sql: string, params: any[]) => {
        executedQueries.push({ sql, params });
        if (sql.includes('SELECT * FROM exit_intents WHERE economic_dedupe_key')) {
          return { rows: [] }; // No existing by dedupeKey
        }
        if (sql.includes('SELECT id, status, reconciliation_debt FROM exit_intents')) {
          return { rows: [] }; // No active intent on (wallet, mint)
        }
        if (sql.includes('INSERT INTO exit_intents')) {
          return {
            rows: [{
              id: params[0],
              trade_id: params[1],
              position_id: params[2],
              wallet_id: params[3],
              mint: params[4],
              token_program: params[5],
              position_version: params[6],
              requested_amount_atomic: params[7],
              amount_policy: params[8],
              initial_severity: params[9],
              current_severity: params[10],
              reason: params[11],
              policy_version: params[12],
              economic_dedupe_key: params[13],
              claimed_by: null,
              claim_epoch: 0,
              claimed_at: null,
              lease_expires_at: null,
              created_at: new Date(1_000_000),
              expires_at: new Date(1_060_000),
              status: 'CREATED',
              superseded_by: null,
              reconciliation_debt: false
            }]
          };
        }
        return { rows: [] };
      }
    };

    const repo = new PostgresJournalRepository(mockPool);
    const result = await repo.createOrGetIntent({
      tradeId: 'trade_pg_1' as any,
      positionId: 'pos_pg_1' as any,
      walletId: 'Wallet1111111111111111111111111111111111',
      mint: '3A75w27ssueStCEEp6KGxKJ3EtP57P9FxT6YxHmDnt7a',
      tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      positionVersion: 1,
      requestedAmountAtomic: '4375826130',
      amountPolicy: 'FULL_REMAINDER',
      initialSeverity: 'NORMAL',
      reason: 'TRAILING_STOP',
      policyVersion: '2026-10-04'
    });

    assert.strictEqual(result.created, true);
    assert.strictEqual(result.intent.status, 'CREATED');
    assert.strictEqual(result.intent.claimEpoch, 0);

    // Confere que houve query de dedupeKey, query de exclusão ativa e INSERT
    assert.ok(executedQueries.some(q => q.sql.includes('WHERE economic_dedupe_key = $1')));
    assert.ok(executedQueries.some(q => q.sql.includes('WHERE wallet_id = $1 AND mint = $2')));
    assert.ok(executedQueries.some(q => q.sql.includes('INSERT INTO exit_intents')));
  });

  // 3. createOrGetIntent lança ActiveIntentExclusionError se existir intent economicamente ativa
  await t.test('3. createOrGetIntent mapeia exclusão ativa para ActiveIntentExclusionError', async () => {
    const mockPool: any = {
      query: async (sql: string) => {
        if (sql.includes('WHERE economic_dedupe_key = $1')) {
          return { rows: [] };
        }
        if (sql.includes('SELECT id, status, reconciliation_debt FROM exit_intents')) {
          return { rows: [{ id: 'intent_active_prior', status: 'SUBMITTED', reconciliation_debt: true }] };
        }
        return { rows: [] };
      }
    };

    const repo = new PostgresJournalRepository(mockPool);
    await assert.rejects(
      () => repo.createOrGetIntent({
        tradeId: 'trade_pg_conflict' as any,
        positionId: 'pos_pg_conflict' as any,
        walletId: 'Wallet1111111111111111111111111111111111',
        mint: '3A75w27ssueStCEEp6KGxKJ3EtP57P9FxT6YxHmDnt7a',
        tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
        positionVersion: 2,
        requestedAmountAtomic: '999999',
        amountPolicy: 'CUSTOM',
        initialSeverity: 'EMERGENCY',
        reason: 'STOP_LOSS',
        policyVersion: '2026-10-04'
      }),
      (err: any) => {
        assert.ok(err instanceof ActiveIntentExclusionError);
        assert.strictEqual(err.activeIntentId, 'intent_active_prior');
        assert.strictEqual(err.activeStatus, 'SUBMITTED');
        return true;
      }
    );
  });

  // 4. claimIntent executa FOR UPDATE SKIP LOCKED em transação real
  await t.test('4. claimIntent executa FOR UPDATE SKIP LOCKED e incrementa claim_epoch', async () => {
    const clientQueries: Array<{ sql: string; params?: any[] }> = [];

    const mockClient = {
      query: async (sql: string, params?: any[]) => {
        clientQueries.push({ sql, params });
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
          return { rows: [] };
        }
        if (sql.includes('FOR UPDATE SKIP LOCKED')) {
          return {
            rows: [{
              id: 'intent_claimable_1',
              trade_id: 'trade_1',
              position_id: 'pos_1',
              wallet_id: 'W1',
              mint: 'M1',
              token_program: 'T1',
              requested_amount_atomic: '1000',
              amount_policy: 'FULL_REMAINDER',
              initial_severity: 'NORMAL',
              current_severity: 'NORMAL',
              reason: 'TRAILING_STOP',
              policy_version: '2026-10-04',
              economic_dedupe_key: 'dedupe_1',
              claim_epoch: 0,
              status: 'CREATED',
              created_at: new Date(1_000_000),
              expires_at: new Date(1_060_000),
              reconciliation_debt: false
            }]
          };
        }
        if (sql.includes('UPDATE exit_intents')) {
          return {
            rows: [{
              id: 'intent_claimable_1',
              trade_id: 'trade_1',
              position_id: 'pos_1',
              wallet_id: 'W1',
              mint: 'M1',
              token_program: 'T1',
              requested_amount_atomic: '1000',
              amount_policy: 'FULL_REMAINDER',
              initial_severity: 'NORMAL',
              current_severity: 'NORMAL',
              reason: 'TRAILING_STOP',
              policy_version: '2026-10-04',
              economic_dedupe_key: 'dedupe_1',
              claimed_by: 'worker_alpha',
              claim_epoch: 1,
              claimed_at: new Date(1_000_100),
              lease_expires_at: new Date(1_010_100),
              status: 'CLAIMED',
              created_at: new Date(1_000_000),
              expires_at: new Date(1_060_000),
              reconciliation_debt: false
            }]
          };
        }
        return { rows: [] };
      },
      release: () => {}
    };

    const mockPool: any = {
      connect: async () => mockClient
    };

    const repo = new PostgresJournalRepository(mockPool);
    const claimed = await repo.claimIntent({
      workerId: 'worker_alpha',
      leaseDurationMs: 10_000,
      nowMs: 1_000_100
    });

    assert.ok(claimed !== null);
    assert.strictEqual(claimed.claimedBy, 'worker_alpha');
    assert.strictEqual(claimed.claimEpoch, 1);
    assert.strictEqual(claimed.status, 'CLAIMED');

    // Confere protocolo de transação
    assert.strictEqual(clientQueries[0].sql, 'BEGIN');
    assert.ok(clientQueries.some(q => q.sql.includes('FOR UPDATE SKIP LOCKED')));
    assert.ok(clientQueries.some(q => q.sql.includes('WHERE id = $4 AND claim_epoch = $5')));
    assert.strictEqual(clientQueries[clientQueries.length - 1].sql, 'COMMIT');
  });

  // 5. Fencing Epoch: mutação com expectedEpoch defasado lança StaleEpochError
  await t.test('5. updateAttemptState com expectedEpoch defasado lança StaleEpochError', async () => {
    const mockClient = {
      query: async (sql: string) => {
        if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] };
        if (sql.includes('SELECT * FROM execution_attempts WHERE attempt_id = $1')) {
          return { rows: [{ attempt_id: 'att_1', intent_id: 'intent_stale_1', state: 'ORDER_READY' }] };
        }
        if (sql.includes('SELECT * FROM exit_intents WHERE id = $1')) {
          // Intent já foi assumido por outro worker com claim_epoch = 2!
          return { rows: [{ id: 'intent_stale_1', claim_epoch: 2, status: 'CLAIMED' }] };
        }
        return { rows: [] };
      },
      release: () => {}
    };

    const mockPool: any = {
      connect: async () => mockClient
    };

    const repo = new PostgresJournalRepository(mockPool);
    // Worker zumbi tenta mutar com expectedEpoch = 1
    await assert.rejects(
      () => repo.updateAttemptState('att_1', 'ORDER_READY', { requestId: 'req_stale' }, 1),
      (err: any) => {
        assert.ok(err instanceof StaleEpochError);
        assert.strictEqual(err.expectedEpoch, 1);
        assert.strictEqual(err.actualEpoch, 2);
        return true;
      }
    );
  });

  // 6. Lease Recovery Blocked: Lease expirada com tentativa em SUBMITTED lança LeaseRecoveryBlockedError
  await t.test('6. claimIntent bloqueia re-claim de lease expirada se attempt estiver em SUBMITTED', async () => {
    const mockClient = {
      query: async (sql: string) => {
        if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] };
        if (sql.includes('FOR UPDATE SKIP LOCKED')) {
          return {
            rows: [{
              id: 'intent_expired_unreconciled',
              status: 'CLAIMED',
              lease_expires_at: new Date(500_000), // Expirado
              claim_epoch: 1,
              reconciliation_debt: true
            }]
          };
        }
        if (sql.includes('SELECT attempt_id, state FROM execution_attempts')) {
          return { rows: [{ attempt_id: 'att_submitted', state: 'SUBMITTED' }] };
        }
        return { rows: [] };
      },
      release: () => {}
    };

    const mockPool: any = {
      connect: async () => mockClient
    };

    const repo = new PostgresJournalRepository(mockPool);
    await assert.rejects(
      () => repo.claimIntent({ workerId: 'worker_recoverer', leaseDurationMs: 10_000, nowMs: 600_000 }),
      (err: any) => {
        assert.ok(err instanceof LeaseRecoveryBlockedError);
        assert.strictEqual(err.blockingAttemptState, 'SUBMITTED');
        return true;
      }
    );
  });
});
