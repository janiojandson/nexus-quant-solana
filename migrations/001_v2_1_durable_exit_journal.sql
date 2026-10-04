-- ============================================================
-- Migration 001: Nexus V2.1A — Durable Exit Journal & Fill Ledger
-- Non-Authoritative Shadow Schema
-- ============================================================

-- 1. Table: exit_intents
CREATE TABLE IF NOT EXISTS exit_intents (
    id VARCHAR(64) PRIMARY KEY,
    trade_id VARCHAR(64) NOT NULL,
    position_id VARCHAR(64) NOT NULL,
    wallet_id VARCHAR(64) NOT NULL,
    mint VARCHAR(64) NOT NULL,
    token_program VARCHAR(64) NOT NULL,
    position_version BIGINT NULL,
    requested_amount_atomic NUMERIC(38, 0) NOT NULL,
    amount_policy VARCHAR(32) NOT NULL,
    initial_severity VARCHAR(32) NOT NULL,
    current_severity VARCHAR(32) NOT NULL,
    reason VARCHAR(64) NOT NULL,
    policy_version VARCHAR(32) NOT NULL,
    economic_dedupe_key VARCHAR(64) NOT NULL UNIQUE,
    claimed_by VARCHAR(64) NULL,
    claim_epoch BIGINT NOT NULL DEFAULT 0,
    claimed_at TIMESTAMPTZ NULL,
    lease_expires_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'CREATED',
    superseded_by VARCHAR(64) NULL,
    reconciliation_debt BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_exit_intents_trade ON exit_intents(trade_id);
CREATE INDEX IF NOT EXISTS idx_exit_intents_position ON exit_intents(position_id);
CREATE INDEX IF NOT EXISTS idx_exit_intents_status ON exit_intents(status);
CREATE INDEX IF NOT EXISTS idx_exit_intents_claimable ON exit_intents(status, lease_expires_at);

-- Partial Unique Index: Prevents two economically active intents on the same wallet + mint
-- Terminal states that release exclusivity: APPLIED, CANCELLED, SUPERSEDED, FAILED_DEFINITIVE
CREATE UNIQUE INDEX IF NOT EXISTS uq_active_intent_wallet_mint
ON exit_intents(wallet_id, mint)
WHERE status NOT IN ('APPLIED', 'CANCELLED', 'SUPERSEDED', 'FAILED_DEFINITIVE');

-- 2. Table: execution_attempts
CREATE TABLE IF NOT EXISTS execution_attempts (
    attempt_id VARCHAR(64) PRIMARY KEY,
    intent_id VARCHAR(64) NOT NULL REFERENCES exit_intents(id),
    provider VARCHAR(32) NOT NULL,
    route TEXT NULL,
    request_id VARCHAR(128) NULL,
    message_hash VARCHAR(128) NULL,
    signature VARCHAR(128) NULL,
    requested_amount_atomic NUMERIC(38, 0) NOT NULL,
    expected_out_atomic NUMERIC(38, 0) NULL,
    minimum_out_atomic NUMERIC(38, 0) NULL,
    state VARCHAR(32) NOT NULL DEFAULT 'INITIALIZED',
    failure_reason TEXT NULL,
    error_classification VARCHAR(64) NULL,
    last_valid_block_height BIGINT NULL,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    prepared_at TIMESTAMPTZ NULL,
    submitted_at TIMESTAMPTZ NULL,
    provider_receipt_at TIMESTAMPTZ NULL,
    confirmed_at TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS idx_exec_attempts_intent ON execution_attempts(intent_id);
CREATE INDEX IF NOT EXISTS idx_exec_attempts_sig ON execution_attempts(signature);
CREATE INDEX IF NOT EXISTS idx_exec_attempts_state ON execution_attempts(state);

-- 3. Table: intent_severity_events
CREATE TABLE IF NOT EXISTS intent_severity_events (
    id SERIAL PRIMARY KEY,
    intent_id VARCHAR(64) NOT NULL REFERENCES exit_intents(id),
    from_severity VARCHAR(32) NOT NULL,
    to_severity VARCHAR(32) NOT NULL,
    reason VARCHAR(64) NOT NULL,
    observation_id VARCHAR(64) NULL,
    changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    changed_at_mono_ns NUMERIC(38, 0) NULL
);

CREATE INDEX IF NOT EXISTS idx_severity_events_intent ON intent_severity_events(intent_id);

-- 4. Table: fill_ledger (STRICTLY APPEND-ONLY)
CREATE TABLE IF NOT EXISTS fill_ledger (
    id VARCHAR(64) PRIMARY KEY,
    trade_id VARCHAR(64) NOT NULL,
    position_id VARCHAR(64) NOT NULL,
    intent_id VARCHAR(64) NOT NULL REFERENCES exit_intents(id),
    attempt_id VARCHAR(64) NOT NULL REFERENCES execution_attempts(attempt_id),
    signature VARCHAR(128) NOT NULL,
    realization_sequence INTEGER NOT NULL,
    chain_leg_index INTEGER NOT NULL DEFAULT 0,
    instruction_index INTEGER NOT NULL DEFAULT -1,
    inner_instruction_index INTEGER NOT NULL DEFAULT -1,
    asset_mint VARCHAR(64) NULL,
    requested_amount_atomic NUMERIC(38, 0) NOT NULL,
    actual_amount_atomic NUMERIC(38, 0) NOT NULL,
    gross_proceeds_lamports NUMERIC(38, 0) NOT NULL,
    network_fee_lamports NUMERIC(38, 0) NOT NULL DEFAULT 0,
    priority_fee_lamports NUMERIC(38, 0) NOT NULL DEFAULT 0,
    tip_lamports NUMERIC(38, 0) NOT NULL DEFAULT 0,
    rent_movement_lamports NUMERIC(38, 0) NOT NULL DEFAULT 0,
    slot BIGINT NULL,
    commitment VARCHAR(32) NULL DEFAULT 'confirmed',
    confirmed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    evidence_type VARCHAR(64) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_fill_onchain_identity UNIQUE (signature, chain_leg_index, instruction_index, inner_instruction_index)
);

CREATE INDEX IF NOT EXISTS idx_fill_ledger_trade ON fill_ledger(trade_id);
CREATE INDEX IF NOT EXISTS idx_fill_ledger_position ON fill_ledger(position_id);
CREATE INDEX IF NOT EXISTS idx_fill_ledger_intent ON fill_ledger(intent_id);
CREATE INDEX IF NOT EXISTS idx_fill_ledger_sig ON fill_ledger(signature);
CREATE INDEX IF NOT EXISTS idx_fill_ledger_created ON fill_ledger(created_at DESC);

-- Trigger preventing UPDATE or DELETE on fill_ledger (Append-only guarantee)
CREATE OR REPLACE FUNCTION prevent_fill_ledger_mutations()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'MUTATION FORBIDDEN: fill_ledger is strictly append-only. Corrections must be recorded as compensatory adjust records.';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_fill_ledger_immutable ON fill_ledger;
CREATE TRIGGER trg_fill_ledger_immutable
BEFORE UPDATE OR DELETE ON fill_ledger
FOR EACH ROW
EXECUTE FUNCTION prevent_fill_ledger_mutations();

-- 5. Table: execution_reconciliation_events
CREATE TABLE IF NOT EXISTS execution_reconciliation_events (
    id SERIAL PRIMARY KEY,
    attempt_id VARCHAR(64) NOT NULL REFERENCES execution_attempts(attempt_id),
    signature VARCHAR(128) NULL,
    verdict VARCHAR(32) NOT NULL,
    reason TEXT NOT NULL,
    on_chain_status VARCHAR(32) NULL,
    blockhash_valid BOOLEAN NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reconcil_attempt ON execution_reconciliation_events(attempt_id);
