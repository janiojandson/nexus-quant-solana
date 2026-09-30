import { test } from 'node:test';
import assert from 'node:assert';
import { handleJournalRoutes } from './journalRoutes.js';

test('handleJournalRoutes: GET /api/journal/stats deve retornar estrutura completa com fallback para sem banco', async () => {
  const req = { url: '/api/journal/stats', method: 'GET', headers: {} } as any;
  let statusCode = 0;
  let responseData = '';
  const res = {
    writeHead: (code: number) => { statusCode = code; },
    end: (data: string) => { responseData = data; }
  } as any;

  const mockJournal = {
    getStats: () => ({ bufferSize: 5, totalLogged: 10, totalFlushed: 5, totalErrors: 0 })
  } as any;

  const handled = await handleJournalRoutes(req, res, null, mockJournal);
  assert.strictEqual(handled, true);
  assert.strictEqual(statusCode, 200);

  const payload = JSON.parse(responseData);
  assert.strictEqual(payload.totalDecisions, 0);
  assert.strictEqual(payload.totalClosedTrades, 0);
  assert.strictEqual(payload.targetN, 150);
  assert.strictEqual(payload.buffer.bufferSize, 5);
  assert.strictEqual(payload.progressPct, 0);
});

test('handleJournalRoutes: GET /api/journal/gates deve responder lista e sumário', async () => {
  const req = { url: '/api/journal/gates', method: 'GET', headers: {} } as any;
  let statusCode = 0;
  let responseData = '';
  const res = {
    writeHead: (code: number) => { statusCode = code; },
    end: (data: string) => { responseData = data; }
  } as any;

  const handled = await handleJournalRoutes(req, res, null, null);
  assert.strictEqual(handled, true);
  assert.strictEqual(statusCode, 200);

  const payload = JSON.parse(responseData);
  assert.deepStrictEqual(payload.gates, []);
  assert.strictEqual(payload.summary.keep, 0);
});

test('handleJournalRoutes: GET /api/journal/latency deve responder buckets', async () => {
  const req = { url: '/api/journal/latency', method: 'GET', headers: {} } as any;
  let statusCode = 0;
  let responseData = '';
  const res = {
    writeHead: (code: number) => { statusCode = code; },
    end: (data: string) => { responseData = data; }
  } as any;

  const handled = await handleJournalRoutes(req, res, null, null);
  assert.strictEqual(handled, true);
  assert.strictEqual(statusCode, 200);

  const payload = JSON.parse(responseData);
  assert.deepStrictEqual(payload.buckets, []);
});

test('handleJournalRoutes: GET /api/journal/maturity deve responder análise de faixas de maturação', async () => {
  const req = { url: '/api/journal/maturity', method: 'GET', headers: {} } as any;
  let statusCode = 0;
  let responseData = '';
  const res = {
    writeHead: (code: number) => { statusCode = code; },
    end: (data: string) => { responseData = data; }
  } as any;

  const handled = await handleJournalRoutes(req, res, null, null);
  assert.strictEqual(handled, true);
  assert.strictEqual(statusCode, 200);

  const payload = JSON.parse(responseData);
  assert.deepStrictEqual(payload.ageBuckets, []);
  assert.deepStrictEqual(payload.strategyComparison, []);
});

test('handleJournalRoutes: GET /api/decisions/audit deve responder estrutura de auditoria mesmo sem banco', async () => {
  const req = { url: '/api/decisions/audit', method: 'GET', headers: {} } as any;
  let statusCode = 0;
  let responseData = '';
  const res = {
    writeHead: (code: number) => { statusCode = code; },
    end: (data: string) => { responseData = data; }
  } as any;

  const handled = await handleJournalRoutes(req, res, null, null);
  assert.strictEqual(handled, true);
  assert.strictEqual(statusCode, 200);

  const payload = JSON.parse(responseData);
  assert.strictEqual(payload.success, true);
  assert.strictEqual(payload.totalDecisions, 0);
  assert.deepStrictEqual(payload.categoriesBreakdown, []);
  assert.deepStrictEqual(payload.recentDecisions, []);
});

test('handleJournalRoutes: deve ignorar rotas não-journal', async () => {
  const req = { url: '/api/status', method: 'GET', headers: {} } as any;
  const res = {} as any;

  const handled = await handleJournalRoutes(req, res, null, null);
  assert.strictEqual(handled, false);
});
