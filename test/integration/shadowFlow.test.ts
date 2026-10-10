import test from 'node:test';
import assert from 'node:assert/strict';
import { PostgresPositionLedger } from '../../src/database/positionLedger.js';
import { JupiterDiscoveryScanner } from '../../src/scanner/jupiterDiscoveryScanner.js';
import { EntryAdmission } from '../../src/execution/entryAdmission.js';
import { PositionExitEngine } from '../../src/execution/positionExitEngine.js';
import { commitShadowExitFromQuote } from '../../src/execution/shadowExitCommit.js';
import { shadowLiquidableValue } from '../../src/execution/shadowQuoteValue.js';
import { createQuantHubs } from '../../src/hubs/runtimeHubs.js';
import { fixtureMint } from '../fixtures/physicalPool.js';
import { fixtureTaker, shadow4dFixture } from '../fixtures/shadow4d.js';

// SQL-boundary fixture, not PostgreSQL: preserve rows over a simulated process restart.
function memorySql() {
  let row: Record<string, any> | null = null;
  let rollbackRow: Record<string, any> | null = null;
  let fillIds = new Set<string>();
  let rollbackFills = new Set<string>();
  const queries: string[] = [];
  const query = async (sql: string, args: any[] = []) => {
    sql = sql.trim(); queries.push(sql);
    const response = (rows: any[]) => ({ rows, rowCount: rows.length });
    if (sql === 'BEGIN') { rollbackRow = row ? structuredClone(row) : null;
      rollbackFills = new Set(fillIds); return response([]); }
    if (sql === 'ROLLBACK') { row = rollbackRow; fillIds = rollbackFills; return response([]); }
    if (sql === 'COMMIT' || sql.includes('pg_advisory_xact_lock') ||
        sql.includes('pg_advisory_xact')) return response([]);
    if (sql.includes('SELECT COUNT(*)')) return response([{ active_count: row && row.status !== 'FULLY_CLOSED' ? 1 : 0 }]);
    if (sql.startsWith('SELECT') && sql.includes('FROM quant_position_ledger')) {
      if (!row) return response([]);
      if (sql.includes('status IN') || sql.includes("status <> 'FULLY_CLOSED'")) {
        if (row.status === 'FULLY_CLOSED') return response([]);
      }
      return response([structuredClone(row)]);
    }
    if (sql.startsWith('INSERT INTO quant_position_ledger')) {
      assert.equal(row, null, 'a duplicate purchase reached INSERT');
      row = { accounting_mode: 'SHADOW', trace_id: args[0], entry_intent_id: args[1],
        mint: args[2], symbol: args[3], entry_pair_address: args[4], entry_price_usd: args[5],
        entry_liquidity_usd: args[6], initial_token_amount: args[7], token_amount: args[7],
        initial_capital_sol: args[8], remaining_cost_sol: args[8],
        entry_timestamp: new Date().toISOString(), entry_physical_sol_lamports: args[13],
        highest_tp_step: 0, stop_loss_pct: -0.125, status: 'OPEN',
        executable_peak_sol_value: args[8], observable_peak_sol_value: args[8],
        cumulative_gross_proceeds_sol: 0, cumulative_net_proceeds_sol: 0,
        confirmed_real_principal_recovery_sol: 0 };
      return response([structuredClone(row)]);
    }
    if (sql.startsWith('INSERT INTO quant_position_exit_fills')) {
      assert.equal(args[0], 'SHADOW');
      if (fillIds.has(args[2])) return response([]);
      fillIds.add(args[2]); return response([{ fill_id: args[2] }]);
    }
    if (sql.startsWith('UPDATE quant_position_ledger')) {
      assert.equal(args[0], 'SHADOW'); assert.ok(row);
      Object.assign(row, { token_amount: args[2], remaining_cost_sol: args[3],
        cumulative_gross_proceeds_sol: args[4], cumulative_net_proceeds_sol: args[5],
        highest_tp_step: args[6], stop_loss_pct: args[7], status: args[8],
        executable_peak_sol_value: args[9] ?? row.executable_peak_sol_value,
        observable_peak_sol_value: args[10] ?? row.observable_peak_sol_value,
        last_jupiter_executable_sol_value: args[11] ?? row.last_jupiter_executable_sol_value,
        last_healthy_exit_route_at: args[12] ?? row.last_healthy_exit_route_at });
      return response([structuredClone(row)]);
    }
    throw new Error(`UNPLANNED_SQL:${sql.split('\n')[0]}`);
  };
  return { pool: { query, connect: async () => ({ query, release() {} }) }, queries,
    get fillCount() { return fillIds.size; } };
}

function quote(amount: number, minimum: number, id: string) {
  return { inAmount: amount, outAmount: minimum + 5_000, requestId: id, priceImpactPct: 0,
    rawQuote: { otherAmountThreshold: String(minimum), feeBps: 0,
      signatureFeeLamports: 5_000, signatureFeePayer: fixtureTaker,
      prioritizationFeeLamports: 0, prioritizationFeePayer: fixtureTaker,
      rentFeeLamports: 0, rentFeePayer: fixtureTaker } };
}

test('offline discovery -> physical 20 SOL -> 4D -> durable SHADOW -> TP1/TP2 -> restart -> trailing', async () => {
  const f = shadow4dFixture();
  const mint = fixtureMint.toBase58();
  const discovered = await new JupiterDiscoveryScanner({ request: async () => ({ status: 200,
    body: [{ id: mint, symbol: 'FIX', name: 'Fixture', usdPrice: 0.01, liquidity: 30000,
      firstPool: { id: f.physical.address.toBase58(), createdAt: '2026-10-10T00:00:00Z' } }]
  }) } as any).scanTrendingCandidates();
  assert.equal(discovered.length, 1);
  const candidate = { mint, symbol: discovered[0].symbol!, name: discovered[0].name!,
    priceUsd: discovered[0].priceUsd!, liquidityUsd: discovered[0].liquidityUsd!,
    pairAddress: discovered[0].pairAddress! };
  const db = memorySql();
  let engine = new PositionExitEngine();
  const restore = (p: any) => engine.addPosition({ ...p, entrySol: p.remainingCostSol,
    entrySolValue: p.initialCapitalSol, entryPriceUsd: p.entryPriceUsd,
    entryTimestamp: p.entryTimestamp, highestTpStepReached: p.highestTpStepReached });
  let ledger = new PostgresPositionLedger(db.pool as any, restore);
  const admission = new EntryAdmission(f.preflight, ledger);
  const input = { candidate, stakeLamports: 25_000_000, availableLamports: 100_000_000,
    reservedGasLamports: 5_000_000, verifySecurity: async () => ({ safe: true }) };
  const decision = await admission.attempt(input);
  assert.equal(decision.accepted, true, JSON.stringify(decision));
  if (!decision.accepted || !('preflight' in decision)) throw new Error('ENTRY_FAILED');
  assert.equal(decision.preflight.evidence.pool.physicalSolLamports, '20000000000');
  assert.equal(decision.preflight.evidence.pool.tokenReserveAtomic, '5000000');
  assert.equal(decision.preflight.evidence.momentum.samples.length, 4);
  assert.equal(engine.getPosition(mint)?.tokenAmount, 988142);
  const callsAfterEntry = f.calls.length;
  assert.equal((await admission.attempt(input)).accepted, true);
  assert.equal(f.calls.length, callsAfterEntry, 'recovery must not quote or simulate a new purchase');

  const sell = async (fullQuote: ReturnType<typeof quote>, partialQuote: ReturnType<typeof quote>) => {
    const pos = engine.getPosition(mint)!;
    const signal = engine.evaluateExitBySol(mint,
      shadowLiquidableValue(fullQuote, pos.tokenAmount, fixtureTaker).netLamports / 1e9);
    assert.equal(signal.shouldExit, true);
    const outcome = await commitShadowExitFromQuote({ position: { ...pos,
      traceId: pos.traceId!, initialCapitalSol: pos.entrySolValue },
      exitTokenAmount: signal.exitTokenAmount!, monitorQuote: fullQuote, taker: fixtureTaker,
      quoteAt: Date.now(), now: Date.now, getQuote: async () => partialQuote,
      persist: fill => ledger.appendExitFill(fill), apply: result => {
        if (result.position.status === 'FULLY_CLOSED') engine.removePosition(mint);
        else restore(result.position);
      } });
    assert.equal(outcome.kind, 'COMMITTED');
    return signal;
  };
  // Hand-derived integer TP1: ceil(988142 / 1.36) = 726575, leaving 261567.
  const tp1 = await sell(quote(988142, 34_005_000, 'monitor1'),
    quote(726575, 25_005_100, 'fill1'));
  assert.equal(tp1.exitTokenAmount, 726575);
  assert.equal(engine.getPosition(mint)?.tokenAmount, 261567);
  assert.equal(engine.getPosition(mint)?.highestTpStepReached, 1);
  // Hand-derived TP2: ceil(261567 / 2) = 130784, leaving 130783.
  const tp2 = await sell(quote(261567, 13_245_000, 'monitor2'),
    quote(130784, 6_620_000, 'fill2'));
  assert.equal(tp2.exitTokenAmount, 130784);
  assert.equal(engine.getPosition(mint)?.tokenAmount, 130783);
  assert.equal(db.fillCount, 2);
  engine = new PositionExitEngine();
  ledger = new PostgresPositionLedger(db.pool as any, restore);
  const saved = await ledger.readOpenShadowPositions();
  assert.equal(saved.length, 1); restore(saved[0]);
  assert.equal(engine.getPosition(mint)?.highestTpStepReached, 2);
  assert.equal(engine.getPosition(mint)?.tokenAmount, 130783);
  const restartedPeak = engine.getPeakSolValue(mint);
  const trail = await sell(quote(130783, Math.floor(restartedPeak * 0.89 * 1e9) + 5_000, 'trail'),
    quote(130783, 1, 'unused'));
  assert.equal(trail.type, 'TRAILING_STOP');
  assert.equal(trail.exitTokenAmount, 130783);
  assert.equal(engine.getPosition(mint), undefined);
  assert.equal((await ledger.readOpenShadowPositions()).length, 0);
  assert.equal(db.fillCount, 3);
  assert.ok(f.calls.includes('CRITICAL:simulateTransaction'));
  assert.ok(f.calls.every(call => !/execute|sendTransaction|sendRawTransaction/.test(call)));
  assert.ok(db.queries.filter(sql => /INSERT INTO quant_position_ledger/.test(sql)).length === 1);
});

test('composed admission rejects corrupted physical vault before entry quotes or durable purchase', async () => {
  const f = shadow4dFixture();
  f.physical.vaultBuffers[1][108] = 2; f.physical.refresh();
  const db = memorySql();
  const result = await new EntryAdmission(f.preflight, new PostgresPositionLedger(db.pool as any))
    .attempt({ candidate: { mint: fixtureMint.toBase58(), symbol: 'FIX', name: 'Fixture',
      priceUsd: 0.01, liquidityUsd: 30000, pairAddress: f.physical.address.toBase58() },
      stakeLamports: 25_000_000, availableLamports: 100_000_000, reservedGasLamports: 5_000_000,
      verifySecurity: async () => ({ safe: true }) });
  assert.equal(result.accepted, false);
  assert.equal(f.calls.length, 0);
  assert.equal(db.queries.some(sql => sql.startsWith('INSERT')), false);
});

test('bootstrap refuses missing hub quota/owner configuration before network transport', () => {
  let requests = 0;
  assert.throws(() => createQuantHubs({}, (async () => { requests++; throw new Error('NO_NETWORK'); }) as any),
    /Invalid hub configuration/);
  assert.equal(requests, 0);
});

for (const [name, options] of [
  ['simulation error', { simulationError: { InstructionError: [0, 'Custom'] } }],
  ['round-trip loss', { reverseMin: '23000000' }],
  ['missing fee proof', { missingFees: true }],
  ['unbound CPI amount', { wrongAmount: true }],
  ['missing inner trace', { missingTrace: true }]
] as const) {
  test(`composed ${name} rejection leaves no paper purchase or fill`, async () => {
    const f = shadow4dFixture(options);
    const db = memorySql();
    const result = await new EntryAdmission(f.preflight, new PostgresPositionLedger(db.pool as any))
      .attempt({ candidate: { mint: fixtureMint.toBase58(), symbol: 'FIX', name: 'Fixture',
        priceUsd: 0.01, liquidityUsd: 30000, pairAddress: f.physical.address.toBase58() },
        stakeLamports: 25_000_000, availableLamports: 100_000_000, reservedGasLamports: 5_000_000,
        verifySecurity: async () => ({ safe: true }) });
    assert.equal(result.accepted, false);
    assert.equal(db.queries.some(sql => sql.startsWith('INSERT')), false);
    assert.equal(db.fillCount, 0);
    assert.ok(f.calls.every(call => !/execute|sendTransaction|sendRawTransaction/.test(call)));
  });
}
