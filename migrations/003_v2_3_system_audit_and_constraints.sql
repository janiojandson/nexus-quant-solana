-- Migration 003: System Audit Events & Append-Only Constraint (Finding 24 & 25, V2.3-R3)

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

-- Trigger: system_audit_events is strictly append-only
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
