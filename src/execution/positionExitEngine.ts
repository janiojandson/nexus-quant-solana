export interface PositionTracking {
  mint: string;
  symbol: string;
  tokenAmount: number;
  entryPriceUsd: number;
  entryTimestamp: number;
  stopLossPct: number;    // Ex: -8% (-0.08) inicial
  takeProfitPct: number;  // Ex: +35% (+0.35) para colheita parcial
  entrySol?: number;      // Ex: 0.015 SOL investidos na entrada
  maxHoldDurationMs?: number; // Padrão: 15 minutos (15 * 60 * 1000)
  partialTaken?: boolean; // True quando a parcial de 50% em +35% foi executada
  initialTokenAmount?: number; // Lote original total
  // Snapshot de Entrada (Contexto Inicial da Operação):
  entrySolValue?: number;
  entryLiquidityUsd?: number;
  entryVolume5m?: number;
  entryPairAddress?: string;
  traceId?: string;
  // Estado de proteção propagado para o painel pelo monitor de 1.5s.
  trailingActive?: boolean;
  trailingStopSolValue?: number;
  stopStatusText?: string;
  /** Legado: pico executável usado pelo trailing. */
  peakSolValue?: number;
  /** Maior valor observado por sensor de alta frequência, mesmo sem rota executável. */
  observablePeakSolValue?: number;
  /** Maior valor confirmado como executável/localmente vendável. */
  executablePeakSolValue?: number;
  /** Última cotação executável Jupiter; pode cair sem reduzir o pico executável. */
  lastJupiterExecutableSolValue?: number;
  /** Epoch ms da última rota de saída comprovadamente saudável. */
  lastHealthyExitRouteAt?: number;
}

export interface PositionInput extends Omit<PositionTracking, 'stopLossPct' | 'takeProfitPct'> {
  stopLossPct?: number;
  takeProfitPct?: number;
}

export interface ExitRouteObservation {
  observableSolValue?: number;
  executableSolValue?: number;
  jupiterExecutableSolValue?: number;
  healthyAtMs?: number;
}

export interface ExitWatermarks {
  observablePeakSolValue: number;
  executablePeakSolValue: number;
  lastJupiterExecutableSolValue?: number;
  lastHealthyExitRouteAt?: number;
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
  exitReason: 'TAKE_PROFIT' | 'PARTIAL_TAKE_PROFIT_50' | 'STOP_LOSS' | 'TRAILING_STOP' | 'TIME_STOP' | 'MANUAL' | 'LAYA_EXIT' | 'WATCHDOG_EXIT' | 'HOLD';
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
  public static readonly DEFAULT_TIME_STOP_MS = 10 * 60 * 1000; // 10 minutos (hard limit ágil condicional)
  public static readonly DEFAULT_STOP_LOSS_PCT = -0.06;         // -6% Stop Loss Lógico (efetivo ~-8% a -9% com slippage)
  public static readonly BREAKEVEN_TRIGGER_PCT = 0.12;          // +12% ativa Breakeven (+1%)
  public static readonly DEFAULT_TAKE_PROFIT_PCT = 0.35;        // +35% Parcial de 50%
  /** Proteção de momentum antes da parcial: ativa a partir de +8%. */
  public static readonly EARLY_TRAILING_TRIGGER_PCT = 0.08;
  public static readonly EARLY_TRAILING_DISTANCE = 0.06;        // aceita recuo de 6% do pico
  /** Trailing pós-parcial: SL dinâmico = pico * (1 - TRAILING_DISTANCE) */
  public static readonly TRAILING_DISTANCE = 0.10;              // -10% do pico máximo
  /** Time-Stop estendido para posições com PnL positivo após 10min */
  public static readonly EXTENDED_TIME_STOP_POSITIVE_MS = 25 * 60 * 1000;  // 25 minutos
  /** Time-Stop estendido para posições com PnL neutro (-3% a 0%) e volume ativo */
  public static readonly EXTENDED_TIME_STOP_NEUTRAL_MS = 20 * 60 * 1000;   // 20 minutos

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
    const peak = this.peakSolValues.get(mint) || pos.entrySol || 0.015;
    const entrySol = pos.entrySol || 0.015;
    const peakPnlPct = (peak - entrySol) / entrySol;
    if (peakPnlPct >= PositionExitEngine.EARLY_TRAILING_TRIGGER_PCT) {
      const trailSol = peak * (1 - PositionExitEngine.EARLY_TRAILING_DISTANCE);
      const trailPct = ((trailSol - entrySol) / entrySol) * 100;
      return `Stop Ativo: Trailing Momentum (-6% do Topo: ${trailPct >= 0 ? '+' : ''}${trailPct.toFixed(2)}%)`;
    }
    if (pos.stopLossPct >= 0.01) {
      return `Stop Ativo: Breakeven (+${(pos.stopLossPct * 100).toFixed(1)}%) | Trailing: INATIVO`;
    }
    return `Stop Ativo: SL Fixo (${(pos.stopLossPct * 100).toFixed(2)}%) | Trailing: aguardando +8%`;
  }

  public addPosition(position: PositionInput): void {
    const fullPosition: PositionTracking = {
      ...position,
      stopLossPct: position.stopLossPct ?? PositionExitEngine.DEFAULT_STOP_LOSS_PCT,
      takeProfitPct: position.takeProfitPct ?? PositionExitEngine.DEFAULT_TAKE_PROFIT_PCT,
      maxHoldDurationMs: position.maxHoldDurationMs || PositionExitEngine.DEFAULT_TIME_STOP_MS,
      initialTokenAmount: position.initialTokenAmount || position.tokenAmount
    };
    this.activePositions.set(fullPosition.mint, fullPosition);
    // Inicializa/reidrata o pico. Em restart de um runner, nunca devemos
    // esquecer o watermark já persistido e afrouxar o trailing silenciosamente.
    const entrySol = fullPosition.entrySol || 0.015;
    const restoredExecutablePeak = Number(
      fullPosition.executablePeakSolValue ?? fullPosition.peakSolValue ?? 0
    );
    const executablePeak = Number.isFinite(restoredExecutablePeak) && restoredExecutablePeak > entrySol
      ? restoredExecutablePeak
      : entrySol;
    const restoredObservablePeak = Number(fullPosition.observablePeakSolValue ?? 0);
    const observablePeak = Number.isFinite(restoredObservablePeak) && restoredObservablePeak > executablePeak
      ? restoredObservablePeak
      : executablePeak;

    fullPosition.executablePeakSolValue = executablePeak;
    fullPosition.observablePeakSolValue = observablePeak;
    fullPosition.peakSolValue = executablePeak;
    this.peakSolValues.set(fullPosition.mint, executablePeak);
  }

  public recordExitRouteObservation(mint: string, observation: ExitRouteObservation): boolean {
    const position = this.activePositions.get(mint);
    if (!position) return false;

    const entrySol = position.entrySol || 0.015;
    const currentExecutablePeak = this.peakSolValues.get(mint) || entrySol;
    const currentObservablePeak = Number(position.observablePeakSolValue || currentExecutablePeak);

    const observable = Number(observation.observableSolValue);
    if (Number.isFinite(observable) && observable > 0) {
      position.observablePeakSolValue = Math.max(currentObservablePeak, observable);
    }

    const executable = Number(observation.executableSolValue);
    if (Number.isFinite(executable) && executable > 0) {
      const nextExecutablePeak = Math.max(currentExecutablePeak, executable);
      this.peakSolValues.set(mint, nextExecutablePeak);
      position.executablePeakSolValue = nextExecutablePeak;
      position.peakSolValue = nextExecutablePeak;
      position.observablePeakSolValue = Math.max(
        Number(position.observablePeakSolValue || nextExecutablePeak),
        nextExecutablePeak
      );
    }

    const jupiterValue = Number(observation.jupiterExecutableSolValue);
    if (Number.isFinite(jupiterValue) && jupiterValue > 0) {
      position.lastJupiterExecutableSolValue = jupiterValue;
    }

    const healthyAtMs = Number(observation.healthyAtMs);
    if (Number.isFinite(healthyAtMs) && healthyAtMs > 0) {
      position.lastHealthyExitRouteAt = Math.max(
        Number(position.lastHealthyExitRouteAt || 0),
        healthyAtMs
      );
    }

    return true;
  }

  public getExitWatermarks(mint: string): ExitWatermarks {
    const position = this.activePositions.get(mint);
    const executablePeak = this.peakSolValues.get(mint) || position?.entrySol || 0;
    return {
      observablePeakSolValue: Number(position?.observablePeakSolValue || executablePeak),
      executablePeakSolValue: Number(position?.executablePeakSolValue || executablePeak),
      lastJupiterExecutableSolValue: position?.lastJupiterExecutableSolValue,
      lastHealthyExitRouteAt: position?.lastHealthyExitRouteAt
    };
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

  /**
   * Aplica a mutação local da parcial SOMENTE depois que o swap foi confirmado.
   * Evita marcar 50% como vendidos quando a transação falha ou fica sem confirmação.
   */
  public commitPartialExit(mint: string, tokensSold: number, currentSolValue: number): boolean {
    const position = this.activePositions.get(mint);
    if (!position || position.partialTaken) return false;
    const sold = Math.floor(tokensSold);
    if (!Number.isFinite(sold) || sold <= 0 || sold >= position.tokenAmount) return false;

    const tokenAmountBefore = position.tokenAmount;
    const remaining = tokenAmountBefore - sold;
    const remainingRatio = remaining / tokenAmountBefore;

    position.partialTaken = true;
    position.tokenAmount = remaining;
    // O runner restante precisa carregar apenas o custo-base proporcional.
    // Sem isto, 50% dos tokens eram comparados contra 100% do SOL investido.
    position.entrySol = (position.entrySol || 0.015) * remainingRatio;
    position.stopLossPct = 0.01;
    const reducedPeak = Math.max(currentSolValue, this.peakSolValues.get(mint) || 0, position.executablePeakSolValue || 0) * remainingRatio;
    this.peakSolValues.set(mint, reducedPeak);
    position.peakSolValue = reducedPeak;
    position.executablePeakSolValue = reducedPeak;
    position.observablePeakSolValue = reducedPeak;
    if (position.lastJupiterExecutableSolValue != null) {
      position.lastJupiterExecutableSolValue *= remainingRatio;
    }
    return true;
  }

  public removePosition(mint: string): void {
    this.activePositions.delete(mint);
    this.peakSolValues.delete(mint);
    this.quoteFailures.delete(mint);
  }

  public clearPositions(): void {
    this.activePositions.clear();
    this.peakSolValues.clear();
    this.quoteFailures.clear();
  }

  /** Contador de falhas consecutivas de cotação para o Watchdog de Telemetria */
  private quoteFailures = new Map<string, number>();
  public static readonly WATCHDOG_WARN_FAILURES = 5;      // 5 falhas (~7.5s) emite aviso
  public static readonly WATCHDOG_EMERGENCY_FAILURES = 8; // 8 falhas (~12s) dispara liquidação defensiva

  public recordQuoteSuccess(mint: string): void {
    this.quoteFailures.delete(mint);
  }

  public recordQuoteFailure(mint: string): { failures: number; shouldWarn: boolean; shouldEmergencyExit: boolean } {
    const current = (this.quoteFailures.get(mint) || 0) + 1;
    this.quoteFailures.set(mint, current);
    return {
      failures: current,
      shouldWarn: current >= PositionExitEngine.WATCHDOG_WARN_FAILURES && current < PositionExitEngine.WATCHDOG_EMERGENCY_FAILURES,
      shouldEmergencyExit: current >= PositionExitEngine.WATCHDOG_EMERGENCY_FAILURES
    };
  }

  public getQuoteFailures(mint: string): number {
    return this.quoteFailures.get(mint) || 0;
  }

  public clearQuoteFailures(mint: string): void {
    this.quoteFailures.delete(mint);
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
   * - Stop-Loss Lógico em -6% (efetivo ~-8% a -9% com slippage) -> Encerra 100% e FECHA ATA.
   * - Breakeven em +12%: Se o pico atingir >= +12%, stop sobe para +1% (trade sem risco de perda).
   * - Time-Stop Condicional:
   *   - PnL > 0% após 10min: estende para 25 minutos (momentum lento positivo).
   *   - PnL entre -3% e 0% com volume crescente: estende para 20 minutos.
   *   - PnL < -3% e volume estagnado: encerra aos 15 minutos (hard limit).
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
      // CORREÇÃO: Log de debug para posição não encontrada
      if (!position) {
        console.warn(`[ExitEngine] Posição não encontrada: ${mint}`);
      }
      return { shouldExit: false, type: 'HOLD', pnlPct: 0, currentPriceUsd: 0 };
    }

    // O valor fornecido aqui é executável/localmente vendável. Atualiza o
    // watermark executável sem jamais permitir que uma leitura menor reduza o topo.
    const previousPeak = this.peakSolValues.get(mint) || entrySol;
    this.recordExitRouteObservation(mint, {
      observableSolValue: currentSolValue,
      executableSolValue: currentSolValue
    });
    const newPeak = this.peakSolValues.get(mint) || previousPeak;

    const pnlPct = Math.round(((currentSolValue - entrySol) / entrySol) * 100000) / 100000;
    const peakPnlPct = Math.round(((newPeak - entrySol) / entrySol) * 100000) / 100000;

    // CORREÇÃO: Log de debug para avaliação de saída
    console.log(`[ExitEngine] ${position.symbol} | PnL: ${(pnlPct * 100).toFixed(2)}% | SL: ${(position.stopLossPct * 100).toFixed(0)}% | partialTaken: ${position.partialTaken} | Valor: ${currentSolValue.toFixed(4)} SOL`);

    // Breakeven Dinâmico Pré-Parcial: ao atingir +12%, stop loss sobe para +1%
    if (!position.partialTaken && peakPnlPct >= (PositionExitEngine.BREAKEVEN_TRIGGER_PCT - 0.0001) && position.stopLossPct < 0.01) {
      position.stopLossPct = 0.01;
    }

    // Trailing Stop dinâmico pós-parcial = pico * (1 - 0.10)
    const trailingStopSolValue = newPeak * (1 - PositionExitEngine.TRAILING_DISTANCE);

    // ==========================================
    // Protecoes de saida total precedem colheitas parciais
    // ==========================================

    // Proteção de momentum pré-parcial: depois de atingir +8%, acompanha o topo
    // com folga de 6%. Se a alta perder força antes da parcial de +35%, encerra
    // 100% preservando o ganho em vez de devolver todo o movimento.
    if (!position.partialTaken && peakPnlPct >= PositionExitEngine.EARLY_TRAILING_TRIGGER_PCT) {
      const earlyTrailingStopSolValue = newPeak * (1 - PositionExitEngine.EARLY_TRAILING_DISTANCE);
      if (earlyTrailingStopSolValue > entrySol && currentSolValue <= earlyTrailingStopSolValue) {
        return {
          shouldExit: true,
          type: 'TRAILING_STOP',
          pnlPct,
          currentPriceUsd: currentSolValue,
          exitTokenAmount: position.tokenAmount,
          shouldCloseAta: true,
          peakSolValue: newPeak,
          trailingStopSolValue: earlyTrailingStopSolValue,
          trailingActive: true,
          reasonDetail: 'EARLY_MOMENTUM_TRAILING'
        };
      }
    }

    // ==========================================
    // FASE 2: Super Runner com Trailing Stop 10%
    // ==========================================
    if (position.partialTaken) {
      // Disparo de Trailing Stop se recuar 10% em relação ao topo máximo
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
          reasonDetail: `SOLANA_LIQUIDITY_DRAIN: Liquidez despencou ${(liquidityDropPct * 100).toFixed(1)}% vs entrada`
        };
      }
    }

    // Alerta de Drenagem via cotação súbita em SOL (> 30% de perda imediata)
    if (!position.partialTaken && pnlPct >= position.takeProfitPct) {
      const tokensToSell = Math.floor(position.tokenAmount / 2);

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
        reasonDetail: `SOLANA_SOL_DRAIN: Queda súbita de ${(Math.abs(pnlPct) * 100).toFixed(1)}% em SOL`
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
          reasonDetail: `SOLANA_DYNAMIC_TIME_STOP: 5min decorridos com PnL negativo (${(pnlPct * 100).toFixed(1)}%) e volume estagnado`
        };
      }
    }

    // ==========================================
    // PROTEÇÕES PRÉ-PARCIAL (Risco Fixo Inicial)
    // ==========================================
    if (!position.partialTaken) {
      // 1. Stop-Loss Lógico (-6%, efetivo ~-8% a -9% com slippage)
      if (pnlPct <= position.stopLossPct) {
        // CORREÇÃO: Log de debug para stop loss
        console.log(`🛑 [STOP LOSS DISPARADO] ${position.symbol} | PnL: ${(pnlPct * 100).toFixed(2)}% | SL: ${(position.stopLossPct * 100).toFixed(0)}% | Valor: ${currentSolValue.toFixed(4)} SOL`);
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

      // 2. Time-Stop Condicional (adapta duração ao contexto da posição)
      const maxDuration = position.maxHoldDurationMs || PositionExitEngine.DEFAULT_TIME_STOP_MS;
      const isVolumeGrowing = context?.currentVolume5m !== undefined && position.entryVolume5m !== undefined
        ? context.currentVolume5m > position.entryVolume5m * 1.05
        : false;

      let effectiveTimeStopMs = maxDuration; // 10min base
      if (pnlPct > 0 && elapsedMinutes >= 8) {
        effectiveTimeStopMs = PositionExitEngine.EXTENDED_TIME_STOP_POSITIVE_MS; // 25min
      } else if (pnlPct >= -0.03 && pnlPct <= 0 && isVolumeGrowing) {
        effectiveTimeStopMs = PositionExitEngine.EXTENDED_TIME_STOP_NEUTRAL_MS;  // 20min
      }

      if (elapsedMs >= effectiveTimeStopMs) {
        const reasonParts: string[] = [];
        if (effectiveTimeStopMs === maxDuration) {
          reasonParts.push(`Hard limit ${Math.round(maxDuration / 60000)}min`);
        } else {
          reasonParts.push(`Extended ${Math.round(effectiveTimeStopMs / 60000)}min`);
        }
        reasonParts.push(`PnL: ${(pnlPct * 100).toFixed(1)}%`);
        if (!isVolumeGrowing) reasonParts.push('volume estagnado');

        return {
          shouldExit: true,
          type: 'TIME_STOP',
          pnlPct,
          currentPriceUsd: currentSolValue,
          exitTokenAmount: position.tokenAmount,
          shouldCloseAta: true,
          peakSolValue: newPeak,
          trailingStopSolValue,
          reasonDetail: `TIME_STOP_CONDICIONAL: ${reasonParts.join(' | ')}`
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
