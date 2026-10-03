// ============================================================
// schemaSql.ts — Nexus Quant Solana
// DDL completo embutido como constante TypeScript
// Elimina dependência de fs.readFileSync e scripts de cópia
// ============================================================

export const DECISION_JOURNAL_DDL = `
-- ============================================================
-- DECISION JOURNAL — Nexus Quant Solana
-- Versão: 1.0.0
-- Premissas: escrita async em lote, storage particionado
-- ============================================================

-- ──────────────────────────────────────────────
-- ENUMS (tipagem forte para auditoria)
-- ──────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE decision_type AS ENUM (
    'ENTRY_APPROVED',
    'ENTRY_REJECTED',
    'EXIT_SL',
    'EXIT_BE',
    'EXIT_PARTIAL',
    'EXIT_TRAILING',
    'EXIT_TIME_STOP',
    'EXIT_WATCHDOG',
    'EXIT_PANIC',
    'EXIT_LAYA',
    'ABORTED_LATENCY'
  );
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- Migração idempotente para bancos criados antes da decisão tática Laya.
ALTER TYPE decision_type ADD VALUE IF NOT EXISTS 'EXIT_LAYA';

DO $$ BEGIN
  CREATE TYPE gate_name AS ENUM (
    'MATURITY_AGE',
    'LIQUIDITY_THRESHOLD',
    'MINT_AUTHORITY',
    'FREEZE_AUTHORITY',
    'TOP_HOLDERS',
    'PRICE_WINDOW',        -- +3% a +35%
    'BUY_DOMINANCE',       -- Buys >= Sells × 1.2
    'SENTINEL_REGIME',
    'SLOT_AVAILABILITY',   -- max 2 posições
    'DISTANCE_FROM_LOW',   -- veto > 35% do fundo
    'SLIPPAGE_CHECK',
    'LATENCY_ABORT',
    'RUG_CHECK'
  );
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE gate_result AS ENUM ('PASS', 'FAIL', 'WARN');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE sentinel_regime AS ENUM (
    'NORMAL',
    'NEUTRAL_RANGING',
    'BULL_MOMENTUM',
    'HIGH_VOLATILITY',
    'CRASH_RISK',
    'PANIC'
  );
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE confidence_level AS ENUM ('LOW', 'MEDIUM', 'HIGH');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- ──────────────────────────────────────────────
-- TABELA PRINCIPAL: decision_journal
-- Particionada por mês em created_at
-- PRIMARY KEY (id, created_at) obrigatório para tabela particionada
-- ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS decision_journal (
  -- Identificação
  id                  UUID         DEFAULT gen_random_uuid(),
  trace_id            UUID         NOT NULL DEFAULT gen_random_uuid(),
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),

  -- O candidato
  mint                VARCHAR(64)  NOT NULL,
  token_symbol        VARCHAR(32),
  pool_address        VARCHAR(64),

  -- A decisão
  decision            decision_type NOT NULL,
  composite_score     NUMERIC(5,2) CHECK (composite_score BETWEEN 0 AND 100),
  confidence          confidence_level DEFAULT 'MEDIUM',

  -- Contexto do token no momento da decisão (features)
  token_age_minutes   SMALLINT,
  liquidity_usd       NUMERIC(14,2),
  market_cap_usd      NUMERIC(14,2),
  price_usd           NUMERIC(20,10),
  price_change_5m_pct NUMERIC(8,2),
  buys_count_5m       INTEGER,
  sells_count_5m      INTEGER,
  buy_sell_ratio      NUMERIC(6,2),
  volume_5m_usd       NUMERIC(14,2),
  top5_holders_pct    NUMERIC(5,2),
  holders_count       INTEGER,
  distance_from_low   NUMERIC(8,2),

  -- Contexto macro
  sentinel_regime     sentinel_regime,
  btc_trend           VARCHAR(16),
  sol_trend           VARCHAR(16),
  session_hour_utc    SMALLINT     CHECK (session_hour_utc BETWEEN 0 AND 23),
  is_weekend          BOOLEAN,

  -- Contexto de execução (se aplicável)
  estimated_slippage_pct  NUMERIC(6,2),
  latency_to_send_ms      INTEGER,
  size_sol                NUMERIC(10,6),

  -- Metadados flexíveis
  gate_details        JSONB        DEFAULT '{}',
  rejection_reason    TEXT,
  metadata            JSONB        DEFAULT '{}',

  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

-- Migração idempotente: versões anteriores usavam SMALLINT e rejeitavam scores fracionários (ex.: 91.5).
DO $$ BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'decision_journal'
      AND column_name = 'composite_score'
      AND data_type = 'smallint'
  ) THEN
    ALTER TABLE decision_journal
      ALTER COLUMN composite_score TYPE NUMERIC(5,2)
      USING composite_score::numeric;
  END IF;
END $$;

-- Índices particionados (herdados por todas as partições)
CREATE INDEX IF NOT EXISTS idx_dj_mint         ON decision_journal (mint);
CREATE INDEX IF NOT EXISTS idx_dj_decision     ON decision_journal (decision);
CREATE INDEX IF NOT EXISTS idx_dj_created_at   ON decision_journal (created_at);
CREATE INDEX IF NOT EXISTS idx_dj_trace_id     ON decision_journal (trace_id);
CREATE INDEX IF NOT EXISTS idx_dj_sentinel     ON decision_journal (sentinel_regime);
CREATE INDEX IF NOT EXISTS idx_dj_composite    ON decision_journal (composite_score);
CREATE INDEX IF NOT EXISTS idx_dj_calibration  ON decision_journal (decision, sentinel_regime, token_age_minutes, created_at);

-- ──────────────────────────────────────────────
-- TABELA DE RESULTADOS: trade_outcomes
-- Vinculada ao decision_journal via trace_id
-- ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS trade_outcomes (
  -- Identificação
  id                  UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  trace_id            UUID         NOT NULL,
  mint                VARCHAR(64)  NOT NULL,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),

  -- Entrada
  entry_price_usd     NUMERIC(20,10) NOT NULL,
  entry_size_sol      NUMERIC(10,6)  NOT NULL,
  entry_timestamp     TIMESTAMPTZ    NOT NULL,
  entry_slippage_pct  NUMERIC(6,2),

  -- Saída
  exit_price_usd      NUMERIC(20,10),
  exit_size_sol       NUMERIC(10,6),
  exit_timestamp      TIMESTAMPTZ,
  exit_slippage_pct   NUMERIC(6,2),
  exit_reason         decision_type,

  -- PnL
  pnl_sol             NUMERIC(10,6),
  pnl_pct             NUMERIC(8,2),
  fees_total_sol      NUMERIC(10,6),
  rent_recovered_sol  NUMERIC(10,6) DEFAULT 0,
  net_pnl_sol         NUMERIC(10,6),

  -- Estado durável do trailing / watermark
  peak_sol_value       NUMERIC(18,9),
  peak_updated_at      TIMESTAMPTZ,

  -- Timing (para análise de latência vs EV)
  detection_to_send_ms    INTEGER,
  send_to_confirm_ms      INTEGER,
  total_trade_duration_s  INTEGER,

  -- Status
  status              VARCHAR(16) DEFAULT 'OPEN',
    CHECK (status IN ('OPEN', 'PARTIAL_CLOSED', 'FULLY_CLOSED', 'WATCHDOG_CLOSED', 'PANIC_CLOSED')),

  -- Garantir 1 resultado por trade
  CONSTRAINT uq_outcome_trace UNIQUE (trace_id)
);

-- Migração idempotente para bancos criados antes do watermark persistente.
ALTER TABLE trade_outcomes ADD COLUMN IF NOT EXISTS peak_sol_value NUMERIC(18,9);
ALTER TABLE trade_outcomes ADD COLUMN IF NOT EXISTS peak_updated_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_to_mint       ON trade_outcomes (mint);
CREATE INDEX IF NOT EXISTS idx_to_status     ON trade_outcomes (status);
CREATE INDEX IF NOT EXISTS idx_to_created_at ON trade_outcomes (created_at);
CREATE INDEX IF NOT EXISTS idx_to_trace      ON trade_outcomes (trace_id);
CREATE INDEX IF NOT EXISTS idx_to_pnl        ON trade_outcomes (net_pnl_sol);

-- ──────────────────────────────────────────────
-- TABELA DE CALIBRAÇÃO: calibration_snapshots
-- Escrita pelo job noturno (cron)
-- ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS calibration_snapshots (
  id                  UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  computed_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
  window_days         SMALLINT     NOT NULL DEFAULT 30,

  -- Métricas por gate
  gate_name           gate_name    NOT NULL,
  gate_result         gate_result,
  sample_size         INTEGER      NOT NULL,

  -- Estatísticas
  win_rate            NUMERIC(5,2),
  avg_win_pct         NUMERIC(8,2),
  avg_loss_pct        NUMERIC(8,2),
  ev_net_pct          NUMERIC(8,2),
  ci_lower_pct        NUMERIC(8,2),
  ci_upper_pct        NUMERIC(8,2),
  lift_pct            NUMERIC(8,2),

  -- Veredito
  gate_verdict        VARCHAR(16) CHECK (gate_verdict IN ('KEEP', 'TIGHTEN', 'LOOSEN', 'REMOVE', 'INSUFFICIENT_DATA')),

  metadata            JSONB        DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_cs_gate        ON calibration_snapshots (gate_name);
CREATE INDEX IF NOT EXISTS idx_cs_computed_at ON calibration_snapshots (computed_at);

-- ──────────────────────────────────────────────
-- PARTIÇÕES MENSAIS INICIAIS
-- ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS decision_journal_2026_02 PARTITION OF decision_journal
  FOR VALUES FROM ('2026-02-01') TO ('2026-03-01');

CREATE TABLE IF NOT EXISTS decision_journal_2026_03 PARTITION OF decision_journal
  FOR VALUES FROM ('2026-03-01') TO ('2026-04-01');

CREATE TABLE IF NOT EXISTS decision_journal_2026_04 PARTITION OF decision_journal
  FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');

-- ──────────────────────────────────────────────
-- FUNÇÃO DE RETENÇÃO AUTOMÁTICA (chamada pelo cron de manutenção)
-- Remove partições com mais de 90 dias
-- ──────────────────────────────────────────────

CREATE OR REPLACE FUNCTION drop_old_partitions(retention_days INT DEFAULT 90)
RETURNS TEXT[] AS $$
DECLARE
  partition_record RECORD;
  cutoff_date DATE;
  dropped TEXT[] := '{}';
BEGIN
  cutoff_date := CURRENT_DATE - retention_days;

  FOR partition_record IN
    SELECT inhrelid::regclass::text AS partition_name
    FROM pg_inherits
    WHERE inhparent = 'decision_journal'::regclass
  LOOP
    -- Extrai a data do nome da partição (formato: decision_journal_YYYY_MM)
    IF partition_record.partition_name < format('decision_journal_%s', to_char(cutoff_date, 'YYYY_MM')) THEN
      EXECUTE format('DROP TABLE IF EXISTS %s', partition_record.partition_name);
      dropped := array_append(dropped, partition_record.partition_name);
    END IF;
  END LOOP;

  RETURN dropped;
END;
$$ LANGUAGE plpgsql;

-- ──────────────────────────────────────────────
-- FUNÇÃO: criar partição para o próximo mês
-- (chamada pelo cron de manutenção)
-- ──────────────────────────────────────────────

CREATE OR REPLACE FUNCTION create_next_partition()
RETURNS TEXT AS $$
DECLARE
  next_month DATE;
  partition_name TEXT;
  start_date TEXT;
  end_date TEXT;
BEGIN
  next_month := date_trunc('month', CURRENT_DATE + INTERVAL '1 month');
  partition_name := format('decision_journal_%s', to_char(next_month, 'YYYY_MM'));
  start_date := to_char(next_month, 'YYYY-MM-DD');
  end_date := to_char(next_month + INTERVAL '1 month', 'YYYY-MM-DD');

  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %s PARTITION OF decision_journal FOR VALUES FROM (%L) TO (%L)',
    partition_name, start_date, end_date
  );

  RETURN partition_name;
END;
$$ LANGUAGE plpgsql;
`;
