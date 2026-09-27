export interface PositionTracking {
  mint: string;
  symbol: string;
  tokenAmount: number;
  entryPriceUsd: number;
  entryTimestamp: number;
  stopLossPct: number;    // Ex: -20% (-0.20)
  takeProfitPct: number;  // Ex: +50% (+0.50)
}

export interface ExitSignal {
  shouldExit: boolean;
  type: 'TAKE_PROFIT' | 'STOP_LOSS' | 'HOLD';
  pnlPct: number;
  currentPriceUsd: number;
}

export class PositionExitEngine {
  private activePositions = new Map<string, PositionTracking>();

  public addPosition(position: PositionTracking): void {
    this.activePositions.set(position.mint, position);
  }

  public getPosition(mint: string): PositionTracking | undefined {
    return this.activePositions.get(mint);
  }

  public getAllPositions(): PositionTracking[] {
    return Array.from(this.activePositions.values());
  }

  public removePosition(mint: string): void {
    this.activePositions.delete(mint);
  }

  public evaluateExit(mint: string, currentPriceUsd: number): ExitSignal {
    const position = this.activePositions.get(mint);
    if (!position || position.entryPriceUsd <= 0) {
      return { shouldExit: false, type: 'HOLD', pnlPct: 0, currentPriceUsd };
    }

    const pnlPct = (currentPriceUsd - position.entryPriceUsd) / position.entryPriceUsd;

    // Gatilho de Take-Profit (Ex: >= +50%)
    if (pnlPct >= position.takeProfitPct) {
      return {
        shouldExit: true,
        type: 'TAKE_PROFIT',
        pnlPct,
        currentPriceUsd
      };
    }

    // Gatilho de Stop-Loss (Ex: <= -20%)
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
