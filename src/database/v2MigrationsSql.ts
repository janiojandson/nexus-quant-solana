import type { Pool } from 'pg';

export const MIGRATION_001_DDL = `
-- Migration 001: Nexus V2.1A — Durable Exit Journal & Fill Ledger
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

CREATE UNIQUE INDEX IF NOT EXISTS uq_active_intent_wallet_mint
ON exit_intents(wallet_id, mint)
WHERE status NOT IN ('APPLIED', 'CANCELLED', 'SUPERSEDED', 'FAILED_DEFINITIVE');

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
`;

export const MIGRATION_002_DDL = `
-- Migration 002: Nexus V2.3A — Durable Position Versioning & OCC
CREATE TABLE IF NOT EXISTS nexus_positions_v2 (
    position_id VARCHAR(64) PRIMARY KEY,
    trade_id VARCHAR(64) NOT NULL,
    wallet_id VARCHAR(64) NOT NULL,
    mint VARCHAR(64) NOT NULL,
    token_program VARCHAR(64) NOT NULL DEFAULT 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    status VARCHAR(32) NOT NULL DEFAULT 'OPEN',
    position_version BIGINT NOT NULL DEFAULT 1,
    token_amount_atomic NUMERIC(38, 0) NOT NULL,
    initial_amount_atomic NUMERIC(38, 0) NOT NULL,
    initial_principal_lamports NUMERIC(38, 0) NOT NULL,
    confirmed_proceeds_lamports NUMERIC(38, 0) NOT NULL DEFAULT 0,
    opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    closed_at TIMESTAMPTZ NULL,
    last_fill_id VARCHAR(64) NULL,
    last_chain_signature VARCHAR(128) NULL,
    reconciliation_required BOOLEAN NOT NULL DEFAULT FALSE,
    source VARCHAR(32) NOT NULL DEFAULT 'LIVE_EXECUTOR',
    provenance VARCHAR(64) NULL
);

CREATE INDEX IF NOT EXISTS idx_positions_v2_trade ON nexus_positions_v2(trade_id);
CREATE INDEX IF NOT EXISTS idx_positions_v2_wallet_mint ON nexus_positions_v2(wallet_id, mint);
CREATE INDEX IF NOT EXISTS idx_positions_v2_status ON nexus_positions_v2(status);

CREATE UNIQUE INDEX IF NOT EXISTS uq_active_position_wallet_mint
ON nexus_positions_v2(wallet_id, mint, token_program)
WHERE status NOT IN ('CLOSED', 'TERMINATED');

CREATE TABLE IF NOT EXISTS nexus_position_mutations_v2 (
    id SERIAL PRIMARY KEY,
    position_id VARCHAR(64) NOT NULL REFERENCES nexus_positions_v2(position_id),
    from_version BIGINT NOT NULL,
    to_version BIGINT NOT NULL,
    mutation_type VARCHAR(32) NOT NULL,
    fill_id VARCHAR(64) NULL,
    signature VARCHAR(128) NULL,
    token_amount_before NUMERIC(38, 0) NOT NULL,
    token_amount_after NUMERIC(38, 0) NOT NULL,
    delta_atomic NUMERIC(38, 0) NOT NULL,
    proceeds_lamports NUMERIC(38, 0) NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pos_mutations_position ON nexus_position_mutations_v2(position_id);
CREATE INDEX IF NOT EXISTS idx_pos_mutations_fill ON nexus_position_mutations_v2(fill_id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_position_fill_mutation
ON nexus_position_mutations_v2(position_id, fill_id)
WHERE fill_id IS NOT NULL;
`;

export const MIGRATION_003_DDL = `
-- Migration 003: System Audit Events & Append-Only Constraint
CREATE TABLE IF NOT EXISTS system_audit_events (
    id SERIAL PRIMARY KEY,
    event_id VARCHAR(64) NOT NULL UNIQUE,
    actor VARCHAR(64) NOT NULL,
    reason TEXT NOT NULL,
    mutation_class VARCHAR(32) NOT NULL,
    entity_type VARCHAR(32) NOT NULL,
    entity_id VARCHAR(64) NOT NULL,
    before_state VARCHAR(32) NOT NULL,
    after_state VARCHAR(32) NOT NULL,
    correlation_id VARCHAR(128) NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_system_audit_entity ON system_audit_events(entity_type, entity_id);

CREATE OR REPLACE FUNCTION prevent_system_audit_mutations()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'MUTATION FORBIDDEN: system_audit_events is strictly append-only for regulatory audit compliance.';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_system_audit_immutable ON system_audit_events;
CREATE TRIGGER trg_system_audit_immutable
BEFORE UPDATE OR DELETE ON system_audit_events
FOR EACH ROW
EXECUTE FUNCTION prevent_system_audit_mutations();
`;

export const MIGRATION_004_DDL = `
-- Migration 004: Multi-leg Fill Identity on Position Mutations
ALTER TABLE nexus_position_mutations_v2
ADD COLUMN IF NOT EXISTS chain_leg_index INTEGER NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS instruction_index INTEGER NOT NULL DEFAULT -1,
ADD COLUMN IF NOT EXISTS inner_instruction_index INTEGER NOT NULL DEFAULT -1;

CREATE UNIQUE INDEX IF NOT EXISTS uq_pos_mutation_onchain_leg
ON nexus_position_mutations_v2 (position_id, signature, chain_leg_index, instruction_index, inner_instruction_index)
WHERE signature IS NOT NULL AND mutation_type IN ('PARTIAL_FILL', 'FINAL_FILL');
`;

/**
 * Aplica todas as migrações DDL do Nexus V2 de forma sequencial e estritamente idempotente.
 */
export async function applyV2Migrations(pool: Pool): Promise<void> {
  const migrations = [
    { name: '001_v2_1_durable_exit_journal', sql: MIGRATION_001_DDL },
    { name: '002_v2_3_position_versioning', sql: MIGRATION_002_DDL },
    { name: '003_v2_3_system_audit_and_constraints', sql: MIGRATION_003_DDL },
    { name: '004_v2_3_position_multi_leg_and_fks', sql: MIGRATION_004_DDL }
  ];

  for (const m of migrations) {
    try {
      await pool.query(m.sql);
      console.log(`🛡️ [Migrations] DDL executado com sucesso: ${m.name}`);
    } catch (err: any) {
      console.error(`❌ [Migrations] Erro ao executar ${m.name}:`, err?.message || err);
      throw err;
    }
  }
}
