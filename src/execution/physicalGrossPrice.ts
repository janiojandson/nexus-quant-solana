import { PUMP_SWAP_PROGRAM, RAYDIUM_CPMM_PROGRAM,
  type ConfirmedPoolEvidence } from '../pump/confirmedPoolReader.js';

const SOL_MINT = 'So11111111111111111111111111111111111111112';
export interface PhysicalGrossSpotMark {
  source: 'PHYSICAL_POOL_SPOT_BEFORE_EXECUTION_COSTS';
  mint: string; poolAddress: string; slot: number; observedAt: string;
  tokenAmountAtomic: string; numeratorLamports: bigint; denominator: bigint;
}

/** Inventory at the coherent physical pool spot price. This is deliberately
 * before price impact/slippage/platform/route/network costs, not executable
 * proceeds. Never reverse feeBps or extrapolate a quoted AMM execution. */
export function physicalGrossSpotMark(pool: ConfirmedPoolEvidence | null | undefined,
  mint: string, entryPoolAddress: string | undefined, tokenAmount: number,
  nowMs: number): PhysicalGrossSpotMark | null {
  if (!pool || pool.kind !== 'PHYSICAL_POOL_CONFIRMED' || !entryPoolAddress ||
      pool.poolAddress !== entryPoolAddress || !Number.isSafeInteger(pool.slot) || pool.slot <= 0 ||
      !Number.isSafeInteger(tokenAmount) || tokenAmount <= 0 ||
      !((pool.baseMint === mint && pool.quoteMint === SOL_MINT) ||
        (pool.quoteMint === mint && pool.baseMint === SOL_MINT)) ||
      !((pool.venue === 'PumpSwap' && pool.programId === PUMP_SWAP_PROGRAM.toBase58()) ||
        (pool.venue === 'Raydium CPMM' && pool.programId === RAYDIUM_CPMM_PROGRAM.toBase58())) ||
      !/^[0-9]{1,20}$/.test(pool.physicalSolLamports) ||
      !/^[0-9]{1,20}$/.test(pool.tokenReserveAtomic)) return null;
  const observed = Date.parse(pool.observedAt);
  if (!Number.isFinite(nowMs) || !Number.isFinite(observed) ||
      observed > nowMs + 1000 || nowMs - observed > 15_000) return null;
  const sol = BigInt(pool.physicalSolLamports), tokens = BigInt(pool.tokenReserveAtomic);
  if (sol <= 0n || tokens <= 0n || sol > 18_446_744_073_709_551_615n ||
      tokens > 18_446_744_073_709_551_615n) return null;
  return { source: 'PHYSICAL_POOL_SPOT_BEFORE_EXECUTION_COSTS', mint,
    poolAddress: pool.poolAddress, slot: pool.slot, observedAt: pool.observedAt,
    tokenAmountAtomic: String(tokenAmount), numeratorLamports: BigInt(tokenAmount) * sol,
    denominator: tokens };
}
