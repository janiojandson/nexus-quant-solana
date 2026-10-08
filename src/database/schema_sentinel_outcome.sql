ALTER TABLE sentinel_handoff
  ADD COLUMN IF NOT EXISTS quant_outcome TEXT DEFAULT 'PENDING',
  ADD COLUMN IF NOT EXISTS quant_outcome_detail TEXT,
  ADD COLUMN IF NOT EXISTS outcome_recorded_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_sentinel_handoff_outcome ON sentinel_handoff(quant_outcome);
