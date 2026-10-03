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
}
