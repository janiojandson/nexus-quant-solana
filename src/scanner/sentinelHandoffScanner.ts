// ============================================================
// sentinelHandoffScanner.ts — Nexus Quant Solana
// Scanner aditivo: consome tokens pré-auditados pelo
// nexus-pump-sentinel via tabela sentinel_handoff no Postgres
// compartilhado. Não toca no núcleo do Padrão Ouro.
// ============================================================

import { EventEmitter } from 'events';
import { HeliusRpcHub } from '../hubs/heliusRpcHub.js';
import type { Pool } from 'pg';

export interface SentinelHandoffToken {
  mint: string;
  symbol: string;
  devWallet: string | null;
  layaScore: number | null;
  pnlPercent: number | null;
  createdAt: Date;
  /** Marcado como true para bypass do gate de maturidade mínima (já auditado na bonding curve) */
  isSentinelPreAudited: true;
}

export interface SentinelCrossMemoryResult {
  found: boolean;
  isGraduated: boolean;
  layaScore: number | null;
  pnlPercent: number | null;
  status: string | null;
  devWallet: string | null;
}

export class SentinelHandoffScanner extends EventEmitter {
  private readonly pgPool: Pool | null;
  private pollingTimer: ReturnType<typeof setInterval> | null = null;
  private isPolling = false;
  private schemaReady = false;

  /** Intervalo de polling em ms (padrão: 3 segundos) */
  private readonly pollingIntervalMs: number;
  private rpcHub: HeliusRpcHub | null = null;
  private incubator = new Map<string, { addedAt: number, token: SentinelHandoffToken }>();

  constructor(pgPool: Pool | null, options: { pollingIntervalMs?: number, rpcHub?: HeliusRpcHub } = {}) {
    super();
    this.pgPool = pgPool;
    this.pollingIntervalMs = options.pollingIntervalMs ?? 3_000;
    if (options.rpcHub) this.rpcHub = options.rpcHub;
  }

  /**
   * Inicializa o schema de compatibilidade de forma idempotente e
   * inicia o loop de polling não-bloqueante.
   */
  public async start(): Promise<void> {
    if (!this.pgPool) {
      console.warn('[SentinelHandoff] Sem pool Postgres — scanner desabilitado.');
      return;
    }
    await this.ensureSchema();
    this.pollingTimer = setInterval(() => {
      void this.poll();
    }, this.pollingIntervalMs);
    this.pollingTimer.unref?.();
    console.log(
      `[SentinelHandoff] Scanner ativo | polling a cada ${this.pollingIntervalMs}ms | ` +
      'aguardando tokens CANDIDATE (Incubadora) da bonding curve.'
    );
  }

  public stop(): void {
    if (this.pollingTimer) {
      clearInterval(this.pollingTimer);
      this.pollingTimer = null;
    }
  }

  /**
   * Adiciona a coluna consumed_at de forma idempotente — seguro em
   * múltiplos reinícios simultâneos.
   */
  private async ensureSchema(): Promise<void> {
    if (!this.pgPool || this.schemaReady) return;
    try {
      await this.pgPool.query(`
        ALTER TABLE sentinel_handoff
        ADD COLUMN IF NOT EXISTS consumed_at TIMESTAMP WITH TIME ZONE;
      `);
      this.schemaReady = true;
      console.log('[SentinelHandoff] Schema validado (consumed_at idempotente).');
    } catch (err: any) {
      // Tolerante: se a tabela não existir ainda, o scanner aguarda silenciosamente.
      console.warn(`[SentinelHandoff] Schema check: ${err?.message || err}`);
    }
  }

  /**
   * Ciclo de polling: busca até 5 tokens elegíveis e tenta
   * fazer o lock atômico via UPDATE ... WHERE consumed_by_quant = FALSE.
   */
  private async poll(): Promise<void> {
    if (this.isPolling || !this.pgPool) return;
    this.isPolling = true;
    try {
      const candidates = await this.pgPool.query<{
        mint: string;
        symbol: string;
        dev_wallet: string | null;
        laya_score: string | null;
        pnl_percent: string | null;
        created_at: Date;
      }>(`
        SELECT mint, symbol, dev_wallet, laya_score, pnl_percent, created_at
        FROM sentinel_handoff
        WHERE status = 'CANDIDATE'
          AND consumed_by_quant = FALSE
          AND created_at > NOW() - INTERVAL '15 minutes'
        ORDER BY created_at ASC
        LIMIT 5;
      `);

      for (const row of candidates.rows) {
        try {
          const lockResult = await this.pgPool.query(
            `UPDATE sentinel_handoff
             SET consumed_by_quant = TRUE, consumed_at = NOW()
             WHERE mint = $1 AND consumed_by_quant = FALSE`,
            [row.mint]
          );

          if ((lockResult.rowCount ?? 0) !== 1) continue;

          const token: SentinelHandoffToken = {
            mint: row.mint,
            symbol: row.symbol || row.mint.slice(0, 6),
            devWallet: row.dev_wallet,
            layaScore: row.laya_score !== null ? Number(row.laya_score) : null,
            pnlPercent: row.pnl_percent !== null ? Number(row.pnl_percent) : null,
            createdAt: row.created_at,
            isSentinelPreAudited: true
          };

          if (this.rpcHub) {
            this.incubator.set(row.mint, { addedAt: Date.now(), token });
            console.log(`[SentinelHandoff] Incubando CANDIDATE: ${token.symbol} (${token.mint})`);
          } else {
            this.emit('sentinelGraduationToken', token);
          }
        } catch (lockErr: any) {
          console.warn(`[SentinelHandoff] Falha ao fazer lock de ${row.mint}: ${lockErr?.message || lockErr}`);
        }
      }
      
      if (this.rpcHub) {
        await this.verifyRaydiumPools();
      }
    } catch (err: any) {
      if (!String(err?.message || '').includes('does not exist')) {
        console.warn(`[SentinelHandoff] Polling erro: ${err?.message || err}`);
      }
    } finally {
      this.isPolling = false;
    }
  }

  private async verifyRaydiumPools() {
    if (!this.rpcHub) return;
    const now = Date.now();
    for (const [mint, data] of this.incubator.entries()) {
      if (now - data.addedAt > 60000) {
        this.incubator.delete(mint);
        continue;
      }
      try {
        const response = (await this.rpcHub.call('STATE', 'getAsset', [mint])) as any;
        if (response.status === 200 && response.body?.token_info?.price_info) {
          console.log(`[SentinelHandoff] Pool confirmada on-chain para ${mint}. Avançando...`);
          this.emit('sentinelGraduationToken', data.token);
          this.incubator.delete(mint);
        }
      } catch (err) {
        // Pool probably doesn't exist yet
      }
    }
  }

  /**
   * Consulta de Memória Cruzada:
   * Verifica se o token ou sua dev_wallet constam no histórico da bonding curve (sentinel_handoff).
   * Identifica se graduou com recomendação prévia do Sentinel.
   */
  public async checkCrossMemory(
    mint: string,
    devWallet?: string | null
  ): Promise<SentinelCrossMemoryResult> {
    if (!this.pgPool) {
      return {
        found: false,
        isGraduated: false,
        layaScore: null,
        pnlPercent: null,
        status: null,
        devWallet: null
      };
    }

    try {
      const res = await this.pgPool.query<{
        mint: string;
        symbol: string;
        dev_wallet: string | null;
        status: string | null;
        laya_score: string | null;
        pnl_percent: string | null;
      }>(
        `SELECT mint, symbol, dev_wallet, status, laya_score, pnl_percent
         FROM sentinel_handoff
         WHERE mint = $1 OR ($2::text IS NOT NULL AND dev_wallet = $2::text)
         ORDER BY created_at DESC
         LIMIT 1`,
        [mint, devWallet || null]
      );

      if (res.rows.length === 0) {
        return {
          found: false,
          isGraduated: false,
          layaScore: null,
          pnlPercent: null,
          status: null,
          devWallet: null
        };
      }

      const row = res.rows[0];
      const isGraduated =
        row.status === 'CANDIDATE' || row.status === 'GRADUATING_HIGH_STRENGTH' ||
        row.status === 'GRADUATED' ||
        row.status === 'GRADUATING';

      return {
        found: true,
        isGraduated,
        layaScore: row.laya_score !== null ? Number(row.laya_score) : null,
        pnlPercent: row.pnl_percent !== null ? Number(row.pnl_percent) : null,
        status: row.status,
        devWallet: row.dev_wallet
      };
    } catch (err: any) {
      if (!String(err?.message || '').includes('does not exist')) {
        console.warn(`[SentinelHandoff:CrossMemory] Erro na consulta de ${mint}: ${err?.message || err}`);
      }
      return {
        found: false,
        isGraduated: false,
        layaScore: null,
        pnlPercent: null,
        status: null,
        devWallet: null
      };
    }
  }
}

