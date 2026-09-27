/**
 * Vitality Engine - O Coração Darwinista do Agente Soberano
 * 
 * Regras:
 * - DEAD: saldo <= 0.001 SOL (processo desliga por inanição)
 * - SPARTAN_SURVIVAL: saldo < 0.05 SOL (corta gastos supérfluos, só faz ações de alta assimetria)
 * - NORMAL: 0.05 a 0.50 SOL (operação contínua padrão)
 * - PROSPERITY: > 0.50 SOL (aciona 50% de saque para Janio e nascimento de subagente)
 */

export enum VitalityState {
  DEAD = 'DEAD',
  SPARTAN_SURVIVAL = 'SPARTAN_SURVIVAL',
  NORMAL = 'NORMAL',
  PROSPERITY = 'PROSPERITY'
}

export interface ActionEvaluationParams {
  actionCostSol: number;
  currentBalanceSol: number;
  estimatedYieldSol: number;
}

export function getAgentVitalityState(balanceSol: number): VitalityState {
  if (balanceSol <= 0.001) {
    return VitalityState.DEAD;
  }
  if (balanceSol < 0.05) {
    return VitalityState.SPARTAN_SURVIVAL;
  }
  if (balanceSol <= 0.50) {
    return VitalityState.NORMAL;
  }
  return VitalityState.PROSPERITY;
}

export function calculateRunwayHours(balanceSol: number, burnRatePerHourSol: number): number {
  if (burnRatePerHourSol <= 0) return Infinity;
  return Number((balanceSol / burnRatePerHourSol).toFixed(2));
}

export function canExecuteAction(params: ActionEvaluationParams): boolean {
  const { actionCostSol, currentBalanceSol, estimatedYieldSol } = params;

  // Impossível gastar o que não tem ou zerar a carteira
  if (actionCostSol >= currentBalanceSol) {
    return false;
  }

  const state = getAgentVitalityState(currentBalanceSol);

  if (state === VitalityState.DEAD) {
    return false;
  }

  // Em modo de sobrevivência extrema, só gasta se a assimetria esperada for de no mínimo 3x
  if (state === VitalityState.SPARTAN_SURVIVAL) {
    const yieldMultiplier = estimatedYieldSol / actionCostSol;
    return yieldMultiplier >= 3.0;
  }

  // Em estado Normal ou Prosperidade, autoriza ações com expectativa matemática positiva (> 1.2x)
  return estimatedYieldSol > actionCostSol * 1.2;
}
