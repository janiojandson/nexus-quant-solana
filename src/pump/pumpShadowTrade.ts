import { calculateNetTradeEconomics } from './pumpEconomics.js';
import type { PumpStrategyCohort } from './pumpCohorts.js';

export type PumpShadowVenue = 'PUMP_DIRECT_MODEL' | 'JUPITER_ROUTE' | 'PUMPSWAP';

export interface PumpShadowTradeInput {
  mint: string;
  cohort: PumpStrategyCohort;
  venue: PumpShadowVenue;
  entryAtMs: number;
  entryPrincipalSol: number;
  entryFeeBps: number;
  entrySlippageBps: number;
  priorityFeeLamports: number;
  networkFeeLamports: number;
}

export interface PumpShadowExitInput {
  horizon: string;
  observedAtMs: number;
  grossExitValueSol: number;
  executable: boolean;
  exitFeeBps: number;
  exitSlippageBps: number;
  priorityFeeLamports?: number;
  networkFeeLamports?: number;
}

export interface PumpShadowExitMark extends PumpShadowExitInput {
  netPnlSol?: number;
  netReturnPct?: number;
  totalCostSol?: number;
}

export interface PumpShadowTrade extends PumpShadowTradeInput {
  exitMarks: PumpShadowExitMark[];
}

export function createShadowTrade(input: PumpShadowTradeInput): PumpShadowTrade {
  return { ...input, exitMarks: [] };
}

export function recordShadowExitMark(
  trade: PumpShadowTrade,
  input: PumpShadowExitInput
): PumpShadowExitMark {
  const mark: PumpShadowExitMark = { ...input };
  if (input.executable) {
    const economics = calculateNetTradeEconomics({
      entryPrincipalSol: trade.entryPrincipalSol,
      grossExitValueSol: input.grossExitValueSol,
      entryFeeBps: trade.entryFeeBps,
      exitFeeBps: input.exitFeeBps,
      entrySlippageBps: trade.entrySlippageBps,
      exitSlippageBps: input.exitSlippageBps,
      priorityFeeLamports: trade.priorityFeeLamports + (input.priorityFeeLamports ?? 0),
      networkFeeLamports: trade.networkFeeLamports + (input.networkFeeLamports ?? 0)
    });
    mark.netPnlSol = economics.netPnlSol;
    mark.netReturnPct = economics.netReturnPct;
    mark.totalCostSol = economics.totalCostSol;
  }
  trade.exitMarks.push(mark);
  return mark;
}
