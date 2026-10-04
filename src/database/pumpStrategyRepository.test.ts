import assert from 'node:assert/strict';
import test from 'node:test';
import { DECISION_JOURNAL_DDL } from './schemaSql.js';
import { PumpStrategyRepository } from './pumpStrategyRepository.js';

test('strategy lab schema contains all four persistence tables', () => {
  for (const table of [
    'solana_pump_observations',
    'solana_pump_market_samples',
    'solana_pump_shadow_trades',
    'solana_pump_strategy_summary'
  ]) {
    assert.match(DECISION_JOURNAL_DDL, new RegExp('CREATE TABLE IF NOT EXISTS ' + table));
  }
});

test('repository appends raw observation without mutating trading flow', async () => {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  const repo = new PumpStrategyRepository({
    query: async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      return { rows: [] };
    }
  });

  await repo.appendObservation({
    mint: 'Mint111',
    eventTimestampMs: 1000,
    observedAtMs: 1200,
    slot: 42,
    signature: 'Sig111',
    payload: { creator: 'Creator111' }
  });

  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /INSERT INTO solana_pump_observations/);
  assert.equal(calls[0].params?.[0], 'Mint111');
});


test('repository loads the bounded recovery window without mutating rows', async () => {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  const repo = new PumpStrategyRepository({
    query: async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      if (sql.includes('solana_pump_observations')) {
        return { rows: [{ mint: 'Mint111', signature: 'Sig111', payload: { slot: 42 } }] };
      }
      if (sql.includes('solana_pump_shadow_trades')) {
        return { rows: [{
          mint: 'Mint111', cohort: 'BIRTH_0_15S', venue: 'JUPITER_ROUTE',
          entry_at_ms: '10000', payload: { entryWindow: 'LAUNCH_0_15S' }
        }] };
      }
      return { rows: [{
        mint: 'Mint111', cohort: 'BIRTH_0_15S', venue: 'JUPITER_ROUTE',
        sampled_at_ms: '25000', payload: { entryWindow: 'LAUNCH_0_15S' }
      }] };
    }
  });

  const recovered = await repo.loadRecoveryState(1_000);
  assert.equal(calls.length, 3);
  assert.ok(calls.every(call => call.params?.[0] === 1_000));
  assert.equal(recovered.observations[0].signature, 'Sig111');
  assert.equal(recovered.shadowTrades[0].entryAtMs, 10_000);
  assert.equal(recovered.marketSamples[0].sampledAtMs, 25_000);
});
