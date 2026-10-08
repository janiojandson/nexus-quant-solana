import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { SentinelHandoffScanner, type SentinelHandoffToken } from './sentinelHandoffScanner.js';

test('handoff outcome persists exact status and detail without propagating database errors', async () => {
  const calls: any[] = [];
  const scanner = new SentinelHandoffScanner({ query: async (config: any) => {
    calls.push({ sql: config.text, params: config.values, timeout: config.query_timeout }); return { rowCount: 1 };
  } } as any);
  await scanner.recordHandoffOutcome('mint', 'DISCARDED_RUGCHECK', 'Top5 81.5%');
  assert.deepEqual(calls[0].params, ['DISCARDED_RUGCHECK', 'Top5 81.5%', 'mint']);
  assert.match(calls[0].sql, /outcome_recorded_at = NOW\(\)/);
  assert.equal(calls[0].timeout, 5000);
  await new SentinelHandoffScanner(null).recordHandoffOutcome('mint', 'FAILED_SWAP');
  await new SentinelHandoffScanner({ query: async () => { throw new Error('db unavailable'); } } as any)
    .recordHandoffOutcome('mint', 'FAILED_SWAP', 'timeout');
});

// ===========================================================
// Mocks de Pool Postgres
// ===========================================================

function makePool(overrides: Partial<{
  queryResults: Record<string, any>;
  lockRowCount: number;
  throwOnTable: boolean;
  throwOnLock: boolean;
}> = {}) {
  const results: Record<string, any> = overrides.queryResults ?? {};
  const lockRowCount = overrides.lockRowCount ?? 1;

  return {
    query: async (sql: string, params?: unknown[]) => {
      const sqlTrimmed = String(sql).trim().toLowerCase();

      // Schema migration
      if (sqlTrimmed.includes('alter table')) {
        if (overrides.throwOnTable) throw new Error('relation "sentinel_handoff" does not exist');
        return { rowCount: 0, rows: [] };
      }

      // Lock atomico UPDATE
      if (sqlTrimmed.includes('update sentinel_handoff')) {
        if (overrides.throwOnLock) throw new Error('lock error');
        return { rowCount: lockRowCount, rows: [] };
      }

      // SELECT de candidatos
      if (sqlTrimmed.includes('select mint')) {
        const key = params ? String(params[0]) : 'default';
        return { rowCount: (results[key] ?? results['default'] ?? []).length, rows: results[key] ?? results['default'] ?? [] };
      }

      return { rowCount: 0, rows: [] };
    }
  };
}

// ===========================================================
// Testes
// ===========================================================

describe('SentinelHandoffScanner', () => {

  test('deve emitir sentinelGraduationToken ao capturar token elegível', async () => {
    const mockRow = {
      mint: 'TokenMint111111111111111111111111111111111111',
      symbol: 'GRAD',
      dev_wallet: 'DevWalletAbc',
      laya_score: '87.5',
      pnl_percent: '45.2',
      created_at: new Date(Date.now() - 60_000)
    };

    const pool = makePool({ queryResults: { default: [mockRow] }, lockRowCount: 1 });
    const scanner = new SentinelHandoffScanner(pool as any, { pollingIntervalMs: 9999 });

    const received: SentinelHandoffToken[] = [];
    scanner.on('sentinelGraduationToken', (token) => received.push(token));

    await scanner.start();
    // Acessa o método privado poll() através de reflexão para testar sem aguardar intervalo
    await (scanner as any).poll();

    assert.strictEqual(received.length, 1, 'Deve emitir exatamente 1 evento');
    assert.strictEqual(received[0].mint, mockRow.mint);
    assert.strictEqual(received[0].symbol, 'GRAD');
    assert.strictEqual(received[0].layaScore, 87.5);
    assert.strictEqual(received[0].pnlPercent, 45.2);
    assert.strictEqual(received[0].isSentinelPreAudited, true);
    scanner.stop();
  });

  test('nao deve emitir evento se lock atomico retornar rowCount=0 (race condition)', async () => {
    const mockRow = {
      mint: 'AlreadyConsumed111111111111111111111111111111',
      symbol: 'RACE',
      dev_wallet: null,
      laya_score: '80',
      pnl_percent: null,
      created_at: new Date(Date.now() - 30_000)
    };

    const pool = makePool({ queryResults: { default: [mockRow] }, lockRowCount: 0 });
    const scanner = new SentinelHandoffScanner(pool as any, { pollingIntervalMs: 9999 });

    const received: SentinelHandoffToken[] = [];
    scanner.on('sentinelGraduationToken', (token) => received.push(token));

    await scanner.start();
    await (scanner as any).poll();

    assert.strictEqual(received.length, 0, 'Nao deve emitir evento se lock falhar');
    scanner.stop();
  });

  test('deve tolerar tabela sentinel_handoff inexistente sem crash', async () => {
    const pool = makePool({ throwOnTable: true });
    const scanner = new SentinelHandoffScanner(pool as any, { pollingIntervalMs: 9999 });
    await assert.doesNotReject(() => scanner.start());
    scanner.stop();
  });

  test('deve tolerar erro no lock sem crash e continuar proximo token', async () => {
    const mockRows = [
      { mint: 'Mint1111111111111111111111111111111111111111', symbol: 'ONE', dev_wallet: null, laya_score: '75', pnl_percent: null, created_at: new Date() },
      { mint: 'Mint2222222222222222222222222222222222222222', symbol: 'TWO', dev_wallet: null, laya_score: '82', pnl_percent: null, created_at: new Date() }
    ];
    let callCount = 0;
    const pool = {
      query: async (sql: string, params?: unknown[]) => {
        const trimmed = String(sql).trim().toLowerCase();
        if (trimmed.includes('alter table')) return { rowCount: 0, rows: [] };
        if (trimmed.includes('update sentinel_handoff')) {
          callCount++;
          if (callCount === 1) throw new Error('simulated lock error');
          return { rowCount: 1, rows: [] };
        }
        if (trimmed.includes('select mint')) return { rowCount: mockRows.length, rows: mockRows };
        return { rowCount: 0, rows: [] };
      }
    };

    const scanner = new SentinelHandoffScanner(pool as any, { pollingIntervalMs: 9999 });
    const received: SentinelHandoffToken[] = [];
    scanner.on('sentinelGraduationToken', (token) => received.push(token));

    await scanner.start();
    await (scanner as any).poll();

    assert.strictEqual(received.length, 1, 'Deve emitir o segundo token mesmo que o primeiro lock falhe');
    assert.strictEqual(received[0].symbol, 'TWO');
    scanner.stop();
  });

  test('deve ser desabilitado silenciosamente quando pgPool for null', async () => {
    const scanner = new SentinelHandoffScanner(null, { pollingIntervalMs: 9999 });
    await assert.doesNotReject(() => scanner.start());
    scanner.stop();
  });

  test('deve mapear campos com laya_score e dev_wallet nulos corretamente', async () => {
    const mockRow = {
      mint: 'NullFieldsMint1111111111111111111111111111111',
      symbol: 'NULL',
      dev_wallet: null,
      laya_score: null,
      pnl_percent: null,
      created_at: new Date(Date.now() - 120_000)
    };

    const pool = makePool({ queryResults: { default: [mockRow] }, lockRowCount: 1 });
    const scanner = new SentinelHandoffScanner(pool as any, { pollingIntervalMs: 9999 });

    const received: SentinelHandoffToken[] = [];
    scanner.on('sentinelGraduationToken', (token) => received.push(token));

    await scanner.start();
    await (scanner as any).poll();

    assert.strictEqual(received.length, 1);
    assert.strictEqual(received[0].layaScore, null);
    assert.strictEqual(received[0].pnlPercent, null);
    assert.strictEqual(received[0].devWallet, null);
    scanner.stop();
  });

  test('stop() deve cancelar o timer de polling', async () => {
    const pool = makePool({ queryResults: { default: [] } });
    const scanner = new SentinelHandoffScanner(pool as any, { pollingIntervalMs: 9999 });
    await scanner.start();
    assert.ok((scanner as any).pollingTimer !== null, 'Timer deve estar ativo após start()');
    scanner.stop();
    assert.strictEqual((scanner as any).pollingTimer, null, 'Timer deve ser null após stop()');
  });

  test('checkCrossMemory deve identificar token graduado com layaScore e status', async () => {
    const mockHandoff = {
      mint: 'GraduatedMint11111111111111111111111111111111',
      symbol: 'GRADPUMP',
      dev_wallet: 'Dev123',
      status: 'GRADUATING_HIGH_STRENGTH',
      laya_score: '88.5',
      pnl_percent: '32.1'
    };
    const pool = {
      query: async (sql: string, params: any[]) => {
        if (String(sql).includes('sentinel_handoff')) {
          if (params[0] === mockHandoff.mint || params[1] === mockHandoff.dev_wallet) {
            return { rows: [mockHandoff] };
          }
        }
        return { rows: [] };
      }
    };
    const scanner = new SentinelHandoffScanner(pool as any);
    const result = await scanner.checkCrossMemory(mockHandoff.mint);
    assert.strictEqual(result.found, true);
    assert.strictEqual(result.isGraduated, true);
    assert.strictEqual(result.layaScore, 88.5);
    assert.strictEqual(result.pnlPercent, 32.1);
    assert.strictEqual(result.status, 'GRADUATING_HIGH_STRENGTH');

    // Teste por dev_wallet
    const resultDev = await scanner.checkCrossMemory('OtherMint111', 'Dev123');
    assert.strictEqual(resultDev.found, true);
    assert.strictEqual(resultDev.isGraduated, true);

    // Teste de token desconhecido
    const resultNotFound = await scanner.checkCrossMemory('UnknownMint111');
    assert.strictEqual(resultNotFound.found, false);
    assert.strictEqual(resultNotFound.isGraduated, false);
    assert.strictEqual(resultNotFound.layaScore, null);
  });

});

