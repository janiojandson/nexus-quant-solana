export interface PositionTracking {
  mint: string;
  symbol: string;
  tokenAmount: number;
  entryPriceUsd: number;
  entryTimestamp: number;
  stopLossPct: number;    // Ex: -20% (-0.20) inicial
  takeProfitPct: number;  // Ex: +100% (+1.00 / 2x) para colheita parcial
  entrySol?: number;      // Ex: 0.015 SOL investidos na entrada
  maxHoldDurationMs?: number; // Padrão: 15 minutos (15 * 60 * 1000)
  partialTaken?: boolean; // True quando a parcial de 50% em +100% foi executada
  initialTokenAmount?: number; // Lote original total
  // Snapshot de Entrada (Contexto Inicial da Operação):
  entrySolValue?: number;
  entryLiquidityUsd?: number;
  entryVolume5m?: number;
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
  exitReason: 'TAKE_PROFIT' | 'PARTIAL_TAKE_PROFIT_50' | 'STOP_LOSS' | 'TRAILING_STOP' | 'TIME_STOP' | 'MANUAL' | 'HOLD';
  txSignature?: string;
  pnlSolEst?: number;
}

export interface ExitSignal {
  shouldExit: boolean;
  type: 'TAKE_PROFIT' | 'PARTIAL_TAKE_PROFIT_50' | 'STOP_LOSS' | 'TRAILING_STOP' | 'TIME_STOP' | 'HOLD';
  pnlPct: number;
  currentPriceUsd: number;
  /** Quantidade de tokens a liquidar (seja parcial 50% ou restante 100%) */
  exitTokenAmount?: number;
  /** Se deve fechar a conta ATA (false em parciais, true em liquidações totais) */
  shouldCloseAta?: boolean;
  /** Pico máximo de valor em SOL atingido durante a custódia */
  peakSolValue?: number;
  /** Stop dinâmico atual do trailing: peakSolValue * (1 - TRAILING_DISTANCE) */
  trailingStopSolValue?: number;
  /** Se o trailing stop está ativo (apenas pós-parcial ou pico >= +10%) */
  trailingActive?: boolean;
  /** Texto formatado do stop ativo e trailing para logs limpos e dashboard */
  stopStatusText?: string;
  /** Motivo detalhado do gatilho analítico (ex: Ayla Liquidity Drain, Ayla Dynamic Time-Stop) */
  reasonDetail?: string;
}

export class PositionExitEngine {
  private activePositions = new Map<string, PositionTracking>();
  private closedPositions: ClosedTrade[] = [];
  /** Rastreia o pico máximo de valor em SOL atingido por posição durante a custódia */
  private peakSolValues = new Map<string, number>();
  public static readonly DEFAULT_TIME_STOP_MS = 15 * 60 * 1000; // 15 minutos
  public static readonly DEFAULT_STOP_LOSS_PCT = -0.08;         // -8% Stop Loss Inicial
  public static readonly BREAKEVEN_TRIGGER_PCT = 0.12;          // +12% ativa Breakeven (+1%)
  public static readonly DEFAULT_TAKE_PROFIT_PCT = 0.35;        // +35% Parcial de 50%
  /** Trailing pós-parcial: SL dinâmico = pico * (1 - TRAILING_DISTANCE) */
  public static readonly TRAILING_DISTANCE = 0.10;              // -10% do pico máximo

  /**
   * Retorna descrição visual padronizada do estado dos stops da posição.
   * Evita exibir 'Stop Dinâmico (10%): -10.00%' enquanto a posição não atingir a parcial ou pico de ativação.
   */
  public getStopStatusText(mint: string): string {
    const pos = this.activePositions.get(mint);
    if (!pos) return 'Sem posição';
    if (pos.partialTaken) {
      const peak = this.peakSolValues.get(mint) || pos.entrySol || 0.015;
      const trailSol = peak * (1 - PositionExitEngine.TRAILING_DISTANCE);
      const entrySol = pos.entrySol || 0.015;
      const trailPct = ((trailSol - entrySol) / entrySol) * 100;
      return `Stop Ativo: Trailing Dinâmico (-10% do Topo: ${trailPct >= 0 ? '+' : ''}${trailPct.toFixed(2)}%)`;
    }
    if (pos.stopLossPct >= 0.01) {
      return `Stop Ativo: Breakeven (+${(pos.stopLossPct * 100).toFixed(1)}%) | Trailing: INATIVO (Aguardando Parcial)`;
    }
    return `Stop Ativo: SL Fixo (${(pos.stopLossPct * 100).toFixed(2)}%) | Trailing: INATIVO (Aguardando Parcial)`;
  }

  public addPosition(position: PositionTracking): void {
    if (position.stopLossPct === undefined) {
      position.stopLossPct = PositionExitEngine.DEFAULT_STOP_LOSS_PCT;
    }
    if (position.takeProfitPct === undefined) {
      position.takeProfitPct = PositionExitEngine.DEFAULT_TAKE_PROFIT_PCT;
    }
    if (!position.maxHoldDurationMs) {
      position.maxHoldDurationMs = PositionExitEngine.DEFAULT_TIME_STOP_MS;
    }
    if (!position.initialTokenAmount) {
      position.initialTokenAmount = position.tokenAmount;
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
   * Avalia a saída de uma posição via cotação em SOL utilizando o modelo Dual-Stage Trailing Stop:
   *
   * Fase 1 — Colheita Parcial (Wave Harvest em +35%):
   * - Gatilho: Quando a posição atinge >= +35% de valor em relação à entrada.
   * - Ação: Vende 50% do lote total a mercado.
   * - Breakeven: Puxa o Stop Loss dos 50% restantes para +1% (cobre taxas).
   * - Higiene ATA: NÃO fecha a conta ATA (mantém os 50% restantes em custódia).
   *
   * Fase 2 — Super Runner & Trailing Stop de 10% do Topo:
   * - Rastreia o pico máximo de SOL atingido após a parcial.
   * - Trailing Stop = Pico * (1 - 0.10) = Pico * 0.90.
   * - Se o valor cair abaixo de trailingStopSolValue: encerra os 50% restantes e FECHA a ATA (Rent Exemption).
   *
   * Proteções Iniciais (Pré-Parcial):
   * - Stop-Loss Inicial Fixo em -8% (<= 0.92 * entrySol) -> Encerra 100% e FECHA ATA.
   * - Breakeven em +12%: Se o pico atingir >= +12%, stop sobe para +1% (trade sem risco de perda).
   * - Time-Stop de 15 minutos se estagnada sem atingir parcial nem SL -> Encerra 100% e FECHA ATA.
   */
  public evaluateExitBySol(
    mint: string,
    currentSolValue: number,
    currentTimestamp: number = Date.now(),
    context?: { currentLiquidityUsd?: number; currentVolume5m?: number }
  ): ExitSignal {
    const position = this.activePositions.get(mint);
    const entrySol = position?.entrySol || 0.015;
    if (!position || entrySol <= 0) {
      return { shouldExit: false, type: 'HOLD', pnlPct: 0, currentPriceUsd: 0 };
    }

    // Atualiza pico máximo se valor atual superou o anterior
    const previousPeak = this.peakSolValues.get(mint) || entrySol;
    const newPeak = Math.max(previousPeak, currentSolValue);
    this.peakSolValues.set(mint, newPeak);

    const pnlPct = Math.round(((currentSolValue - entrySol) / entrySol) * 100000) / 100000;
    const peakPnlPct = Math.round(((newPeak - entrySol) / entrySol) * 100000) / 100000;

    // Breakeven Dinâmico Pré-Parcial: ao atingir +12%, stop loss sobe para +1%
    if (!position.partialTaken && peakPnlPct >= (PositionExitEngine.BREAKEVEN_TRIGGER_PCT - 0.0001) && position.stopLossPct < 0.01) {
      position.stopLossPct = 0.01;
    }

    // Trailing Stop dinâmico pós-parcial = pico * (1 - 0.10)
    const trailingStopSolValue = newPeak * (1 - PositionExitEngine.TRAILING_DISTANCE);

    // ==========================================
    // FASE 1: Colheita Parcial em +35% (ou takeProfitPct configurado)
    // ==========================================
    if (!position.partialTaken && pnlPct >= position.takeProfitPct) {
      const tokensToSell = Math.floor(position.tokenAmount / 2);
      position.partialTaken = true;
      position.tokenAmount = position.tokenAmount - tokensToSell;
      position.stopLossPct = 0.01; // Puxa para Breakeven (+1%)
      // Reinicia pico com o valor atual para trailing preciso
      this.peakSolValues.set(mint, currentSolValue);

      return {
        shouldExit: true,
        type: 'PARTIAL_TAKE_PROFIT_50',
        pnlPct,
        currentPriceUsd: currentSolValue,
        exitTokenAmount: tokensToSell,
        shouldCloseAta: false, // NÃO fecha ATA: 50% continuam em custódia
        peakSolValue: currentSolValue,
        trailingStopSolValue: currentSolValue * (1 - PositionExitEngine.TRAILING_DISTANCE)
      };
    }

    // ==========================================
    // FASE 2: Super Runner com Trailing Stop 15%
    // ==========================================
    if (position.partialTaken) {
      // Disparo de Trailing Stop se recuar 15% em relação ao topo máximo
      if (currentSolValue <= trailingStopSolValue) {
        return {
          shouldExit: true,
          type: 'TRAILING_STOP',
          pnlPct,
          currentPriceUsd: currentSolValue,
          exitTokenAmount: position.tokenAmount,
          shouldCloseAta: true, // FECHA ATA: 100% liquidado
          peakSolValue: newPeak,
          trailingStopSolValue
        };
      }

      // Proteção de Breakeven nos 50% restantes: jamais sair no prejuízo
      if (pnlPct <= position.stopLossPct) {
        return {
          shouldExit: true,
          type: 'STOP_LOSS',
          pnlPct,
          currentPriceUsd: currentSolValue,
          exitTokenAmount: position.tokenAmount,
          shouldCloseAta: true,
          peakSolValue: newPeak,
          trailingStopSolValue
        };
      }
    }

    // ==========================================
    // 🧠 AYLA SENTINELA DE SAÍDA ADAPTATIVA
    // ==========================================
    // a) Alerta de Drenagem: Se cotação em SOL ou liquidez USD retornar perda súbita > 30% em relação ao snapshot inicial
    if (context?.currentLiquidityUsd !== undefined && position.entryLiquidityUsd && position.entryLiquidityUsd > 0) {
      const liquidityDropPct = (position.entryLiquidityUsd - context.currentLiquidityUsd) / position.entryLiquidityUsd;
      if (liquidityDropPct > 0.30) {
        return {
          shouldExit: true,
          type: 'STOP_LOSS',
          pnlPct,
          currentPriceUsd: currentSolValue,
          exitTokenAmount: position.tokenAmount,
          shouldCloseAta: true,
          peakSolValue: newPeak,
          trailingStopSolValue,
          reasonDetail: `AYLA_LIQUIDITY_DRAIN: Liquidez despencou ${(liquidityDropPct * 100).toFixed(1)}% vs entrada`
        };
      }
    }

    // Alerta de Drenagem via cotação súbita em SOL (> 30% de perda imediata)
    if (pnlPct < -0.30) {
      return {
        shouldExit: true,
        type: 'STOP_LOSS',
        pnlPct,
        currentPriceUsd: currentSolValue,
        exitTokenAmount: position.tokenAmount,
        shouldCloseAta: true,
        peakSolValue: newPeak,
        trailingStopSolValue,
        reasonDetail: `AYLA_SOL_DRAIN: Queda súbita de ${(Math.abs(pnlPct) * 100).toFixed(1)}% em SOL`
      };
    }

    // b) Time-Stop Dinâmico: Se após 5 minutos o volume estagnar e o PnL flutuar negativo entre -5% e -10%, encerra preventivamente
    const elapsedMs = currentTimestamp - position.entryTimestamp;
    const elapsedMinutes = elapsedMs / (60 * 1000);
    if (!position.partialTaken && elapsedMinutes >= 5 && pnlPct <= -0.05 && pnlPct >= -0.10) {
      const isVolumeStagnant = context?.currentVolume5m !== undefined && position.entryVolume5m !== undefined
        ? context.currentVolume5m <= position.entryVolume5m * 1.05
        : true; // Se sem dados de volume recente mas estagnado no tempo com pnl negativo entre -5% e -10%

      if (isVolumeStagnant) {
        return {
          shouldExit: true,
          type: 'TIME_STOP',
          pnlPct,
          currentPriceUsd: currentSolValue,
          exitTokenAmount: position.tokenAmount,
          shouldCloseAta: true,
          peakSolValue: newPeak,
          trailingStopSolValue,
          reasonDetail: `AYLA_DYNAMIC_TIME_STOP: 5min decorridos com PnL negativo (${(pnlPct * 100).toFixed(1)}%) e volume estagnado`
        };
      }
    }

    // ==========================================
    // PROTEÇÕES PRÉ-PARCIAL (Risco Fixo Inicial)
    // ==========================================
    if (!position.partialTaken) {
      // 1. Stop-Loss Inicial Fixo (-20%)
      if (pnlPct <= position.stopLossPct) {
        return {
          shouldExit: true,
          type: 'STOP_LOSS',
          pnlPct,
          currentPriceUsd: currentSolValue,
          exitTokenAmount: position.tokenAmount,
          shouldCloseAta: true,
          peakSolValue: newPeak,
          trailingStopSolValue
        };
      }

      // 2. Time-Stop de Estagnação Máxima (15 minutos)
      const maxDuration = position.maxHoldDurationMs || PositionExitEngine.DEFAULT_TIME_STOP_MS;
      if (elapsedMs >= maxDuration) {
        return {
          shouldExit: true,
          type: 'TIME_STOP',
          pnlPct,
          currentPriceUsd: currentSolValue,
          exitTokenAmount: position.tokenAmount,
          shouldCloseAta: true,
          peakSolValue: newPeak,
          trailingStopSolValue
        };
      }
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

    // FASE 1: Colheita Parcial em +100%
    if (!position.partialTaken && pnlPct >= position.takeProfitPct) {
      const tokensToSell = Math.floor(position.tokenAmount / 2);
      position.partialTaken = true;
      position.tokenAmount = position.tokenAmount - tokensToSell;
      position.stopLossPct = 0.0;
      return {
        shouldExit: true,
        type: 'PARTIAL_TAKE_PROFIT_50',
        pnlPct,
        currentPriceUsd,
        exitTokenAmount: tokensToSell,
        shouldCloseAta: false
      };
    }

    if (pnlPct <= position.stopLossPct) {
      return {
        shouldExit: true,
        type: 'STOP_LOSS',
        pnlPct,
        currentPriceUsd,
        exitTokenAmount: position.tokenAmount,
        shouldCloseAta: true
      };
    }

    return { shouldExit: false, type: 'HOLD', pnlPct, currentPriceUsd };
  }
}
