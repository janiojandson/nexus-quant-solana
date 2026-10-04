/**
 * Nexus Quant Solana — V2.1A Fill Ledger Financial Accounting
 *
 * Provides pure, deterministic financial accounting transitions for fills:
 * - Strict BigInt arithmetic for atomic tokens and lamports (zero IEEE 754 precision loss).
 * - Prorated entry cost basis allocation for partial tranches (e.g. 50% partial exit).
 * - Strict segregation of Rent reclamation (deposit refund, NOT trading gain).
 * - Calculation of net recovered capital, capital recovered percentage, and realized PnL.
 */

import { FillRecord } from './types';
import { TradeId, PositionId, TradeAccounting } from '../types/telemetry';

export interface PositionAccountingSnapshot {
  readonly tradeId: TradeId;
  readonly positionId: PositionId;
  readonly mint: string;
  readonly initialTokensAtomic: bigint;
  readonly remainingTokensAtomic: bigint;
  readonly initialPrincipalLamports: bigint;
  readonly entryFeesLamports: bigint;
  readonly totalGrossProceedsLamports: bigint;
  readonly totalTradingCostsLamports: bigint;
  readonly totalRentMovementLamports: bigint;
  readonly realizedPnlLamports: bigint;
  readonly fillsCount: number;
  readonly isFullyClosed: boolean;
}

export interface CreatePositionAccountingParams {
  tradeId: TradeId;
  positionId: PositionId;
  mint: string;
  initialTokensAtomic: string | bigint;
  initialPrincipalLamports: string | bigint;
  entryFeesLamports?: string | bigint;
}

/**
 * Initializes a clean position accounting snapshot at trade entry.
 */
export function createInitialPositionAccounting(
  params: CreatePositionAccountingParams
): PositionAccountingSnapshot {
  return {
    tradeId: params.tradeId,
    positionId: params.positionId,
    mint: params.mint,
    initialTokensAtomic: BigInt(params.initialTokensAtomic),
    remainingTokensAtomic: BigInt(params.initialTokensAtomic),
    initialPrincipalLamports: BigInt(params.initialPrincipalLamports),
    entryFeesLamports: params.entryFeesLamports !== undefined ? BigInt(params.entryFeesLamports) : 0n,
    totalGrossProceedsLamports: 0n,
    totalTradingCostsLamports: 0n,
    totalRentMovementLamports: 0n,
    realizedPnlLamports: 0n,
    fillsCount: 0,
    isFullyClosed: false
  };
}

/**
 * Pure transition function applying a confirmed FillRecord to the position accounting state.
 */
export function applyFillToAccounting(
  current: PositionAccountingSnapshot,
  fill: FillRecord
): PositionAccountingSnapshot {
  const fillTokens = BigInt(fill.actualAmountAtomic);
  if (fillTokens < 0n) {
    throw new Error(`Invalid fill actualAmountAtomic: ${fill.actualAmountAtomic} cannot be negative.`);
  }

  if (fillTokens > current.remainingTokensAtomic) {
    throw new Error(
      `Oversell violation: fill amount ${fillTokens.toString()} exceeds remaining position tokens ${current.remainingTokensAtomic.toString()}.`
    );
  }

  const fillGross = BigInt(fill.grossProceedsLamports);
  const fillNetworkFee = BigInt(fill.networkFeeLamports);
  const fillPriorityFee = BigInt(fill.priorityFeeLamports);
  const fillTip = BigInt(fill.tipLamports);
  const fillTradingCosts = fillNetworkFee + fillPriorityFee + fillTip;
  const fillNetProceeds = fillGross - fillTradingCosts;
  const fillRent = BigInt(fill.rentMovementLamports);

  const newRemainingTokens = current.remainingTokensAtomic - fillTokens;

  // Prorate entry cost basis based on fraction of tokens sold
  let allocatedCostBasis = 0n;
  if (current.initialTokensAtomic > 0n) {
    allocatedCostBasis = (current.initialPrincipalLamports * fillTokens) / current.initialTokensAtomic;
  }

  // Realized PnL for this fill tranche = Net Proceeds - Allocated Cost Basis
  // RENT IS EXCLUDED from realizedPnL (rent is deposit recovery, NOT trading return)
  const fillRealizedPnl = fillNetProceeds - allocatedCostBasis;

  return {
    tradeId: current.tradeId,
    positionId: current.positionId,
    mint: current.mint,
    initialTokensAtomic: current.initialTokensAtomic,
    remainingTokensAtomic: newRemainingTokens,
    initialPrincipalLamports: current.initialPrincipalLamports,
    entryFeesLamports: current.entryFeesLamports,
    totalGrossProceedsLamports: current.totalGrossProceedsLamports + fillGross,
    totalTradingCostsLamports: current.totalTradingCostsLamports + fillTradingCosts,
    totalRentMovementLamports: current.totalRentMovementLamports + fillRent,
    realizedPnlLamports: current.realizedPnlLamports + fillRealizedPnl,
    fillsCount: current.fillsCount + 1,
    isFullyClosed: newRemainingTokens === 0n
  };
}

/**
 * Converts a PositionAccountingSnapshot into the formal TradeAccounting telemetry interface.
 */
export function toTradeAccounting(
  snapshot: PositionAccountingSnapshot,
  currentExecutableValueLamports: bigint = 0n
): TradeAccounting {
  const netRecoveredLamports = snapshot.totalGrossProceedsLamports - snapshot.totalTradingCostsLamports;
  
  let capitalRecoveredPct = 0;
  if (snapshot.initialPrincipalLamports > 0n) {
    // 4 decimals precision in percentage
    const basisPoints = (netRecoveredLamports * 10000n) / snapshot.initialPrincipalLamports;
    capitalRecoveredPct = Number(basisPoints) / 100;
  }

  const tradeEquityPnLLamports = (netRecoveredLamports + currentExecutableValueLamports) - snapshot.initialPrincipalLamports;

  return {
    tradeId: snapshot.tradeId,
    initialPrincipalLamports: snapshot.initialPrincipalLamports,
    entryFeesLamports: snapshot.entryFeesLamports,
    confirmedGrossProceedsLamports: snapshot.totalGrossProceedsLamports,
    confirmedTradingCostsLamports: snapshot.totalTradingCostsLamports,
    netRecoveredLamports,
    capitalRecoveredPct,
    realizedPnLLamports: snapshot.realizedPnlLamports,
    tradeEquityPnLLamports,
    rentRecoveredLamports: snapshot.totalRentMovementLamports
  };
}
