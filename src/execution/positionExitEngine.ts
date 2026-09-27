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
  /** Pico máximo de valor em SOL atingido durante a custódia */
  peakSolValue?: number;
  /** Stop dinâmico atual do trailing: peakSolValue * (1 - TRAILING_DISTANCE) */
  trailingStopSolValue?: number;
}

export class PositionExitEngine {
  private activePositions = new Map<string, PositionTracking>();
  private closedPositions: ClosedTrade[] = [];
  /** Rastreia o pico máximo de valor em SOL atingido por posição durante a custódia */
  private peakSolValues = new Map<string, number>();
  public static readonly DEFAULT_TIME_STOP_MS = 15 * 60 * 1000; // 15 minutos
  /** Trailing agressivo: SL dinâmico = pico * (1 - TRAILING_DISTANCE) */
  public static readonly TRAILING_DISTANCE = 0.10; // -10% do pico

  public addPosition(position: PositionTracking): void {
    if (!position.maxHoldDurationMs) {
      position.maxHoldDurationMs = PositionExitEngine.DEFAULT_TIME_STOP_MS;
    }
    this.activePositions.set(position.mint, position);
    // Inicializa pico com o valor de entrada
    this.peakSolValues.set(position.mint, position.entrySol || 0.015);
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

  public getPeakSolValue(mint: string): number {
    return this.peakSolValues.get(mint) || 0;
  }

  public recordClosedTrade(trade: ClosedTrade): void {
    this.closedPositions.unshift(trade);
    if (this.closedPositions.length > 50) this.closedPositions.pop();
  }

  public removePosition(mint: string): void {
    this.activePositions.delete(mint);
    this.peakSolValues.delete(mint);
  }

  /**
   * Avalia a saída de uma posição em SOL com Trailing Stop Agressivo (-10% do pico).
   *
   * Prioridade de disparo:
   * 1. Take-Profit fixo (>= +takeProfitPct): realiza lucro imediato no alvo
   * 2. Trailing Stop (-10% do pico): protege lucro acumulado em movimentos fortes
   *    — Ativa apenas quando o pico superou +10% (evita falsos positivos na entrada)
   *    — Exemplo: sobe +80% → pico em 0.027 SOL → trailing_stop = 0.0243 SOL (+62%)
   *       Se recuar de 0.027 para 0.0243 → realiza lucro de +62%
   * 3. Stop-Loss fixo inicial (<= stopLossPct, ou 0% após Breakeven em +40%)
   * 4. Time-Stop biológico (>= maxHoldDurationMs sem atingir TP)
   */
  public evaluateExitBySol(mint: string, currentSolValue: number, currentTimestamp: number = Date.now()): ExitSignal {
    const position = this.activePositions.get(mint);
    const entrySol = position?.entrySol || 0.015;
    if (!position || entrySol <= 0) {
      return { shouldExit: false, type: 'HOLD', pnlPct: 0, currentPriceUsd: 0 };
    }

    // Atualiza pico máximo se valor atual superou o anterior
    const previousPeak = this.peakSolValues.get(mint) || entrySol;
    const newPeak = Math.max(previousPeak, currentSolValue);
    this.peakSolValues.set(mint, newPeak);

    const pnlPct = (currentSolValue - entrySol) / entrySol;
    const peakPnlPct = (newPeak - entrySol) / entrySol;

    // Trailing Stop: SL dinâmico = pico * (1 - TRAILING_DISTANCE)
    const trailingStopSolValue = newPeak * (1 - PositionExitEngine.TRAILING_DISTANCE);

    // 🛡️ Breakeven (+0R) automático ao atingir +40%: jamais volta a perder o investimento
    if (pnlPct >= 0.40 && position.stopLossPct < 0) {
      position.stopLossPct = 0.0;
    }

    // 1. Gatilho de Take-Profit fixo (>= +takeProfitPct)
    if (pnlPct >= position.takeProfitPct) {
      return {
        shouldExit: true,
        type: 'TAKE_PROFIT',
        pnlPct,
        currentPriceUsd: currentSolValue,
        peakSolValue: newPeak,
        trailingStopSolValue
      };
    }

    // 2. Trailing Stop Agressivo (-10% do pico)
    //    Ativa somente quando o pico superou +10% para não disparar em oscilação de entrada
    if (peakPnlPct >= 0.10 && currentSolValue <= trailingStopSolValue) {
      return {
        shouldExit: true,
        type: 'STOP_LOSS',
        pnlPct,
        currentPriceUsd: currentSolValue,
        peakSolValue: newPeak,
        trailingStopSolValue
      };
    }

    // 3. Stop-Loss fixo inicial (<= stopLossPct)
    if (pnlPct <= position.stopLossPct) {
      return {
        shouldExit: true,
        type: 'STOP_LOSS',
        pnlPct,
        currentPriceUsd: currentSolValue,
        peakSolValue: newPeak,
        trailingStopSolValue
      };
    }

    // 4. ⏱️ Time-Stop Biológico: posição estagnada por mais de maxHoldDurationMs
    const maxDuration = position.maxHoldDurationMs || PositionExitEngine.DEFAULT_TIME_STOP_MS;
    const elapsedMs = currentTimestamp - position.entryTimestamp;
    if (elapsedMs >= maxDuration) {
      return {
        shouldExit: true,
        type: 'TIME_STOP',
        pnlPct,
        currentPriceUsd: currentSolValue,
        peakSolValue: newPeak,
        trailingStopSolValue
      };
    }

    return {
      shouldExit: false,
      type: 'HOLD',
      pnlPct,
      currentPriceUsd: currentSolValue,
      peakSolValue: newPeak,
      trailingStopSolValue
    };
  }

  public evaluateExit(mint: string, currentPriceUsd: number): ExitSignal {
    const position = this.activePositions.get(mint);
    if (!position || position.entryPriceUsd <= 0) {
      return { shouldExit: false, type: 'HOLD', pnlPct: 0, currentPriceUsd };
    }

    const pnlPct = (currentPriceUsd - position.entryPriceUsd) / position.entryPriceUsd;

    // 🛡️ Trava de Capital: Breakeven (+0R) automático ao atingir +40%
    if (pnlPct >= 0.40 && position.stopLossPct < 0) {
      position.stopLossPct = 0.0;
    }

    if (pnlPct >= position.takeProfitPct) {
      return { shouldExit: true, type: 'TAKE_PROFIT', pnlPct, currentPriceUsd };
    }

    if (pnlPct <= position.stopLossPct) {
      return { shouldExit: true, type: 'STOP_LOSS', pnlPct, currentPriceUsd };
    }

    return { shouldExit: false, type: 'HOLD', pnlPct, currentPriceUsd };
  }
}
