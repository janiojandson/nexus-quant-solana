export const PUMP_BONDING_CURVE_TOTAL_FEE_BPS = 125;

export interface FeeTier {
  maxExclusive: number;
  feeBps: number;
}

export interface TradeEconomicsInput {
  entryPrincipalSol: number;
  grossExitValueSol: number;
  entryFeeBps: number;
  exitFeeBps: number;
  entrySlippageBps: number;
  exitSlippageBps: number;
  priorityFeeLamports: number;
  networkFeeLamports: number;
  fixedPlanAllocationSol?: number;
}

export interface TradeEconomicsResult {
  entryVariableCostSol: number;
  exitVariableCostSol: number;
  networkCostSol: number;
  fixedPlanAllocationSol: number;
  totalCostSol: number;
  netExitValueSol: number;
  netPnlSol: number;
  netReturnPct: number;
}

function nonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function bpsCost(base: number, bps: number): number {
  return nonNegative(base) * nonNegative(bps) / 10_000;
}

export function resolveTieredFeeBps(marketCap: number, tiers: FeeTier[]): number {
  const cap = nonNegative(marketCap);
  const ordered = [...tiers].sort((a, b) => a.maxExclusive - b.maxExclusive);
  const tier = ordered.find(item => cap < item.maxExclusive);
  return nonNegative(tier?.feeBps ?? ordered.at(-1)?.feeBps ?? 0);
}

export function calculateNetTradeEconomics(input: TradeEconomicsInput): TradeEconomicsResult {
  const entryPrincipalSol = nonNegative(input.entryPrincipalSol);
  const grossExitValueSol = nonNegative(input.grossExitValueSol);
  const entryVariableCostSol =
    bpsCost(entryPrincipalSol, input.entryFeeBps) +
    bpsCost(entryPrincipalSol, input.entrySlippageBps);
  const exitVariableCostSol =
    bpsCost(grossExitValueSol, input.exitFeeBps) +
    bpsCost(grossExitValueSol, input.exitSlippageBps);
  const networkCostSol =
    (nonNegative(input.priorityFeeLamports) + nonNegative(input.networkFeeLamports)) / 1e9;
  const fixedPlanAllocationSol = nonNegative(input.fixedPlanAllocationSol ?? 0);
  const totalCostSol =
    entryVariableCostSol +
    exitVariableCostSol +
    networkCostSol +
    fixedPlanAllocationSol;
  const netExitValueSol = Math.max(0, grossExitValueSol - exitVariableCostSol - networkCostSol - fixedPlanAllocationSol);
  const netPnlSol = grossExitValueSol - entryPrincipalSol - totalCostSol;
  const netReturnPct = entryPrincipalSol > 0
    ? (netPnlSol / entryPrincipalSol) * 100
    : 0;

  return {
    entryVariableCostSol,
    exitVariableCostSol,
    networkCostSol,
    fixedPlanAllocationSol,
    totalCostSol,
    netExitValueSol,
    netPnlSol,
    netReturnPct
  };
}
