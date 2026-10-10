import type { DurableExitFill, DurableFillResult } from '../database/positionLedger.js';
import { shadowLiquidableValue } from './shadowQuoteValue.js';

interface Quote { inAmount: number; outAmount: number; requestId?: string; priceImpactPct: number;
  rawQuote?: Record<string, unknown> }
interface ShadowPosition { mint: string; traceId: string; tokenAmount: number;
  initialCapitalSol?: number; highestTpStepReached?: number; executablePeakSolValue?: number;
  observablePeakSolValue?: number; lastJupiterExecutableSolValue?: number;
  lastHealthyExitRouteAt?: number }
export interface ShadowExitInput {
  position: ShadowPosition; exitTokenAmount: number; monitorQuote: Quote;
  taker: string;
  quoteAt: number; now(): number; getQuote(): Promise<Quote>;
  persist(fill: DurableExitFill): Promise<DurableFillResult>;
  apply(result: DurableFillResult): void;
}
export type ShadowExitOutcome =
  | { kind: 'HOLD'; reason: string }
  | { kind: 'COMMITTED'; fill: DurableFillResult };

/** A quote is hypothetical evidence; no swap, wallet delta or rent recovery occurs. */
export async function commitShadowExitFromQuote(input: ShadowExitInput): Promise<ShadowExitOutcome> {
  const { position, exitTokenAmount } = input;
  if (!position.traceId || !Number.isSafeInteger(exitTokenAmount) || exitTokenAmount <= 0 ||
      exitTokenAmount > position.tokenAmount)
    return { kind: 'HOLD', reason: 'INVALID_SHADOW_EXIT' };
  const reusable = input.monitorQuote.inAmount === exitTokenAmount &&
    input.now() - input.quoteAt >= 0 && input.now() - input.quoteAt <= 1000;
  let quote: Quote;
  try { quote = reusable ? input.monitorQuote : await input.getQuote(); }
  catch { return { kind: 'HOLD', reason: 'PARTIAL_QUOTE_UNAVAILABLE' }; }
  if (quote.inAmount !== exitTokenAmount || !Number.isSafeInteger(quote.outAmount) || quote.outAmount <= 0)
    return { kind: 'HOLD', reason: 'STALE_OR_INVALID_EXIT_QUOTE' };
  let liquidable: ReturnType<typeof shadowLiquidableValue>;
  let monitorNetLamports: number;
  try {
    liquidable = shadowLiquidableValue(quote, exitTokenAmount, input.taker);
    monitorNetLamports = shadowLiquidableValue(input.monitorQuote, position.tokenAmount,
      input.taker).netLamports;
  } catch (error) {
    return { kind: 'HOLD', reason: error instanceof Error &&
      error.message.startsWith('SHADOW_QUOTE_') ? error.message : 'SHADOW_QUOTE_PROOF_UNAVAILABLE' };
  }
  const isFull = exitTokenAmount === position.tokenAmount;
  const nextStep = isFull ? (position.highestTpStepReached ?? 0) :
    Math.min(2, (position.highestTpStepReached ?? 0) + 1);
  if (!isFull && nextStep === 1 &&
      (!Number.isFinite(position.initialCapitalSol) || (position.initialCapitalSol ?? 0) <= 0 ||
       liquidable.netLamports < Math.ceil(position.initialCapitalSol! * 1e9)))
    return { kind: 'HOLD', reason: 'TP1_NOMINAL_RECOVERY_UNPROVEN' };
  const ratio = (position.tokenAmount - exitTokenAmount) / position.tokenAmount;
  const result = await input.persist({ accountingMode: 'SHADOW', traceId: position.traceId,
    fillId: quote.requestId || `${position.traceId}:${input.quoteAt}:${exitTokenAmount}`,
    tokenAmount: exitTokenAmount, grossProceedsSol: liquidable.grossLamports / 1e9,
    feeSol: liquidable.feeLamports / 1e9, rentRecoveredSol: 0, nextStep, isFull,
    quoteEvidence: {
      expectedOutLamports: liquidable.expectedOutLamports,
      minimumOutLamports: liquidable.minimumOutLamports,
      bpsHaircutLamports: liquidable.bpsHaircutLamports,
      networkFeeLamports: liquidable.networkFeeLamports,
      rentReserveLamports: liquidable.rentReserveLamports,
      conservativeNetLamports: liquidable.conservativeNetLamports
    },
    executablePeakSolValue: position.executablePeakSolValue == null ? undefined :
      position.executablePeakSolValue * ratio,
    observablePeakSolValue: position.observablePeakSolValue == null ? undefined :
      position.observablePeakSolValue * ratio,
    lastJupiterExecutableSolValue: isFull ? undefined : monitorNetLamports / 1e9 * ratio,
    lastHealthyExitRouteAt: input.now() });
  input.apply(result);
  return { kind: 'COMMITTED', fill: result };
}
