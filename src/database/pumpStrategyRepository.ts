export interface PumpStrategyQueryable {
  query(sql: string, params?: unknown[]): Promise<{ rows?: unknown[] }>;
}

export interface PumpObservationRecord {
  mint: string;
  eventTimestampMs: number;
  observedAtMs: number;
  slot: number;
  signature: string;
  payload: Record<string, unknown>;
}

export interface PumpMarketSampleRecord {
  mint: string;
  sampledAtMs: number;
  cohort?: string;
  venue?: string;
  payload: Record<string, unknown>;
}

export interface PumpShadowTradeRecord {
  mint: string;
  cohort: string;
  venue: string;
  entryAtMs: number;
  payload: Record<string, unknown>;
}

export interface PumpStrategySummaryRecord {
  cohort: string;
  venue: string;
  state: string;
  sampleCount: number;
  metrics: Record<string, unknown>;
}

export interface PumpStrategyRecoveryState {
  observations: Array<{
    mint: string;
    signature: string;
    payload: Record<string, unknown>;
  }>;
  shadowTrades: Array<{
    mint: string;
    cohort: string;
    venue: string;
    entryAtMs: number;
    payload: Record<string, unknown>;
  }>;
  marketSamples: Array<{
    mint: string;
    sampledAtMs: number;
    cohort?: string;
    venue?: string;
    payload: Record<string, unknown>;
  }>;
}

export class PumpStrategyRepository {
  constructor(private readonly db: PumpStrategyQueryable | null | undefined) {}

  async appendObservation(record: PumpObservationRecord): Promise<void> {
    if (!this.db) return;
    await this.db.query(
      `INSERT INTO solana_pump_observations
        (mint, event_timestamp_ms, observed_at, slot, signature, payload)
       VALUES ($1, $2, to_timestamp($3 / 1000.0), $4, $5, $6::jsonb)`,
      [
        record.mint,
        record.eventTimestampMs,
        record.observedAtMs,
        record.slot,
        record.signature,
        JSON.stringify(record.payload)
      ]
    );
  }

  async appendMarketSample(record: PumpMarketSampleRecord): Promise<void> {
    if (!this.db) return;
    await this.db.query(
      `INSERT INTO solana_pump_market_samples
        (mint, sampled_at, cohort, venue, payload)
       VALUES ($1, to_timestamp($2 / 1000.0), $3, $4, $5::jsonb)`,
      [record.mint, record.sampledAtMs, record.cohort ?? null, record.venue ?? null, JSON.stringify(record.payload)]
    );
  }

  async appendShadowTrade(record: PumpShadowTradeRecord): Promise<void> {
    if (!this.db) return;
    await this.db.query(
      `INSERT INTO solana_pump_shadow_trades
        (mint, cohort, venue, entry_at, payload)
       VALUES ($1, $2, $3, to_timestamp($4 / 1000.0), $5::jsonb)`,
      [record.mint, record.cohort, record.venue, record.entryAtMs, JSON.stringify(record.payload)]
    );
  }

  async upsertStrategySummary(record: PumpStrategySummaryRecord): Promise<void> {
    if (!this.db) return;
    await this.db.query(
      `INSERT INTO solana_pump_strategy_summary
        (cohort, venue, state, sample_count, metrics, updated_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, now())
       ON CONFLICT (cohort, venue)
       DO UPDATE SET state = EXCLUDED.state,
                     sample_count = EXCLUDED.sample_count,
                     metrics = EXCLUDED.metrics,
                     updated_at = now()`,
      [record.cohort, record.venue, record.state, record.sampleCount, JSON.stringify(record.metrics)]
    );
  }

  async loadRecoveryState(sinceMs: number): Promise<PumpStrategyRecoveryState> {
    if (!this.db) return { observations: [], shadowTrades: [], marketSamples: [] };
    const [observations, shadows, samples] = await Promise.all([
      this.db.query(
        `SELECT mint,signature,payload
         FROM solana_pump_observations
         WHERE observed_at >= to_timestamp($1 / 1000.0)
         ORDER BY observed_at ASC`,
        [sinceMs]
      ),
      this.db.query(
        `SELECT mint,cohort,venue,
                floor(extract(epoch from entry_at) * 1000)::bigint AS entry_at_ms,
                payload
         FROM solana_pump_shadow_trades
         WHERE entry_at >= to_timestamp($1 / 1000.0)
         ORDER BY entry_at ASC`,
        [sinceMs]
      ),
      this.db.query(
        `SELECT mint,cohort,venue,
                floor(extract(epoch from sampled_at) * 1000)::bigint AS sampled_at_ms,
                payload
         FROM solana_pump_market_samples
         WHERE sampled_at >= to_timestamp($1 / 1000.0)
         ORDER BY sampled_at ASC`,
        [sinceMs]
      )
    ]);

    return {
      observations: (observations.rows || []).map((row: any) => ({
        mint: String(row.mint),
        signature: String(row.signature),
        payload: row.payload || {}
      })),
      shadowTrades: (shadows.rows || []).map((row: any) => ({
        mint: String(row.mint),
        cohort: String(row.cohort),
        venue: String(row.venue),
        entryAtMs: Number(row.entry_at_ms),
        payload: row.payload || {}
      })),
      marketSamples: (samples.rows || []).map((row: any) => ({
        mint: String(row.mint),
        sampledAtMs: Number(row.sampled_at_ms),
        cohort: row.cohort == null ? undefined : String(row.cohort),
        venue: row.venue == null ? undefined : String(row.venue),
        payload: row.payload || {}
      }))
    };
  }

}
