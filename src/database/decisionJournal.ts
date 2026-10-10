// ============================================================
// decisionJournal.ts — Nexus Quant Solana
// Logging assíncrono em lote com buffer em memória
// Zero impacto no loop crítico de 1.5s do Exit Engine
// ============================================================

import { Pool, PoolClient } from 'pg';
import { randomUUID } from 'crypto';
import { assertJournalSchema } from './journalSchemaCompatibility.js';

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
  | 'EXIT_LAYA'
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
  | 'RUG_CHECK'
  | 'LAYA_LIVE_GATE';

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
  /** Null means no macro provider is in this entry decision path. */
  sentinelRegime: SentinelRegime | null;
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
  private maxBufferMemoryItems = 1000;
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
    if (entry.gateEvaluations.some(g => g.gate === 'TOP_HOLDERS' && g.threshold === 35)) {
      entry = {...entry, metadata: {...entry.metadata, gateEvidenceVersion: 2}};
    }
    this.buffer.push({ type: 'decision', payload: entry });
    this.totalLogged++;

    if (this.buffer.length > this.maxBufferMemoryItems) {
      this.buffer.splice(0, this.buffer.length - this.maxBufferMemoryItems);
    }

    if (this.buffer.length >= this.maxBufferSize) {
      void this.flush();
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
    if (this.isSchemaInitialized) return;
    try {
      await assertJournalSchema(this.pool);
      this.isSchemaInitialized = true;
      this.schemaDisabledReason = null;
    } catch (err) {
      this.schemaDisabledReason = err instanceof Error ? err.message : 'JOURNAL_SCHEMA_READ_UNAVAILABLE';
      console.error(JSON.stringify({ event: 'JOURNAL_SCHEMA_NOT_READY', ready: false,
        reason: this.schemaDisabledReason }));
      throw err;
    }
  }

  private schemaDisabledReason: string | null = 'JOURNAL_SCHEMA_NOT_CHECKED';
  getSchemaReadiness(): { ready: boolean; reason: string | null } {
    return { ready: this.isSchemaInitialized, reason: this.schemaDisabledReason };
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

  private requeueFailedBatch(batch: BufferedItem[]): void {
    if (batch.length === 0) return;
    // O batch mais antigo volta para a frente da fila. Itens recebidos enquanto
    // o flush estava em andamento permanecem depois dele, preservando ordem.
    this.buffer = [...batch, ...this.buffer];
    if (this.buffer.length > this.maxBufferMemoryItems) {
      this.buffer.splice(this.maxBufferMemoryItems);
    }
  }

  /**
   * Envia o buffer para o PostgreSQL em batch transaction.
   * Nunca lança exceção. Em falha, recoloca o batch na fila para evitar perda
   * silenciosa do ledger (especialmente crítico após uma compra on-chain).
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
        this.requeueFailedBatch(batch);
        this.totalErrors += batch.length;
        console.error('[DecisionJournal] Flush error:', (err as Error).message);
      } finally {
        client.release();
      }
    } catch (poolErr) {
      this.requeueFailedBatch(batch);
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

    // `confidence` tem DEFAULT 'MEDIUM' no schema. Listar a coluna e passar NULL
    // anulava esse default, produzindo 100% de linhas com confidence IS NULL.
    // A chave só entra no INSERT quando explicitamente informada.
    const confidenceProvided = entry.confidence !== undefined && entry.confidence !== null;

    const columns = [
      'trace_id', 'mint', 'token_symbol', 'pool_address',
      'decision', 'composite_score',
      'token_age_minutes', 'liquidity_usd', 'market_cap_usd',
      'price_usd', 'price_change_5m_pct',
      'buys_count_5m', 'sells_count_5m', 'buy_sell_ratio',
      'volume_5m_usd', 'top5_holders_pct', 'holders_count', 'distance_from_low',
      'sentinel_regime', 'btc_trend', 'sol_trend', 'session_hour_utc', 'is_weekend',
      'estimated_slippage_pct', 'latency_to_send_ms', 'size_sol',
      'gate_details', 'rejection_reason', 'metadata'
    ];
    const values: any[] = [
      entry.traceId || randomUUID(),
      entry.token.mint,
      entry.token.tokenSymbol ?? null,
      entry.token.poolAddress ?? null,
      entry.decision,
      entry.compositeScore ?? null,
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
    ];

    // Inserir confidence no índice correspondente (após composite_score).
    if (confidenceProvided) {
      columns.splice(6, 0, 'confidence');
      values.splice(6, 0, entry.confidence);
    }

    const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');

    await client.query(
      `INSERT INTO decision_journal (${columns.join(', ')}) VALUES (${placeholders})`,
      values
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
