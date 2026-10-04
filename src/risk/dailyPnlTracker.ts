export interface DailyPnlState {
  tier: 'ACTIVE_NO_DAILY_LIMIT';
  dailyPnlSol: number;
  dailyTradeCount: number;
  pausedUntil: null;
  lastResetDate: string;
}

export class DailyPnlTracker {
  private dailyPnlSol = 0;
  private dailyTradeCount = 0;
  private lastResetDate: string;

  constructor(now: number = Date.now()) {
    this.lastResetDate = this.utcDate(now);
  }

  private utcDate(now: number): string {
    return new Date(now).toISOString().slice(0, 10);
  }

  private resetIfNeeded(now: number): void {
    const currentDate = this.utcDate(now);
    if (currentDate === this.lastResetDate) return;
    this.dailyPnlSol = 0;
    this.dailyTradeCount = 0;
    this.lastResetDate = currentDate;
  }

  recordTradeResult(pnlSol: number, now: number = Date.now()): void {
    this.resetIfNeeded(now);
    if (!Number.isFinite(pnlSol)) return;
    this.dailyPnlSol += pnlSol;
    this.dailyTradeCount++;
  }

  getState(now: number = Date.now()): DailyPnlState {
    this.resetIfNeeded(now);
    return {
      tier: 'ACTIVE_NO_DAILY_LIMIT',
      dailyPnlSol: this.dailyPnlSol,
      dailyTradeCount: this.dailyTradeCount,
      pausedUntil: null,
      lastResetDate: this.lastResetDate
    };
  }
}
