import { Pool } from 'pg';

export interface SolanaAuditRecord {
  mint: string;
  symbol: string;
  name: string;
  liquidityUsd: number;
  priceUsd: number;
  isSafe: boolean;
  score: number;
  validatedBy: string;
  vetoReason?: string | null;
  dryRun: boolean;
  txSignature?: string | null;
}

export class SolanaPostgresRepository {
  private pool: Pool | null = null;
  private isTableInitialized = false;

  constructor(connectionString?: string) {
    const conn = connectionString || process.env.DATABASE_URL;
    if (conn) {
      this.pool = new Pool({
        connectionString: conn,
        ssl: conn.includes('railway') && !conn.includes('railway.internal') ? { rejectUnauthorized: false } : undefined,
        max: 5,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000
      });
    }
  }

  public async initTable(): Promise<void> {
    if (!this.pool || this.isTableInitialized) return;

    const query = `
      CREATE TABLE IF NOT EXISTS solana_agent_audits (
        id SERIAL PRIMARY KEY,
        mint VARCHAR(64) NOT NULL,
        symbol VARCHAR(32),
        name VARCHAR(128),
        liquidity_usd NUMERIC(16, 2),
        price_usd NUMERIC(16, 8),
        is_safe BOOLEAN NOT NULL,
        score INTEGER NOT NULL,
        validated_by VARCHAR(64) NOT NULL,
        veto_reason TEXT,
        dry_run BOOLEAN NOT NULL DEFAULT TRUE,
        tx_signature VARCHAR(128),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_solana_audits_mint ON solana_agent_audits(mint);
      CREATE INDEX IF NOT EXISTS idx_solana_audits_created_at ON solana_agent_audits(created_at DESC);
    `;

    try {
      await this.pool.query(query);
      this.isTableInitialized = true;
    } catch (err: any) {
      console.warn('⚠️ Falha não-bloqueante ao verificar tabela Postgres solana_agent_audits:', err.message);
    }
  }

  public async saveAudit(record: SolanaAuditRecord): Promise<void> {
    if (!this.pool) {
      return; // Sem conexão configurada, opera silencioso
    }

    try {
      await this.initTable();
      const insertQuery = `
        INSERT INTO solana_agent_audits (
          mint, symbol, name, liquidity_usd, price_usd, is_safe, score, validated_by, veto_reason, dry_run, tx_signature
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      `;

      await this.pool.query(insertQuery, [
        record.mint,
        record.symbol,
        record.name,
        record.liquidityUsd,
        record.priceUsd,
        record.isSafe,
        record.score,
        record.validatedBy,
        record.vetoReason || null,
        record.dryRun,
        record.txSignature || null
      ]);
    } catch (err: any) {
      console.warn(`⚠️ Não foi possível salvar auditoria no Postgres para ${record.mint}:`, err.message);
    }
  }

  public async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
    }
  }
}
