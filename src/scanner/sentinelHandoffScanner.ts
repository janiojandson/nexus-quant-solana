// ============================================================
// sentinelHandoffScanner.ts — Nexus Quant Solana
// Scanner aditivo: consome tokens pré-auditados pelo
// nexus-pump-sentinel via tabela sentinel_handoff no Postgres
// compartilhado. Não toca no núcleo do Padrão Ouro.
// ============================================================

import { EventEmitter } from 'events';
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

export class SentinelHandoffScanner extends EventEmitter {
  private readonly pgPool: Pool | null;
  private pollingTimer: ReturnType<typeof setInterval> | null = null;
  private isPolling = false;
  private schemaReady = false;

  /** Intervalo de polling em ms (padrão: 3 segundos) */
  private readonly pollingIntervalMs: number;

  constructor(pgPool: Pool | null, options: { pollingIntervalMs?: number } = {}) {
    super();
    this.pgPool = pgPool;
    this.pollingIntervalMs = options.pollingIntervalMs ?? 3_000;
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
      'aguardando tokens GRADUATING_HIGH_STRENGTH da bonding curve.'
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
        WHERE status = 'GRADUATING_HIGH_STRENGTH'
          AND consumed_by_quant = FALSE
          AND created_at > NOW() - INTERVAL '15 minutes'
        ORDER BY created_at ASC
        LIMIT 5;
      `);

      for (const row of candidates.rows) {
        try {
          // Lock atômico: somente quem fizer UPDATE em consumed_by_quant = FALSE
          // terá rowCount = 1. Garante idempotência em instâncias paralelas.
          const lockResult = await this.pgPool.query(
            `UPDATE sentinel_handoff
             SET consumed_by_quant = TRUE, consumed_at = NOW()
             WHERE mint = $1 AND consumed_by_quant = FALSE`,
            [row.mint]
          );

          if ((lockResult.rowCount ?? 0) !== 1) {
            // Outro worker/instância já consumiu este token.
            continue;
          }

          const token: SentinelHandoffToken = {
            mint: row.mint,
            symbol: row.symbol || row.mint.slice(0, 6),
            devWallet: row.dev_wallet,
            layaScore: row.laya_score !== null ? Number(row.laya_score) : null,
            pnlPercent: row.pnl_percent !== null ? Number(row.pnl_percent) : null,
            createdAt: row.created_at,
            isSentinelPreAudited: true
          };

          console.log(
            `[SentinelHandoff] Token pre-auditado capturado: ${token.symbol} (${token.mint}) ` +
            `| LayaScore=${token.layaScore ?? 'N/D'} | PnL%=${token.pnlPercent ?? 'N/D'} ` +
            `| Criado em ${token.createdAt.toISOString()}`
          );

          this.emit('sentinelGraduationToken', token);
        } catch (lockErr: any) {
          console.warn(
            `[SentinelHandoff] Falha ao fazer lock de ${row.mint}: ${lockErr?.message || lockErr}`
          );
        }
      }
    } catch (err: any) {
      // Silencioso: tolerante a tabela ausente ou queda de conexao transitoria.
      if (!String(err?.message || '').includes('does not exist')) {
        console.warn(`[SentinelHandoff] Polling erro: ${err?.message || err}`);
      }
    } finally {
      this.isPolling = false;
    }
  }
}
