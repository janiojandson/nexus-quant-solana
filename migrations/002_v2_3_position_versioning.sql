-- ============================================================
-- Migration 002: Nexus V2.3A — Durable Position Versioning & OCC
-- Additive / Create-Only Schema for Versioned Custody
-- ============================================================

-- 1. Table: nexus_positions_v2
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

-- Partial Unique Index: Garante unicidade econômica de custódia ativa por wallet + mint + token_program
-- Posições fechadas (CLOSED, TERMINATED) liberam o par para novas aberturas
CREATE UNIQUE INDEX IF NOT EXISTS uq_active_position_wallet_mint
ON nexus_positions_v2(wallet_id, mint, token_program)
WHERE status NOT IN ('CLOSED', 'TERMINATED');

-- 2. Table: nexus_position_mutations_v2
-- Registra formalmente cada mutação de versão com auditoria econômica imutável
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

-- Unicidade de aplicação de Fill: impede reaplicação do mesmo Fill sobre a posição
CREATE UNIQUE INDEX IF NOT EXISTS uq_position_fill_mutation
ON nexus_position_mutations_v2(position_id, fill_id)
WHERE fill_id IS NOT NULL;
