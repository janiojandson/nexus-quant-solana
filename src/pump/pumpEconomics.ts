export const PUMP_BONDING_CURVE_TOTAL_FEE_BPS = 125;

/**
 * Canonical PumpSwap SOL fee schedule documented by Pump as of 2026-05-20.
 * Market-cap bands are denominated in SOL. Keep this as versioned reference
 * data: the official fee page can change and future runtime adapters may
 * override/refresh it rather than treating these values as immutable.
 */
export const PUMP_SWAP_SOL_FEE_TIERS: readonly FeeTier[] = [
  { maxExclusive: 420, feeBps: 125 },
  { maxExclusive: 1_470, feeBps: 120 },
  { maxExclusive: 2_460, feeBps: 115 },
  { maxExclusive: 3_440, feeBps: 110 },
  { maxExclusive: 4_420, feeBps: 105 },
  { maxExclusive: 9_820, feeBps: 100 },
  { maxExclusive: 14_740, feeBps: 95 },
  { maxExclusive: 19_650, feeBps: 90 },
  { maxExclusive: 24_560, feeBps: 85 },
  { maxExclusive: 29_470, feeBps: 80 },
  { maxExclusive: 34_380, feeBps: 75 },
  { maxExclusive: 39_300, feeBps: 70 },
  { maxExclusive: 44_210, feeBps: 65 },
  { maxExclusive: 49_120, feeBps: 60 },
  { maxExclusive: 54_030, feeBps: 55 },
  { maxExclusive: 58_940, feeBps: 52.5 },
  { maxExclusive: 63_860, feeBps: 50 },
  { maxExclusive: 68_770, feeBps: 47.5 },
  { maxExclusive: 73_681, feeBps: 45 },
  { maxExclusive: 78_590, feeBps: 42.5 },
  { maxExclusive: 83_500, feeBps: 40 },
  { maxExclusive: 88_400, feeBps: 37.5 },
  { maxExclusive: 93_330, feeBps: 35 },
  { maxExclusive: 98_240, feeBps: 32.5 },
  { maxExclusive: Number.POSITIVE_INFINITY, feeBps: 30 }
] as const;

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

export function resolveTieredFeeBps(marketCap: number, tiers: readonly FeeTier[]): number {
  const cap = nonNegative(marketCap);
  const ordered = [...tiers].sort((a, b) => a.maxExclusive - b.maxExclusive);
  const tier = ordered.find(item => cap < item.maxExclusive);
  return nonNegative(tier?.feeBps ?? ordered.at(-1)?.feeBps ?? 0);
}

export function resolveCurrentPumpSwapSolFeeBps(marketCapSol: number): number {
  return resolveTieredFeeBps(marketCapSol, PUMP_SWAP_SOL_FEE_TIERS);
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
