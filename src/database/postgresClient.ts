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

export interface QuarantineRecord {
  mint: string;
  symbol: string;
  reason: string;
  quarantinedAt: Date;
  expiresAt: Date;
}

export class SolanaPostgresRepository {
  private pool: Pool | null = null;
  private isTableInitialized = false;
  private isQuarantineTableInitialized = false;

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

  public getPool(): Pool | null {
    return this.pool;
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
        score NUMERIC(5,2) NOT NULL,
        validated_by VARCHAR(64) NOT NULL,
        veto_reason TEXT,
        dry_run BOOLEAN NOT NULL DEFAULT TRUE,
        tx_signature VARCHAR(128),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      -- Migração idempotente: scores reais podem ser fracionários (ex.: 91.5).
      ALTER TABLE solana_agent_audits
        ALTER COLUMN score TYPE NUMERIC(5,2)
        USING score::numeric;

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

  /**
   * Garante a existência da tabela token_quarantine para persistência durável
   */
  public async initQuarantineTable(): Promise<void> {
    if (!this.pool || this.isQuarantineTableInitialized) return;

    const query = `
      CREATE TABLE IF NOT EXISTS token_quarantine (
        mint VARCHAR(64) PRIMARY KEY,
        symbol VARCHAR(32) NOT NULL DEFAULT 'UNKNOWN',
        reason TEXT NOT NULL,
        quarantined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMPTZ NOT NULL
      );
      -- Migração idempotente: motivos operacionais completos podem exceder 255 caracteres.
      ALTER TABLE token_quarantine
        ALTER COLUMN reason TYPE TEXT;

      CREATE INDEX IF NOT EXISTS idx_token_quarantine_expires ON token_quarantine(expires_at DESC);
    `;

    try {
      await this.pool.query(query);
      this.isQuarantineTableInitialized = true;
    } catch (err: any) {
      console.warn('⚠️ Falha não-bloqueante ao verificar tabela Postgres token_quarantine:', err.message);
    }
  }

  /**
   * Salva ou atualiza uma quarentena no Postgres
   */
  public async saveQuarantine(record: {
    mint: string;
    symbol?: string;
    reason: string;
    expiresAt: Date;
    quarantinedAt?: Date;
  }): Promise<void> {
    if (!this.pool) return;

    try {
      await this.initQuarantineTable();
      const query = `
        INSERT INTO token_quarantine (mint, symbol, reason, quarantined_at, expires_at)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (mint) DO UPDATE
        SET symbol = EXCLUDED.symbol,
            reason = EXCLUDED.reason,
            quarantined_at = EXCLUDED.quarantined_at,
            expires_at = EXCLUDED.expires_at;
      `;
      await this.pool.query(query, [
        record.mint,
        record.symbol || 'UNKNOWN',
        record.reason,
        record.quarantinedAt || new Date(),
        record.expiresAt
      ]);
    } catch (err: any) {
      console.warn(`⚠️ Não foi possível salvar quarentena no Postgres para ${record.mint}:`, err.message);
    }
  }

  /**
   * Retorna todas as quarentenas ainda ativas (expires_at > NOW())
   */
  public async getActiveQuarantine(): Promise<QuarantineRecord[]> {
    if (!this.pool) return [];

    try {
      await this.initQuarantineTable();
      const query = `
        SELECT mint, symbol, reason, quarantined_at, expires_at
        FROM token_quarantine
        WHERE expires_at > NOW();
      `;
      const res = await this.pool.query(query);
      return res.rows.map(row => ({
        mint: row.mint,
        symbol: row.symbol,
        reason: row.reason,
        quarantinedAt: new Date(row.quarantined_at),
        expiresAt: new Date(row.expires_at)
      }));
    } catch (err: any) {
      console.warn('⚠️ Erro ao consultar quarentena ativa no Postgres:', err.message);
      return [];
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

