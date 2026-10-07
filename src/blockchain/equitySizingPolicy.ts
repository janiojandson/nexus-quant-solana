import { BUY_AMOUNT_SOL } from '../config/env.js';

export interface OpenCapitalPosition {
  costBasisSol: number;
  executableValueSol?: number;
}

export interface EquitySizingPolicyInput {
  cashBalanceSol: number;
  positions: OpenCapitalPosition[];
  maxPositions?: number;
  entryEquityPct?: number;
  maxTotalAllocationPct?: number;
  maxEntrySol?: number;
  maxTotalAllocationSol?: number;
  minExecutableEntrySol?: number;
  gasReserveEquityPct?: number;
  minGasReserveSol?: number;
  maxGasReserveSol?: number;
}

export interface EquitySizingPolicy {
  cashBalanceSol: number;
  openCostBasisSol: number;
  openExecutableValueSol: number;
  portfolioEquitySol: number;
  gasReserveSol: number;
  spendableCashSol: number;
  entryEquityPct: number;
  targetEntrySol: number;
  totalAllocationLimitSol: number;
  remainingAllocationSol: number;
  selectedEntryCapSol: number;
  ladderSol: number[];
  slotsRemaining: number;
  canOpenNextPosition: boolean;
}

const floorLamports = (value: number): number =>
  Math.floor(Math.max(0, value) * 1e9 + 1e-6) / 1e9;

function uniqueDescending(values: number[]): number[] {
  const seen = new Set<string>();
  return values
    .map(floorLamports)
    .filter(value => value > 0)
    .sort((a, b) => b - a)
    .filter(value => {
      const key = value.toFixed(9);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

export function buildEquitySizingPolicy(
  input: EquitySizingPolicyInput
): EquitySizingPolicy {
  const cashBalanceSol = Math.max(0, input.cashBalanceSol);
  const positions = input.positions;
  const openCostBasisSol = positions.reduce(
    (sum, position) => sum + (
      Number.isFinite(position.costBasisSol) && position.costBasisSol > 0
        ? position.costBasisSol
        : 0
    ),
    0
  );
  const openExecutableValueSol = positions.reduce(
    (sum, position) => {
      const costBasis = Number.isFinite(position.costBasisSol) && position.costBasisSol > 0
        ? position.costBasisSol
        : 0;
      const executable = Number.isFinite(position.executableValueSol) &&
        Number(position.executableValueSol) > 0
        ? Number(position.executableValueSol)
        : costBasis;
      return sum + executable;
    },
    0
  );
  const portfolioEquitySol = cashBalanceSol + openExecutableValueSol;
  const maxPositions = Math.max(1, Math.floor(input.maxPositions ?? 2));
  const slotsRemaining = Math.max(0, maxPositions - positions.length);
  const entryEquityPct = Math.min(0.25, Math.max(0.01, input.entryEquityPct ?? 0.10));
  const maxTotalAllocationPct = Math.min(
    0.50,
    Math.max(entryEquityPct, input.maxTotalAllocationPct ?? entryEquityPct * maxPositions)
  );
  const maxEntrySol = Math.max(0, input.maxEntrySol ?? BUY_AMOUNT_SOL);
  const maxTotalAllocationSol = Math.max(0, input.maxTotalAllocationSol ?? (BUY_AMOUNT_SOL * maxPositions));
  const minExecutableEntrySol = Math.max(0.0001, input.minExecutableEntrySol ?? 0.001);
  const gasReserveEquityPct = Math.min(0.25, Math.max(0, input.gasReserveEquityPct ?? 0.10));
  const minGasReserveSol = Math.max(0, input.minGasReserveSol ?? 0.01);
  const maxGasReserveSol = Math.max(minGasReserveSol, input.maxGasReserveSol ?? 0.05);

  const gasReserveSol = Math.min(
    maxGasReserveSol,
    Math.max(minGasReserveSol, portfolioEquitySol * gasReserveEquityPct)
  );
  const spendableCashSol = Math.max(0, cashBalanceSol - gasReserveSol);
  const targetEntrySol = Math.min(maxEntrySol, portfolioEquitySol * entryEquityPct);
  const totalAllocationLimitSol = Math.min(
    maxTotalAllocationSol,
    portfolioEquitySol * maxTotalAllocationPct
  );
  const remainingAllocationSol = Math.max(0, totalAllocationLimitSol - openCostBasisSol);
  const selectedEntryCapSol = floorLamports(Math.min(
    targetEntrySol,
    spendableCashSol,
    remainingAllocationSol
  ));

  const ladderSol = selectedEntryCapSol >= minExecutableEntrySol
    ? uniqueDescending([
        selectedEntryCapSol,
        selectedEntryCapSol * 0.70,
        selectedEntryCapSol * 0.40,
        selectedEntryCapSol * 0.20,
        minExecutableEntrySol
      ]).filter(value => value >= minExecutableEntrySol)
    : [];

  return {
    cashBalanceSol,
    openCostBasisSol,
    openExecutableValueSol,
    portfolioEquitySol,
    gasReserveSol,
    spendableCashSol,
    entryEquityPct,
    targetEntrySol,
    totalAllocationLimitSol,
    remainingAllocationSol,
    selectedEntryCapSol,
    ladderSol,
    slotsRemaining,
    canOpenNextPosition: slotsRemaining > 0 && ladderSol.length > 0
  };
}
