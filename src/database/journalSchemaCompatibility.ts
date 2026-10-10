import type { Pool } from 'pg';

const requiredColumns: Record<string, string[]> = {
  decision_journal: ['id', 'created_at', 'trace_id', 'mint', 'token_symbol', 'pool_address',
    'decision', 'composite_score', 'confidence', 'token_age_minutes', 'liquidity_usd',
    'market_cap_usd', 'price_usd', 'price_change_5m_pct', 'buys_count_5m', 'sells_count_5m',
    'buy_sell_ratio', 'volume_5m_usd', 'top5_holders_pct', 'holders_count', 'distance_from_low',
    'sentinel_regime', 'btc_trend', 'sol_trend', 'session_hour_utc', 'is_weekend',
    'estimated_slippage_pct', 'latency_to_send_ms', 'size_sol', 'gate_details',
    'rejection_reason', 'metadata'],
  trade_outcomes: ['trace_id', 'mint', 'entry_price_usd', 'entry_size_sol', 'entry_timestamp',
    'entry_slippage_pct', 'exit_price_usd', 'exit_size_sol', 'exit_timestamp', 'exit_slippage_pct',
    'exit_reason', 'pnl_sol', 'pnl_pct', 'fees_total_sol', 'rent_recovered_sol', 'net_pnl_sol',
    'detection_to_send_ms', 'send_to_confirm_ms', 'total_trade_duration_s', 'status',
    'peak_sol_value', 'observable_peak_sol_value', 'executable_peak_sol_value',
    'last_jupiter_executable_sol_value', 'last_healthy_exit_route_at', 'peak_updated_at'],
  calibration_snapshots: ['id', 'computed_at', 'window_days', 'gate_name', 'gate_result',
    'sample_size', 'win_rate', 'avg_win_pct', 'avg_loss_pct', 'ev_net_pct', 'ci_lower_pct',
    'ci_upper_pct', 'lift_pct', 'gate_verdict', 'metadata']
};

/** Boot and scheduled checks never provision, replace functions or retain/delete history. */
export async function assertJournalSchema(pool: Pick<Pool, 'query'> | null,
  now = new Date()): Promise<void> {
  if (!pool) throw new Error('JOURNAL_DATABASE_UNAVAILABLE');
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const nextStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const columns = Object.entries(requiredColumns).flatMap(([table_name, names]) =>
    names.map(column_name => ({ table_name, column_name })));
  let row;
  try {
    row = (await pool.query(`SELECT
      NOT EXISTS (
        SELECT 1 FROM jsonb_to_recordset($1::jsonb) AS required(table_name text, column_name text)
        WHERE NOT EXISTS (SELECT 1 FROM information_schema.columns c
          WHERE c.table_schema = 'public' AND c.table_name = required.table_name
            AND c.column_name = required.column_name)
      ) AS columns_ready,
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
        AND table_name = 'decision_journal' AND column_name = 'composite_score'
        AND data_type = 'numeric' AND numeric_precision = 5 AND numeric_scale = 2)
      AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
        AND table_name = 'decision_journal' AND column_name = 'sentinel_regime'
        AND is_nullable = 'YES') AS score_ready,
      EXISTS (SELECT 1 FROM pg_index i JOIN pg_attribute a
        ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
        WHERE i.indrelid = to_regclass('public.trade_outcomes') AND i.indisunique
          AND i.indisvalid AND i.indnkeyatts = 1 AND i.indpred IS NULL
          AND a.attname = 'trace_id') AS outcome_unique_ready,
      EXISTS (SELECT 1 FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
        WHERE i.inhparent = to_regclass('public.decision_journal')
          AND position($2 in pg_get_expr(c.relpartbound, c.oid)) > 0
          AND position($3 in pg_get_expr(c.relpartbound, c.oid)) > 0) AS partition_ready`,
    [JSON.stringify(columns), monthStart.toISOString().slice(0, 10),
      nextStart.toISOString().slice(0, 10)])).rows[0];
  } catch { throw new Error('JOURNAL_SCHEMA_READ_UNAVAILABLE'); }
  if (!row || ['columns_ready', 'score_ready', 'outcome_unique_ready', 'partition_ready']
    .some(key => row[key] !== true)) throw new Error('JOURNAL_SCHEMA_INCOMPATIBLE');
}
