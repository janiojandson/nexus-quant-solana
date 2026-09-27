export interface PositionTracking {
  mint: string;
  symbol: string;
  tokenAmount: number;
  entryPriceUsd: number;
  entryTimestamp: number;
  stopLossPct: number;    // Ex: -20% (-0.20)
  takeProfitPct: number;  // Ex: +50% (+0.50)
  entrySol?: number;      // Ex: 0.015 SOL investidos na entrada
  maxHoldDurationMs?: number; // Padrão: 15 minutos (15 * 60 * 1000)
}

export interface ClosedTrade {
  mint: string;
  symbol: string;
  tokenAmount: number;
  entryPriceUsd: number;
  exitPriceUsd: number;
  entryTimestamp: number;
  exitTimestamp: number;
  pnlPct: number;
  pnlUsdEst: number;
  exitReason: 'TAKE_PROFIT' | 'STOP_LOSS' | 'TIME_STOP' | 'MANUAL' | 'HOLD';
  txSignature?: string;
  pnlSolEst?: number;
}

export interface ExitSignal {
  shouldExit: boolean;
  type: 'TAKE_PROFIT' | 'STOP_LOSS' | 'TIME_STOP' | 'HOLD';
  pnlPct: number;
  currentPriceUsd: number;
}

export class PositionExitEngine {
  private activePositions = new Map<string, PositionTracking>();
  private closedPositions: ClosedTrade[] = [];
  public static readonly DEFAULT_TIME_STOP_MS = 15 * 60 * 1000; // 15 minutos

  public addPosition(position: PositionTracking): void {
    if (!position.maxHoldDurationMs) {
      position.maxHoldDurationMs = PositionExitEngine.DEFAULT_TIME_STOP_MS;
    }
    this.activePositions.set(position.mint, position);
  }

  public getPosition(mint: string): PositionTracking | undefined {
    return this.activePositions.get(mint);
  }

  public getAllPositions(): PositionTracking[] {
    return Array.from(this.activePositions.values());
  }

  public getClosedTrades(): ClosedTrade[] {
    return [...this.closedPositions];
  }

  public recordClosedTrade(trade: ClosedTrade): void {
    this.closedPositions.unshift(trade);
    if (this.closedPositions.length > 50) this.closedPositions.pop();
  }

  public removePosition(mint: string): void {
    this.activePositions.delete(mint);
  }

  public evaluateExitBySol(mint: string, currentSolValue: number, currentTimestamp: number = Date.now()): ExitSignal {
    const position = this.activePositions.get(mint);
    const entrySol = position?.entrySol || 0.015;
    if (!position || entrySol <= 0) {
      return { shouldExit: false, type: 'HOLD', pnlPct: 0, currentPriceUsd: 0 };
    }

    const pnlPct = (currentSolValue - entrySol) / entrySol;

    // 🛡️ Trava de Capital Ayla: Breakeven (+0R) automático ao atingir +40% de valorização
    if (pnlPct >= 0.40 && position.stopLossPct < 0) {
      position.stopLossPct = 0.0;
    }

    // 1. Gatilho de Take-Profit (Ex: >= +50%)
    if (pnlPct >= position.takeProfitPct) {
      return {
        shouldExit: true,
        type: 'TAKE_PROFIT',
        pnlPct,
        currentPriceUsd: currentSolValue
      };
    }

    // 2. Gatilho de Stop-Loss (Ex: <= -20% ou <= 0.0% se em Breakeven)
    if (pnlPct <= position.stopLossPct) {
      return {
        shouldExit: true,
        type: 'STOP_LOSS',
        pnlPct,
        currentPriceUsd: currentSolValue
      };
    }

    // 3. ⏱️ Time-Stop Biológico: Se completou 15 min e não andou para Take-Profit, encerra a mercado
    const maxDuration = position.maxHoldDurationMs || PositionExitEngine.DEFAULT_TIME_STOP_MS;
    const elapsedMs = currentTimestamp - position.entryTimestamp;
    if (elapsedMs >= maxDuration) {
      return {
        shouldExit: true,
        type: 'TIME_STOP',
        pnlPct,
        currentPriceUsd: currentSolValue
      };
    }

    return {
      shouldExit: false,
      type: 'HOLD',
      pnlPct,
      currentPriceUsd: currentSolValue
    };
  }

  public evaluateExit(mint: string, currentPriceUsd: number): ExitSignal {
    const position = this.activePositions.get(mint);
    if (!position || position.entryPriceUsd <= 0) {
      return { shouldExit: false, type: 'HOLD', pnlPct: 0, currentPriceUsd };
    }

    const pnlPct = (currentPriceUsd - position.entryPriceUsd) / position.entryPriceUsd;

    // 🛡️ Trava de Capital Ayla: Breakeven (+0R) automático ao atingir +40% de valorização
    if (pnlPct >= 0.40 && position.stopLossPct < 0) {
      position.stopLossPct = 0.0; // Puxa stop para o preço de entrada (Breakeven)
    }

    // Gatilho de Take-Profit (Ex: >= +50%)
    if (pnlPct >= position.takeProfitPct) {
      return {
        shouldExit: true,
        type: 'TAKE_PROFIT',
        pnlPct,
        currentPriceUsd
      };
    }

    // Gatilho de Stop-Loss (Ex: <= -20% ou <= 0.0% se em Breakeven)
    if (pnlPct <= position.stopLossPct) {
      return {
        shouldExit: true,
        type: 'STOP_LOSS',
        pnlPct,
        currentPriceUsd
      };
    }

    return {
      shouldExit: false,
      type: 'HOLD',
      pnlPct,
      currentPriceUsd
    };
  }
}
