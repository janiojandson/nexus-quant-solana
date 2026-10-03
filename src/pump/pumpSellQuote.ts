export interface PumpSellQuoteInput {
  tokenAmountAtomic: bigint;
  virtualTokenReserves: bigint;
  virtualSolReserves: bigint;
  totalFeeBps: number;
  slippageBps: number;
}

export interface PumpSellQuote {
  grossSolLamports: bigint;
  feeLamports: bigint;
  netSolLamports: bigint;
  minSolOutputLamports: bigint;
  totalFeeBps: number;
  slippageBps: number;
}

export const PUMP_DIRECT_SELL_MAX_SLIPPAGE_BPS = 750;

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

export function quotePumpBondingCurveSell(input: PumpSellQuoteInput): PumpSellQuote {
  if (input.tokenAmountAtomic <= 0n) {
    throw new Error('Pump sell token amount must be greater than zero.');
  }
  if (input.virtualTokenReserves <= 0n || input.virtualSolReserves <= 0n) {
    throw new Error('Pump sell reserves must be positive.');
  }
  if (
    !Number.isFinite(input.totalFeeBps) ||
    input.totalFeeBps < 0 ||
    input.totalFeeBps >= 10_000
  ) {
    throw new Error('Pump sell fee bps is invalid.');
  }
  if (
    !Number.isInteger(input.slippageBps) ||
    input.slippageBps < 0 ||
    input.slippageBps > PUMP_DIRECT_SELL_MAX_SLIPPAGE_BPS
  ) {
    throw new Error(
      `Pump sell slippage must be between 0 and ${PUMP_DIRECT_SELL_MAX_SLIPPAGE_BPS} bps.`
    );
  }

  const grossSolLamports =
    (input.tokenAmountAtomic * input.virtualSolReserves) /
    (input.virtualTokenReserves + input.tokenAmountAtomic);

  if (grossSolLamports <= 0n) {
    throw new Error('Pump sell gross output is zero.');
  }

  // Pump fee components are ceiling-rounded on-chain; model total bps
  // conservatively with the same rounding direction.
  const feeNumerator =
    grossSolLamports * BigInt(Math.round(input.totalFeeBps * 100));
  const feeLamports = ceilDiv(feeNumerator, 1_000_000n);
  const netSolLamports = grossSolLamports > feeLamports
    ? grossSolLamports - feeLamports
    : 0n;

  if (netSolLamports <= 0n) {
    throw new Error('Pump sell net output is zero after fees.');
  }

  const minSolOutputLamports =
    (netSolLamports * BigInt(10_000 - input.slippageBps)) / 10_000n;

  if (minSolOutputLamports <= 0n) {
    throw new Error('Pump sell min output is zero.');
  }

  return {
    grossSolLamports,
    feeLamports,
    netSolLamports,
    minSolOutputLamports,
    totalFeeBps: input.totalFeeBps,
    slippageBps: input.slippageBps
  };
}
