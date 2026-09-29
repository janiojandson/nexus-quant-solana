// ============================================================
// decisionJournal.ts — Nexus Quant Solana
// Logging assíncrono em lote com buffer em memória
// Zero impacto no loop crítico de 1.5s do Exit Engine
// ============================================================

import { Pool, PoolClient } from 'pg';
import { randomUUID } from 'crypto';

// ──────────────────────────────────────────────
// TIPOS E INTERFACES
// ──────────────────────────────────────────────

export type DecisionType =
  | 'ENTRY_APPROVED'
  | 'ENTRY_REJECTED'
  | 'EXIT_SL'
  | 'EXIT_BE'
  | 'EXIT_PARTIAL'
  | 'EXIT_TRAILING'
  | 'EXIT_TIME_STOP'
  | 'EXIT_WATCHDOG'
  | 'EXIT_PANIC'
  | 'ABORTED_LATENCY';

export type GateName =
  | 'MATURITY_AGE'
  | 'LIQUIDITY_THRESHOLD'
  | 'MINT_AUTHORITY'
  | 'FREEZE_AUTHORITY'
  | 'TOP_HOLDERS'
  | 'PRICE_WINDOW'
  | 'BUY_DOMINANCE'
  | 'SENTINEL_REGIME'
  | 'SLOT_AVAILABILITY'
  | 'DISTANCE_FROM_LOW'
  | 'SLIPPAGE_CHECK'
  | 'LATENCY_ABORT'
  | 'RUG_CHECK';

export type GateResult = 'PASS' | 'FAIL' | 'WARN';

export type SentinelRegime =
  | 'NORMAL'
  | 'NEUTRAL_RANGING'
  | 'BULL_MOMENTUM'
  | 'HIGH_VOLATILITY'
  | 'CRASH_RISK'
  | 'PANIC';

export type ConfidenceLevel = 'LOW' | 'MEDIUM' | 'HIGH';

export interface GateEvaluation {
  gate: GateName;
  result: GateResult;
  value?: number;
  threshold?: number;
  detail?: string;
}

export interface TokenContext {
  mint: string;
  tokenSymbol?: string;
  poolAddress?: string;
  ageMinutes?: number;
  liquidityUsd?: number;
  marketCapUsd?: number;
  priceUsd?: number;
  priceChange5mPct?: number;
  buysCount5m?: number;
  sellsCount5m?: number;
  buySellRatio?: number;
  volume5mUsd?: number;
  top5HoldersPct?: number;
  holdersCount?: number;
  distanceFromLow?: number;
}

export interface MarketContext {
  sentinelRegime: SentinelRegime;
  btcTrend?: string;
  solTrend?: string;
  sessionHourUtc?: number;
  isWeekend?: boolean;
}

export interface ExecutionContext {
  estimatedSlippagePct?: number;
  latencyToSendMs?: number;
  sizeSol?: number;
}

export interface DecisionLogEntry {
  traceId: string;
  decision: DecisionType;
  token: TokenContext;
  market: MarketContext;
  execution?: ExecutionContext;
  compositeScore?: number;
  confidence?: ConfidenceLevel;
  gateEvaluations: GateEvaluation[];
  rejectionReason?: string;
  metadata?: Record<string, unknown>;
}

export interface TradeOutcomeEntry {
  traceId: string;
  mint: string;
  entryPriceUsd: number;
  entrySizeSol: number;
  entryTimestamp: Date;
  entrySlippagePct?: number;
  exitPriceUsd?: number;
  exitSizeSol?: number;
  exitTimestamp?: Date;
  exitSlippagePct?: number;
  exitReason?: DecisionType;
  pnlSol?: number;
  pnlPct?: number;
  feesTotalSol?: number;
  rentRecoveredSol?: number;
  netPnlSol?: number;
  detectionToSendMs?: number;
  sendToConfirmMs?: number;
  totalTradeDurationS?: number;
  status?: 'OPEN' | 'PARTIAL_CLOSED' | 'FULLY_CLOSED' | 'WATCHDOG_CLOSED' | 'PANIC_CLOSED';
}

// ──────────────────────────────────────────────
// BUFFER INTERNO (fila em memória)
// ──────────────────────────────────────────────

interface BufferedItem {
  type: 'decision' | 'outcome';
  payload: DecisionLogEntry | TradeOutcomeEntry;
}

// ──────────────────────────────────────────────
// DECISION LOGGER — Classe Principal
// ──────────────────────────────────────────────

export class DecisionLogger {
  private pool: Pool | null;
  private buffer: BufferedItem[] = [];
  private flushIntervalMs: number;
  private maxBufferSize: number;
  private flushTimer: NodeJS.Timeout | null = null;
  private isFlushing = false;
  private totalLogged = 0;
  private totalFlushed = 0;
  private totalErrors = 0;
  private isSchemaInitialized = false;

  constructor(
    pool: Pool | null,
    options?: {
      flushIntervalMs?: number;   // default: 5000ms (5s)
      maxBufferSize?: number;     // default: 100 itens
    }
  ) {
    this.pool = pool;
    this.flushIntervalMs = options?.flushIntervalMs ?? 5000;
    this.maxBufferSize = options?.maxBufferSize ?? 100;
    this.startFlushTimer();
  }

  // ────────────────────────────────────────
  // API PÚBLICA — Chamadas não-bloqueantes
  // ────────────────────────────────────────

  /**
   * Registra uma decisão completa (entry/rejected/exit).
   * NÃO bloqueia o chamador. Enfileira em buffer.
   */
  logDecision(entry: DecisionLogEntry): void {
    this.buffer.push({ type: 'decision', payload: entry });
    this.totalLogged++;

    // Flush imediato se o buffer atingir o limite
    if (this.buffer.length >= this.maxBufferSize) {
      void this.flush(); // fire-and-forget
    }
  }

  /**
   * Registra o resultado realizado de um trade.
   * NÃO bloqueia o chamador. Enfileira em buffer.
   */
  logOutcome(entry: TradeOutcomeEntry): void {
    this.buffer.push({ type: 'outcome', payload: entry });
    this.totalLogged++;

    if (this.buffer.length >= this.maxBufferSize) {
      void this.flush();
    }
  }

  /**
   * Helper rápido para instrumentar gates.
   * Retorna o GateEvaluation pronto para incluir no DecisionLogEntry.
   */
  static evaluateGate(
    gate: GateName,
    passed: boolean,
    value?: number,
    threshold?: number,
    detail?: string
  ): GateEvaluation {
    return {
      gate,
      result: passed ? 'PASS' : 'FAIL',
      value,
      threshold,
      detail,
    };
  }

  /**
   * Obtém estatísticas do logger (para dashboard/telemetria).
   */
  getStats(): {
    bufferSize: number;
    totalLogged: number;
    totalFlushed: number;
    totalErrors: number;
  } {
    return {
      bufferSize: this.buffer.length,
      totalLogged: this.totalLogged,
      totalFlushed: this.totalFlushed,
      totalErrors: this.totalErrors,
    };
  }

  /**
   * Inicializa o schema no banco se necessário
   */
  async initSchema(): Promise<void> {
    if (!this.pool || this.isSchemaInitialized) return;
    try {
      // Cria partição atual automaticamente para garantir escrita
      const now = new Date();
      const year = now.getUTCFullYear();
      const month = String(now.getUTCMonth() + 1).padStart(2, '0');
      const partitionName = `decision_journal_${year}_${month}`;
      const nextMonthDate = new Date(Date.UTC(year, now.getUTCMonth() + 1, 1));
      const nextYear = nextMonthDate.getUTCFullYear();
      const nextMonth = String(nextMonthDate.getUTCMonth() + 1).padStart(2, '0');

      const startDate = `${year}-${month}-01`;
      const endDate = `${nextYear}-${nextMonth}-01`;

      // Garante tipos e tabelas básicas
      await this.pool.query(`
        DO $$ BEGIN
          CREATE TYPE decision_type AS ENUM (
            'ENTRY_APPROVED', 'ENTRY_REJECTED', 'EXIT_SL', 'EXIT_BE',
            'EXIT_PARTIAL', 'EXIT_TRAILING', 'EXIT_TIME_STOP', 'EXIT_WATCHDOG',
            'EXIT_PANIC', 'ABORTED_LATENCY'
          );
        EXCEPTION WHEN duplicate_object THEN null; END $$;

        DO $$ BEGIN
          CREATE TYPE gate_name AS ENUM (
            'MATURITY_AGE', 'LIQUIDITY_THRESHOLD', 'MINT_AUTHORITY', 'FREEZE_AUTHORITY',
            'TOP_HOLDERS', 'PRICE_WINDOW', 'BUY_DOMINANCE', 'SENTINEL_REGIME',
            'SLOT_AVAILABILITY', 'DISTANCE_FROM_LOW', 'SLIPPAGE_CHECK', 'LATENCY_ABORT',
            'RUG_CHECK'
          );
        EXCEPTION WHEN duplicate_object THEN null; END $$;

        DO $$ BEGIN
          ALTER TYPE gate_name ADD VALUE IF NOT EXISTS 'RUG_CHECK';
        EXCEPTION WHEN duplicate_object THEN null; END $$;

        DO $$ BEGIN
          CREATE TYPE gate_result AS ENUM ('PASS', 'FAIL', 'WARN');
        EXCEPTION WHEN duplicate_object THEN null; END $$;

        DO $$ BEGIN
          CREATE TYPE sentinel_regime AS ENUM (
            'NORMAL', 'NEUTRAL_RANGING', 'BULL_MOMENTUM', 'HIGH_VOLATILITY', 'CRASH_RISK', 'PANIC'
          );
        EXCEPTION WHEN duplicate_object THEN null; END $$;

        DO $$ BEGIN
          CREATE TYPE confidence_level AS ENUM ('LOW', 'MEDIUM', 'HIGH');
        EXCEPTION WHEN duplicate_object THEN null; END $$;

        CREATE TABLE IF NOT EXISTS decision_journal (
          id                  UUID         DEFAULT gen_random_uuid(),
          trace_id            UUID         NOT NULL DEFAULT gen_random_uuid(),
          created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
          mint                VARCHAR(64)  NOT NULL,
          token_symbol        VARCHAR(32),
          pool_address        VARCHAR(64),
          decision            decision_type NOT NULL,
          composite_score     SMALLINT     CHECK (composite_score BETWEEN 0 AND 100),
          confidence          confidence_level DEFAULT 'MEDIUM',
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
          sentinel_regime     sentinel_regime,
          btc_trend           VARCHAR(16),
          sol_trend           VARCHAR(16),
          session_hour_utc    SMALLINT     CHECK (session_hour_utc BETWEEN 0 AND 23),
          is_weekend          BOOLEAN,
          estimated_slippage_pct NUMERIC(6,2),
          latency_to_send_ms  INTEGER,
          size_sol            NUMERIC(10,6),
          gate_details        JSONB        DEFAULT '{}',
          rejection_reason    TEXT,
          metadata            JSONB        DEFAULT '{}',
          PRIMARY KEY (id, created_at)
        ) PARTITION BY RANGE (created_at);

        CREATE TABLE IF NOT EXISTS ${partitionName} PARTITION OF decision_journal
          FOR VALUES FROM ('${startDate}') TO ('${endDate}');

        CREATE TABLE IF NOT EXISTS trade_outcomes (
          id                  UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
          trace_id            UUID         NOT NULL,
          mint                VARCHAR(64)  NOT NULL,
          created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
          entry_price_usd     NUMERIC(20,10) NOT NULL,
          entry_size_sol      NUMERIC(10,6)  NOT NULL,
          entry_timestamp     TIMESTAMPTZ    NOT NULL,
          entry_slippage_pct  NUMERIC(6,2),
          exit_price_usd      NUMERIC(20,10),
          exit_size_sol       NUMERIC(10,6),
          exit_timestamp      TIMESTAMPTZ,
          exit_slippage_pct   NUMERIC(6,2),
          exit_reason         decision_type,
          pnl_sol             NUMERIC(10,6),
          pnl_pct             NUMERIC(8,2),
          fees_total_sol      NUMERIC(10,6),
          rent_recovered_sol  NUMERIC(10,6) DEFAULT 0,
          net_pnl_sol         NUMERIC(10,6),
          detection_to_send_ms INTEGER,
          send_to_confirm_ms  INTEGER,
          total_trade_duration_s INTEGER,
          status              VARCHAR(16) DEFAULT 'OPEN'
            CHECK (status IN ('OPEN', 'PARTIAL_CLOSED', 'FULLY_CLOSED', 'WATCHDOG_CLOSED', 'PANIC_CLOSED')),
          CONSTRAINT uq_outcome_trace UNIQUE (trace_id)
        );

        CREATE TABLE IF NOT EXISTS calibration_snapshots (
          id                  UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
          computed_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
          window_days         SMALLINT     NOT NULL DEFAULT 30,
          gate_name           gate_name    NOT NULL,
          gate_result         gate_result,
          sample_size         INTEGER      NOT NULL,
          win_rate            NUMERIC(5,2),
          avg_win_pct         NUMERIC(8,2),
          avg_loss_pct        NUMERIC(8,2),
          ev_net_pct          NUMERIC(8,2),
          ci_lower_pct        NUMERIC(8,2),
          ci_upper_pct        NUMERIC(8,2),
          lift_pct            NUMERIC(8,2),
          gate_verdict        VARCHAR(16) CHECK (gate_verdict IN ('KEEP', 'TIGHTEN', 'LOOSEN', 'REMOVE', 'INSUFFICIENT_DATA')),
          metadata            JSONB        DEFAULT '{}'
        );
      `);

      this.isSchemaInitialized = true;
    } catch (err: any) {
      console.warn('⚠️ [DecisionJournal] Aviso na inicialização de tabelas (não-bloqueante):', err.message);
    }
  }

  /**
   * Flush forçado — para shutdown gracioso no SIGTERM/SIGINT.
   */
  async shutdown(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
  }

  // ────────────────────────────────────────
  // MECÂNICA INTERNA
  // ────────────────────────────────────────

  private startFlushTimer(): void {
    this.flushTimer = setInterval(() => {
      void this.flush(); // fire-and-forget
    }, this.flushIntervalMs);

    // Não impedir o processo Node de sair
    this.flushTimer.unref?.();
  }

  /**
   * Envia o buffer para o PostgreSQL em batch transaction.
   * Nunca lança exceção — loga erros silenciosamente.
   */
  public async flush(): Promise<void> {
    if (this.isFlushing || this.buffer.length === 0 || !this.pool) return;

    this.isFlushing = true;
    const batch = this.buffer.splice(0, this.maxBufferSize);

    try {
      const client = await this.pool.connect();

      try {
        await client.query('BEGIN');

        for (const item of batch) {
          if (item.type === 'decision') {
            await this.insertDecision(client, item.payload as DecisionLogEntry);
          } else {
            await this.insertOutcome(client, item.payload as TradeOutcomeEntry);
          }
        }

        await client.query('COMMIT');
        this.totalFlushed += batch.length;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        this.totalErrors += batch.length;
        console.error('[DecisionJournal] Flush error:', (err as Error).message);
      } finally {
        client.release();
      }
    } catch (poolErr) {
      this.totalErrors += batch.length;
      console.error('[DecisionJournal] Pool error:', (poolErr as Error).message);
    } finally {
      this.isFlushing = false;
    }
  }

  private async insertDecision(
    client: PoolClient,
    entry: DecisionLogEntry
  ): Promise<void> {
    const gateDetailsJson = JSON.stringify(entry.gateEvaluations);
    const metadataJson = JSON.stringify(entry.metadata ?? {});

    await client.query(
      `INSERT INTO decision_journal (
        trace_id, mint, token_symbol, pool_address,
        decision, composite_score, confidence,
        token_age_minutes, liquidity_usd, market_cap_usd,
        price_usd, price_change_5m_pct,
        buys_count_5m, sells_count_5m, buy_sell_ratio,
        volume_5m_usd, top5_holders_pct, holders_count, distance_from_low,
        sentinel_regime, btc_trend, sol_trend, session_hour_utc, is_weekend,
        estimated_slippage_pct, latency_to_send_ms, size_sol,
        gate_details, rejection_reason, metadata
      ) VALUES (
        $1, $2, $3, $4,
        $5, $6, $7,
        $8, $9, $10,
        $11, $12,
        $13, $14, $15,
        $16, $17, $18, $19,
        $20, $21, $22, $23, $24,
        $25, $26, $27,
        $28, $29, $30
      )`,
      [
        entry.traceId || randomUUID(),
        entry.token.mint,
        entry.token.tokenSymbol ?? null,
        entry.token.poolAddress ?? null,
        entry.decision,
        entry.compositeScore ?? null,
        entry.confidence ?? null,
        entry.token.ageMinutes ?? null,
        entry.token.liquidityUsd ?? null,
        entry.token.marketCapUsd ?? null,
        entry.token.priceUsd ?? null,
        entry.token.priceChange5mPct ?? null,
        entry.token.buysCount5m ?? null,
        entry.token.sellsCount5m ?? null,
        entry.token.buySellRatio ?? null,
        entry.token.volume5mUsd ?? null,
        entry.token.top5HoldersPct ?? null,
        entry.token.holdersCount ?? null,
        entry.token.distanceFromLow ?? null,
        entry.market.sentinelRegime,
        entry.market.btcTrend ?? null,
        entry.market.solTrend ?? null,
        entry.market.sessionHourUtc ?? null,
        entry.market.isWeekend ?? null,
        entry.execution?.estimatedSlippagePct ?? null,
        entry.execution?.latencyToSendMs ?? null,
        entry.execution?.sizeSol ?? null,
        gateDetailsJson,
        entry.rejectionReason ?? null,
        metadataJson,
      ]
    );
  }

  private async insertOutcome(
    client: PoolClient,
    entry: TradeOutcomeEntry
  ): Promise<void> {
    await client.query(
      `INSERT INTO trade_outcomes (
        trace_id, mint,
        entry_price_usd, entry_size_sol, entry_timestamp, entry_slippage_pct,
        exit_price_usd, exit_size_sol, exit_timestamp, exit_slippage_pct, exit_reason,
        pnl_sol, pnl_pct, fees_total_sol, rent_recovered_sol, net_pnl_sol,
        detection_to_send_ms, send_to_confirm_ms, total_trade_duration_s,
        status
      ) VALUES (
        $1, $2,
        $3, $4, $5, $6,
        $7, $8, $9, $10, $11,
        $12, $13, $14, $15, $16,
        $17, $18, $19,
        $20
      )
      ON CONFLICT (trace_id) DO UPDATE SET
        exit_price_usd       = EXCLUDED.exit_price_usd,
        exit_size_sol        = EXCLUDED.exit_size_sol,
        exit_timestamp       = EXCLUDED.exit_timestamp,
        exit_slippage_pct    = EXCLUDED.exit_slippage_pct,
        exit_reason          = EXCLUDED.exit_reason,
        pnl_sol              = EXCLUDED.pnl_sol,
        pnl_pct              = EXCLUDED.pnl_pct,
        fees_total_sol       = EXCLUDED.fees_total_sol,
        rent_recovered_sol   = EXCLUDED.rent_recovered_sol,
        net_pnl_sol          = EXCLUDED.net_pnl_sol,
        detection_to_send_ms = EXCLUDED.detection_to_send_ms,
        send_to_confirm_ms   = EXCLUDED.send_to_confirm_ms,
        total_trade_duration_s = EXCLUDED.total_trade_duration_s,
        status               = EXCLUDED.status`,
      [
        entry.traceId,
        entry.mint,
        entry.entryPriceUsd,
        entry.entrySizeSol,
        entry.entryTimestamp,
        entry.entrySlippagePct ?? null,
        entry.exitPriceUsd ?? null,
        entry.exitSizeSol ?? null,
        entry.exitTimestamp ?? null,
        entry.exitSlippagePct ?? null,
        entry.exitReason ?? null,
        entry.pnlSol ?? null,
        entry.pnlPct ?? null,
        entry.feesTotalSol ?? null,
        entry.rentRecoveredSol ?? 0,
        entry.netPnlSol ?? null,
        entry.detectionToSendMs ?? null,
        entry.sendToConfirmMs ?? null,
        entry.totalTradeDurationS ?? null,
        entry.status ?? 'OPEN',
      ]
    );
  }
}
