// ============================================================
// policyAdapter.ts — Adaptador de Políticas Estatísticas
// Gatilho: N >= 100 trades on-chain verificados + período de estresse
// Avalia calibração empírica e gera proposta de ajuste de thresholds
// ============================================================

import { Pool, PoolClient } from 'pg';
import { CalibrationReport, GateMetric } from './evCalibrationJob.js';

export interface PolicyAdapterRequirements {
  minTradesVerified: number;
  hasMarketStressPeriod: boolean;
  maxDrawdownPct: number;
  drawdownTolerancePct: number;
}

export interface PolicyAdjustmentProposal {
  eligible: boolean;
  currentSampleSize: number;
  requiredSampleSize: number;
  stressPeriodVerified: boolean;
  maxDrawdownRecorded: number;
  proposedChanges: {
    gateName: string;
    currentValue: any;
    recommendedValue: any;
    reason: string;
    action: 'TIGHTEN' | 'LOOSEN' | 'MAINTAIN';
  }[];
  generatedAt: Date;
}

export class PolicyAdapter {
  private static readonly REQUIREMENTS: PolicyAdapterRequirements = {
    minTradesVerified: 100, // N >= 100 trades reais
    hasMarketStressPeriod: true, // Requer teste em estresse
    maxDrawdownPct: 15.0, // Limite de 15% de DD documentado
    drawdownTolerancePct: 20.0,
  };

  /**
   * Avalia se a base empírica atingiu maturidade para adaptação de políticas
   */
  public static evaluatePolicyMaturity(
    report: CalibrationReport,
    historicalMaxDrawdown: number,
    stressPeriodObserved: boolean
  ): PolicyAdjustmentProposal {
    const isEligible =
      report.totalTrades >= this.REQUIREMENTS.minTradesVerified &&
      stressPeriodObserved &&
      historicalMaxDrawdown <= this.REQUIREMENTS.drawdownTolerancePct;

    const proposal: PolicyAdjustmentProposal = {
      eligible: isEligible,
      currentSampleSize: report.totalTrades,
      requiredSampleSize: this.REQUIREMENTS.minTradesVerified,
      stressPeriodVerified: stressPeriodObserved,
      maxDrawdownRecorded: historicalMaxDrawdown,
      proposedChanges: [],
      generatedAt: new Date(),
    };

    if (!isEligible) {
      proposal.proposedChanges.push({
        gateName: 'SYSTEM_WIDE',
        currentValue: 'CURRENT_PARAMETERS',
        recommendedValue: 'NO_CHANGE',
        reason: `Maturidade insuficiente: Trades (${report.totalTrades}/${this.REQUIREMENTS.minTradesVerified}), Estresse: ${stressPeriodObserved}, MaxDD: ${historicalMaxDrawdown.toFixed(1)}%`,
        action: 'MAINTAIN',
      });
      return proposal;
    }

    // Avalia cada gate individualmente para TIGHTEN ou LOOSEN
    for (const metric of report.gateMetrics) {
      if (metric.verdict === 'TIGHTEN') {
        proposal.proposedChanges.push({
          gateName: metric.gateName,
          currentValue: 'STANDARD',
          recommendedValue: 'RESTRICTIVE',
          reason: `Lift estatisticamente negativo ou EV inferior aos custos (${metric.evNetPct.toFixed(2)}%)`,
          action: 'TIGHTEN',
        });
      } else if (metric.verdict === 'LOOSEN' && metric.evNetPct > 3.0) {
        proposal.proposedChanges.push({
          gateName: metric.gateName,
          currentValue: 'STANDARD',
          recommendedValue: 'EXPANSIVE',
          reason: `Lift consistente com intervalo de confiança positivo (${metric.ciLowerPct.toFixed(2)}% a ${metric.ciUpperPct.toFixed(2)}%)`,
          action: 'LOOSEN',
        });
      } else {
        proposal.proposedChanges.push({
          gateName: metric.gateName,
          currentValue: 'STANDARD',
          recommendedValue: 'MAINTAIN',
          reason: `Desempenho neutro ou intervalo de confiança cruza zero`,
          action: 'MAINTAIN',
        });
      }
    }

    return proposal;
  }
}
