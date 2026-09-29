// ============================================================
// drawdownBreaker.ts — Nexus Quant Solana
// Disjuntor de Drawdown Diário com Reset UTC 00:00
// Tier 1: -0.02 SOL -> pausa 4h
// Tier 2: -0.04 SOL -> pausa até meia-noite UTC
// ============================================================

export type DrawdownTier = 'ACTIVE' | 'PAUSED_DRAWDOWN_TIER1' | 'PAUSED_DRAWDOWN_TIER2';

export interface DrawdownState {
  tier: DrawdownTier;
  dailyPnlSol: number;
  dailyTradeCount: number;
  pausedUntil: number | null;
  lastResetDate: string;
}

export class DrawdownBreaker {
  public static readonly TIER1_THRESHOLD_SOL = -0.02;  // ~7% da banca de 0.29 SOL
  public static readonly TIER2_THRESHOLD_SOL = -0.04;  // ~14% da banca de 0.29 SOL
  public static readonly TIER1_PAUSE_MS = 4 * 60 * 60 * 1000; // 4 horas

  private dailyPnlSol = 0;
  private dailyTradeCount = 0;
  private tier: DrawdownTier = 'ACTIVE';
  private pausedUntil: number | null = null;
  private lastResetDate: string;

  constructor() {
    this.lastResetDate = this.getUtcDateString();
  }

  private getUtcDateString(now: number = Date.now()): string {
    const d = new Date(now);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  }

  private getNextMidnightUtcMs(now: number = Date.now()): number {
    const d = new Date(now);
    const midnight = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0));
    return midnight.getTime();
  }

  /**
   * Verifica se o dia mudou (UTC) e reseta contadores automaticamente.
   */
  private checkDayReset(now: number = Date.now()): void {
    const todayStr = this.getUtcDateString(now);
    if (todayStr !== this.lastResetDate) {
      this.dailyPnlSol = 0;
      this.dailyTradeCount = 0;
      this.tier = 'ACTIVE';
      this.pausedUntil = null;
      this.lastResetDate = todayStr;
      console.log(`🔄 [DRAWDOWN BREAKER] Reset diário automático (UTC 00:00). Novas entradas liberadas.`);
    }
  }

  /**
   * Registra o resultado realizado de um trade (PnL em SOL).
   * Recalcula o tier e aplica pausas se necessário.
   */
  public recordTradeResult(pnlSol: number, now: number = Date.now()): void {
    this.checkDayReset(now);
    this.dailyPnlSol += pnlSol;
    this.dailyTradeCount++;

    if (this.dailyPnlSol <= DrawdownBreaker.TIER2_THRESHOLD_SOL) {
      if (this.tier !== 'PAUSED_DRAWDOWN_TIER2') {
        this.tier = 'PAUSED_DRAWDOWN_TIER2';
        this.pausedUntil = this.getNextMidnightUtcMs(now);
        console.log(`🛑 [DRAWDOWN BREAKER TIER 2] PnL diário: ${this.dailyPnlSol.toFixed(4)} SOL (<= ${DrawdownBreaker.TIER2_THRESHOLD_SOL} SOL). Novas entradas SUSPENSAS até 00:00 UTC.`);
      }
    } else if (this.dailyPnlSol <= DrawdownBreaker.TIER1_THRESHOLD_SOL) {
      if (this.tier === 'ACTIVE') {
        this.tier = 'PAUSED_DRAWDOWN_TIER1';
        this.pausedUntil = now + DrawdownBreaker.TIER1_PAUSE_MS;
        console.log(`⚠️ [DRAWDOWN BREAKER TIER 1] PnL diário: ${this.dailyPnlSol.toFixed(4)} SOL (<= ${DrawdownBreaker.TIER1_THRESHOLD_SOL} SOL). Novas entradas pausadas por 4 horas.`);
      }
    }
  }

  /**
   * Retorna true se novas entradas estão permitidas.
   */
  public canOpenNewPosition(now: number = Date.now()): boolean {
    this.checkDayReset(now);

    if (this.tier === 'ACTIVE') return true;

    if (this.tier === 'PAUSED_DRAWDOWN_TIER1' && this.pausedUntil && now >= this.pausedUntil) {
      this.tier = 'ACTIVE';
      this.pausedUntil = null;
      console.log(`✅ [DRAWDOWN BREAKER] Pausa Tier 1 expirada. Novas entradas liberadas (PnL diário: ${this.dailyPnlSol.toFixed(4)} SOL).`);
      return true;
    }

    if (this.tier === 'PAUSED_DRAWDOWN_TIER2' && this.pausedUntil && now >= this.pausedUntil) {
      this.tier = 'ACTIVE';
      this.pausedUntil = null;
      console.log(`✅ [DRAWDOWN BREAKER] Pausa Tier 2 expirada (meia-noite UTC). Novas entradas liberadas.`);
      return true;
    }

    return false;
  }

  /**
   * Estado completo para exposição em /api/status e Dashboard.
   */
  public getState(now: number = Date.now()): DrawdownState {
    this.checkDayReset(now);
    return {
      tier: this.tier,
      dailyPnlSol: this.dailyPnlSol,
      dailyTradeCount: this.dailyTradeCount,
      pausedUntil: this.pausedUntil,
      lastResetDate: this.lastResetDate
    };
  }

  /**
   * Retorna o tier atual sem efeitos colaterais.
   */
  public getTier(): DrawdownTier {
    return this.tier;
  }
}
