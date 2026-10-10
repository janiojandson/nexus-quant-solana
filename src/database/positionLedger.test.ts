import test from 'node:test';
import assert from 'node:assert/strict';
import { computeExitFill, PostgresPositionLedger } from './positionLedger.js';

test('partial fills reduce remaining cost proportionally while initial capital stays fixed', () => {
  const first = computeExitFill({ tokenAmount: 1000, initialCapitalSol: 1,
    remainingCostSol: 1, cumulativeGrossProceedsSol: 0, cumulativeNetProceedsSol: 0,
    highestTpStepReached: 0, stopLossPct: -0.125 },
    { fillId: 'one', tokenAmount: 741, grossProceedsSol: 1.00035,
      feeSol: 0.0001, nextStep: 1, isFull: false });
  assert.equal(first.tokenAmount, 259);
  assert.equal(first.initialCapitalSol, 1);
  assert.equal(first.remainingCostSol, 0.259);
  assert.equal(first.cumulativeNetProceedsSol, 1.00025);
  assert.equal(first.confirmedRealPrincipalRecoverySol, 0);
  assert.equal(first.stopLossPct, 0);
  const second = computeExitFill(first, { fillId: 'two', tokenAmount: 130,
    grossProceedsSol: 0.26, feeSol: 0.0001, nextStep: 2, isFull: false });
  assert.equal(second.tokenAmount, 129);
  assert.equal(second.remainingCostSol, 0.129);
  assert.equal(second.highestTpStepReached, 2);
  assert.equal(second.cumulativeNetProceedsSol, 1.26015);
});

test('shadow fill cannot claim real rent or confirmed wallet principal recovery', () => {
  assert.throws(() => computeExitFill({ tokenAmount: 10, initialCapitalSol: 1,
    remainingCostSol: 1, cumulativeGrossProceedsSol: 0, cumulativeNetProceedsSol: 0,
    highestTpStepReached: 0, stopLossPct: -0.125 },
    { fillId: 'x', tokenAmount: 5, grossProceedsSol: 0.5,
      feeSol: 0, rentRecoveredSol: 0.00204, nextStep: 1, isFull: false }), /SHADOW_RENT/);
});

test('registrar rolls back when fenced lease row is absent and never acknowledges', async () => {
  const queries: string[] = [];
  const client = { query: async (sql: string) => {
    queries.push(sql.trim());
    if (sql.includes('FROM sentinel_handoff')) return { rows: [], rowCount: 0 };
    return { rows: [], rowCount: 0 };
  }, release: () => {} };
  const ledger = new PostgresPositionLedger({ connect: async () => client } as any);
  await assert.rejects(ledger.register({ candidate: { mint: 'mint', symbol: 'M', name: 'M',
    priceUsd: 1, liquidityUsd: 30_000, pairAddress: 'pool' }, stakeLamports: 1_000_000,
    accepted: { accepted: true, order: { requestId: 'req', transaction: 'unsigned',
      inAmount: '1000000', outAmount: '1000' }, evidence: { pool: { poolAddress: 'pool' } } } as any,
    accountingMode: 'SHADOW', lease: { mint: 'mint', leaseId: 'lease',
      sourceEventAt: '2026-10-09T00:00:00.000Z',
      assertLeaseActive: async () => {} } }), /LEASE_LOST/);
  assert.ok(queries.some(q => q === 'ROLLBACK'));
  assert.equal(queries.some(q => q.includes('INSERT INTO quant_position_ledger')), false);
});

test('duplicate shadow fill returns the committed state without applying proceeds twice', async () => {
  const queries: string[] = [];
  const row = { accounting_mode: 'SHADOW', trace_id: 'trace', mint: 'mint', token_amount: '259',
    initial_capital_sol: '1', remaining_cost_sol: '0.259', cumulative_gross_proceeds_sol: '1.00035',
    cumulative_net_proceeds_sol: '1.00025', highest_tp_step: 1, stop_loss_pct: '0',
    status: 'PARTIAL_CLOSED' };
  const client = { query: async (sql: string) => {
    queries.push(sql.trim());
    if (sql.includes('FROM quant_position_ledger') && sql.includes('FOR UPDATE')) return { rows: [row], rowCount: 1 };
    if (sql.includes('INSERT INTO quant_position_exit_fills')) return { rows: [], rowCount: 0 };
    return { rows: [], rowCount: 0 };
  }, release: () => {} };
  const ledger = new PostgresPositionLedger({ connect: async () => client } as any);
  const result = await ledger.appendExitFill({ accountingMode: 'SHADOW', traceId: 'trace',
    fillId: 'fill', tokenAmount: 741, grossProceedsSol: 1.00035, feeSol: 0.0001,
    nextStep: 1, isFull: false });
  assert.equal(result.applied, false);
  assert.equal(result.position.tokenAmount, 259);
  assert.equal(result.position.cumulativeNetProceedsSol, 1.00025);
  assert.equal(queries.some(q => q.startsWith('UPDATE quant_position_ledger')), false);
  assert.ok(queries.includes('COMMIT'));
});

test('a closed handoff entry is recovered by the original Sentinel event under a new lease', async () => {
  const queries: string[] = [];
  const row = { accounting_mode: 'SHADOW', trace_id: 'trace', entry_intent_id: 'intent',
    mint: 'mint', symbol: 'M', token_amount: '0', initial_token_amount: '1000',
    initial_capital_sol: '1', remaining_cost_sol: '0', cumulative_gross_proceeds_sol: '2',
    cumulative_net_proceeds_sol: '2', highest_tp_step: 2, stop_loss_pct: '0',
    status: 'FULLY_CLOSED', source_event_at: '2026-10-09T00:00:00.000Z' };
  const pool = { query: async (sql: string) => {
    queries.push(sql.trim()); return { rows: [row], rowCount: 1 };
  } };
  const ledger = new PostgresPositionLedger(pool as any);
  const receipt = await ledger.recover({ candidate: { mint: 'mint', symbol: 'M', name: 'M',
    priceUsd: 1, liquidityUsd: 30_000, pairAddress: 'pool' },
    lease: { mint: 'mint', leaseId: 'new', sourceEventAt: '2026-10-09T00:00:00.000Z',
      assertLeaseActive: async () => {} } });
  assert.equal(receipt?.traceId, 'trace');
  assert.equal(queries.length, 1);
  assert.equal(queries.some(q => q.includes('INSERT')), false);
});

test('new SHADOW admission stops at the two-position cap under the serial transaction lock', async () => {
  const queries: string[] = [];
  const client = { query: async (sql: string) => {
    queries.push(sql.trim());
    if (sql.includes('SELECT COUNT(*)')) return { rows: [{ active_count: 2 }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  }, release: () => {} };
  const pool = { connect: async () => client, query: async () => ({ rows: [], rowCount: 0 }) };
  const ledger = new PostgresPositionLedger(pool as any);
  const input = { candidate: { mint: 'third', symbol: 'T', name: 'Third',
    priceUsd: 1, liquidityUsd: 30_000, pairAddress: 'pool' }, stakeLamports: 1_000_000,
    accepted: { accepted: true, order: { requestId: 'req', transaction: 'unsigned',
      inAmount: '1000000', outAmount: '1000' }, evidence: { pool: {
        poolAddress: 'pool', observedAt: new Date().toISOString() } } }, accountingMode: 'SHADOW' } as any;
  await assert.rejects(ledger.register(input), /POSITION_CAPACITY_EXCEEDED/);
  assert.ok(queries.some(q => q.includes('pg_advisory_xact_lock')));
  assert.ok(queries.some(q => q.includes("accounting_mode = 'SHADOW' AND status <> 'FULLY_CLOSED'")));
  assert.equal(queries.some(q => q.includes('INSERT INTO quant_position_ledger')), false);
  assert.ok(queries.includes('ROLLBACK'));
});

test('exit fill and position step roll back together when the update fails', async () => {
  const queries: string[] = [];
  const row = { accounting_mode: 'SHADOW', trace_id: 'trace', mint: 'mint',
    token_amount: '1000', initial_token_amount: '1000', initial_capital_sol: '1',
    remaining_cost_sol: '1', cumulative_gross_proceeds_sol: '0',
    cumulative_net_proceeds_sol: '0', highest_tp_step: 0, stop_loss_pct: '-0.125', status: 'OPEN' };
  const client = { query: async (sql: string) => {
    queries.push(sql.trim());
    if (sql.startsWith('SELECT * FROM quant_position_ledger')) return { rows: [row], rowCount: 1 };
    if (sql.includes('INSERT INTO quant_position_exit_fills')) return { rows: [{ fill_id: 'f' }], rowCount: 1 };
    if (sql.startsWith('UPDATE quant_position_ledger')) throw new Error('DB_UPDATE_FAILED');
    return { rows: [], rowCount: 0 };
  }, release: () => {} };
  const ledger = new PostgresPositionLedger({ connect: async () => client } as any);
  await assert.rejects(ledger.appendExitFill({ accountingMode: 'SHADOW', traceId: 'trace',
    fillId: 'f', tokenAmount: 741, grossProceedsSol: 1.00035,
    feeSol: 0, nextStep: 1, isFull: false }), /DB_UPDATE_FAILED/);
  assert.ok(queries.includes('ROLLBACK'));
  assert.equal(queries.includes('COMMIT'), false);
});

test('shadow watermarks persist monotonically and never touch LIVE rows', async () => {
  const calls: Array<{ sql: string; args: unknown[] }> = [];
  const ledger = new PostgresPositionLedger({ query: async (sql: string, args: unknown[]) => {
    calls.push({ sql, args }); return { rowCount: 1, rows: [] };
  } } as any);
  await ledger.updateShadowWatermarks('trace', { executablePeakSolValue: 2,
    observablePeakSolValue: 3, lastJupiterExecutableSolValue: 1.8,
    lastHealthyExitRouteAt: 1000 });
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /accounting_mode = 'SHADOW'/);
  assert.match(calls[0].sql, /GREATEST/);
  assert.equal(calls[0].args[1], 2);
});

test('confirmed LIVE fill appends once and cumulative outcome keeps original entry capital', async () => {
  const calls: Array<{ sql: string; args: unknown[] }> = [];
  const row = { trace_id: 'trace', accounting_mode: 'LIVE', entry_size_sol: '1',
    initial_capital_sol: '1', remaining_cost_sol: '1', remaining_token_amount: '1000',
    exit_size_sol: '0', fees_total_sol: '0', net_pnl_sol: '0', highest_tp_step: 0,
    stop_loss_pct: '-0.125', status: 'OPEN' };
  const client = { query: async (sql: string, args: unknown[] = []) => {
    calls.push({ sql: sql.trim(), args });
    if (sql.includes('SELECT * FROM trade_outcomes')) return { rows: [row], rowCount: 1 };
    if (sql.includes('INSERT INTO quant_live_exit_fills')) return { rows: [{ fill_id: 'sig' }], rowCount: 1 };
    if (sql.includes('UPDATE trade_outcomes')) return { rows: [{ ...row,
      remaining_token_amount: '259', remaining_cost_sol: '0.259',
      exit_size_sol: '1.00035', fees_total_sol: '0.0001',
      net_pnl_sol: '0.25925', highest_tp_step: 1, stop_loss_pct: '0',
      status: 'PARTIAL_CLOSED' }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  }, release: () => {} };
  const ledger = new PostgresPositionLedger({ connect: async () => client } as any);
  await ledger.appendConfirmedLiveFill({ traceId: 'trace', mint: 'mint', fillId: 'sig',
    soldAtomic: 741, receivedLamports: 1_000_250_000, feeLamports: 100_000,
    initialCapitalSol: 1, initialTokenAmount: 1000, entryPriceUsd: 1,
    entryTimestamp: new Date(0), exitPriceUsd: 1.35, exitReason: 'EXIT_PARTIAL',
    nextStep: 1, isFull: false });
  const update = calls.find(call => call.sql.startsWith('UPDATE trade_outcomes'));
  assert.ok(update);
  assert.match(update.sql, /accounting_mode = 'LIVE'/);
  assert.ok(update.args.includes(0.259));
  assert.ok(calls.some(call => call.sql === 'COMMIT'));
});

test('confirmed LIVE signature is idempotent after a full close', async () => {
  const calls: string[] = [];
  const row = { trace_id: 'trace', accounting_mode: 'LIVE', entry_size_sol: '1',
    initial_capital_sol: '1', remaining_cost_sol: '0', remaining_token_amount: '0',
    highest_tp_step: 0, stop_loss_pct: '-0.125', status: 'FULLY_CLOSED' };
  const client = { query: async (sql: string) => {
    calls.push(sql.trim());
    if (sql.includes('SELECT * FROM trade_outcomes')) return { rows: [row], rowCount: 1 };
    if (sql.includes('INSERT INTO quant_live_exit_fills')) return { rows: [], rowCount: 0 };
    return { rows: [], rowCount: 0 };
  }, release: () => {} };
  const ledger = new PostgresPositionLedger({ connect: async () => client } as any);
  const result = await ledger.appendConfirmedLiveFill({ traceId: 'trace', mint: 'mint', fillId: 'sig',
    soldAtomic: 1000, receivedLamports: 1_010_000_000, feeLamports: 100_000,
    initialCapitalSol: 1, initialTokenAmount: 1000, entryPriceUsd: 1,
    entryTimestamp: new Date(0), exitPriceUsd: 1.01, exitReason: 'EXIT_WATCHDOG',
    nextStep: 0, isFull: true });
  assert.equal(result.applied, false);
  assert.equal(result.remainingTokenAmount, 0);
  assert.equal(calls.some(sql => sql.startsWith('UPDATE trade_outcomes')), false);
});

test('LIVE pre-transmit guard rejects legacy partial without durable amount and cost', async () => {
  const ledger = new PostgresPositionLedger({ query: async (sql: string) => ({
    rowCount: sql.includes('WHERE trace_id') ? 1 : 0,
    rows: sql.includes('WHERE trace_id') ? [{ status: 'PARTIAL_CLOSED',
      remaining_token_amount: null, remaining_cost_sol: null }] : []
  }) } as any);
  await assert.rejects(ledger.assertLiveExitReady('trace', 259), /LEGACY_PARTIAL_REQUIRES_RECONCILIATION/);
});
