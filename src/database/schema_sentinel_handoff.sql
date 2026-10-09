-- Additive shared-Postgres migration. Apply through the normal migration process before enabling the scanner.
-- Deliberately does not reset historic consumed rows or run against production during tests.
ALTER TABLE sentinel_handoff
  ADD COLUMN IF NOT EXISTS consumed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS lease_id TEXT,
  ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS next_check_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS retry_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pool_hints JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS pool_proof JSONB,
  ADD COLUMN IF NOT EXISTS pool_confirmed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_error TEXT;
CREATE INDEX IF NOT EXISTS sentinel_handoff_pending_idx
  ON sentinel_handoff(next_check_at,lease_expires_at)
  WHERE consumed_by_quant = FALSE;
