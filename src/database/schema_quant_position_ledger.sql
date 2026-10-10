-- Additive migration for Task 5. Apply through the normal migration process only.
-- The runtime does not execute this file or create these tables on boot.
-- Legacy trade_outcomes rows have LIVE semantics; SHADOW state lives only here.
CREATE TABLE IF NOT EXISTS quant_position_ledger (
  accounting_mode TEXT NOT NULL CHECK (accounting_mode IN ('SHADOW','LIVE')),
  trace_id UUID NOT NULL,
  entry_intent_id UUID NOT NULL,
  mint VARCHAR(64) NOT NULL,
  symbol VARCHAR(32) NOT NULL,
  entry_pair_address VARCHAR(64) NOT NULL,
  entry_price_usd NUMERIC(20,10) NOT NULL,
  entry_liquidity_usd NUMERIC(20,4),
  entry_physical_sol_lamports NUMERIC(20,0),
  entry_timestamp TIMESTAMPTZ NOT NULL,
  entry_request_id TEXT NOT NULL,
  entry_evidence JSONB NOT NULL,
  lease_id TEXT,
  source_event_at TIMESTAMPTZ,
  initial_token_amount NUMERIC(20,0) NOT NULL CHECK (initial_token_amount > 0),
  token_amount NUMERIC(20,0) NOT NULL CHECK (token_amount >= 0),
  initial_capital_sol NUMERIC(24,12) NOT NULL CHECK (initial_capital_sol > 0),
  remaining_cost_sol NUMERIC(24,12) NOT NULL CHECK (remaining_cost_sol >= 0),
  cumulative_gross_proceeds_sol NUMERIC(24,12) NOT NULL DEFAULT 0,
  cumulative_net_proceeds_sol NUMERIC(24,12) NOT NULL DEFAULT 0,
  confirmed_real_principal_recovery_sol NUMERIC(24,12) NOT NULL DEFAULT 0,
  highest_tp_step SMALLINT NOT NULL DEFAULT 0 CHECK (highest_tp_step BETWEEN 0 AND 2),
  stop_loss_pct NUMERIC(12,9) NOT NULL DEFAULT -0.125,
  executable_peak_sol_value NUMERIC(24,12),
  observable_peak_sol_value NUMERIC(24,12),
  last_jupiter_executable_sol_value NUMERIC(24,12),
  last_healthy_exit_route_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','PARTIAL_CLOSED','FULLY_CLOSED')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (accounting_mode, trace_id),
  UNIQUE (accounting_mode, entry_intent_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_quant_active_mode_mint
  ON quant_position_ledger(accounting_mode, mint) WHERE status <> 'FULLY_CLOSED';
CREATE UNIQUE INDEX IF NOT EXISTS uq_quant_handoff_source_event
  ON quant_position_ledger(accounting_mode, mint, source_event_at)
  WHERE source_event_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_quant_active_status
  ON quant_position_ledger(accounting_mode, status, entry_timestamp);

CREATE TABLE IF NOT EXISTS quant_position_exit_fills (
  accounting_mode TEXT NOT NULL CHECK (accounting_mode IN ('SHADOW','LIVE')),
  trace_id UUID NOT NULL,
  fill_id TEXT NOT NULL,
  token_amount NUMERIC(20,0) NOT NULL CHECK (token_amount > 0),
  gross_proceeds_sol NUMERIC(24,12) NOT NULL CHECK (gross_proceeds_sol >= 0),
  fee_sol NUMERIC(24,12) NOT NULL CHECK (fee_sol >= 0),
  rent_recovered_sol NUMERIC(24,12) NOT NULL DEFAULT 0,
  next_step SMALLINT NOT NULL CHECK (next_step BETWEEN 0 AND 2),
  is_full BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (accounting_mode, trace_id, fill_id),
  FOREIGN KEY (accounting_mode, trace_id)
    REFERENCES quant_position_ledger(accounting_mode, trace_id)
);

-- Legacy outcomes are LIVE by default. Historic partial rows whose original
-- capital was overwritten cannot be inferred safely; runtime quarantines them
-- for reconciliation instead of manufacturing a cost basis.
ALTER TABLE trade_outcomes
  ADD COLUMN IF NOT EXISTS accounting_mode TEXT NOT NULL DEFAULT 'LIVE',
  ADD COLUMN IF NOT EXISTS initial_capital_sol NUMERIC(24,12),
  ADD COLUMN IF NOT EXISTS remaining_cost_sol NUMERIC(24,12),
  ADD COLUMN IF NOT EXISTS remaining_token_amount NUMERIC(20,0),
  ADD COLUMN IF NOT EXISTS highest_tp_step SMALLINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS stop_loss_pct NUMERIC(12,9) NOT NULL DEFAULT -0.125;
ALTER TABLE trade_outcomes
  ALTER COLUMN entry_size_sol TYPE NUMERIC(24,12),
  ALTER COLUMN exit_size_sol TYPE NUMERIC(24,12),
  ALTER COLUMN pnl_sol TYPE NUMERIC(24,12),
  ALTER COLUMN fees_total_sol TYPE NUMERIC(24,12),
  ALTER COLUMN rent_recovered_sol TYPE NUMERIC(24,12),
  ALTER COLUMN net_pnl_sol TYPE NUMERIC(24,12);

CREATE TABLE IF NOT EXISTS quant_live_exit_fills (
  accounting_mode TEXT NOT NULL DEFAULT 'LIVE' CHECK (accounting_mode = 'LIVE'),
  trace_id UUID NOT NULL REFERENCES trade_outcomes(trace_id),
  fill_id TEXT NOT NULL,
  token_amount NUMERIC(20,0) NOT NULL CHECK (token_amount > 0),
  confirmed_wallet_delta_sol NUMERIC(24,12) NOT NULL CHECK (confirmed_wallet_delta_sol > 0),
  gross_proceeds_sol NUMERIC(24,12) NOT NULL CHECK (gross_proceeds_sol > 0),
  fee_sol NUMERIC(24,12) NOT NULL CHECK (fee_sol >= 0),
  next_step SMALLINT NOT NULL CHECK (next_step BETWEEN 0 AND 2),
  is_full BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (accounting_mode, trace_id, fill_id)
);
