import type { DurableExitFill, DurableFillResult } from '../database/positionLedger.js';

interface Quote { inAmount: number; outAmount: number; requestId?: string; priceImpactPct: number }
interface ShadowPosition { mint: string; traceId: string; tokenAmount: number;
  highestTpStepReached?: number; executablePeakSolValue?: number;
  observablePeakSolValue?: number; lastJupiterExecutableSolValue?: number;
  lastHealthyExitRouteAt?: number }
export interface ShadowExitInput {
  position: ShadowPosition; exitTokenAmount: number; monitorQuote: Quote;
  quoteAt: number; now(): number; getQuote(): Promise<Quote>;
  persist(fill: DurableExitFill): Promise<DurableFillResult>;
  apply(result: DurableFillResult): void;
}

/** A quote is hypothetical evidence; no swap, wallet delta or rent recovery occurs. */
export async function commitShadowExitFromQuote(input: ShadowExitInput): Promise<DurableFillResult> {
  const { position, exitTokenAmount } = input;
  if (!position.traceId || !Number.isSafeInteger(exitTokenAmount) || exitTokenAmount <= 0 ||
      exitTokenAmount > position.tokenAmount) throw new Error('INVALID_SHADOW_EXIT');
  const reusable = input.monitorQuote.inAmount === exitTokenAmount &&
    input.now() - input.quoteAt >= 0 && input.now() - input.quoteAt <= 1000;
  const quote = reusable ? input.monitorQuote : await input.getQuote();
  if (quote.inAmount !== exitTokenAmount || !Number.isSafeInteger(quote.outAmount) || quote.outAmount <= 0)
    throw new Error('STALE_OR_INVALID_EXIT_QUOTE');
  const isFull = exitTokenAmount === position.tokenAmount;
  const nextStep = isFull ? (position.highestTpStepReached ?? 0) :
    Math.min(2, (position.highestTpStepReached ?? 0) + 1);
  const ratio = (position.tokenAmount - exitTokenAmount) / position.tokenAmount;
  const result = await input.persist({ accountingMode: 'SHADOW', traceId: position.traceId,
    fillId: quote.requestId || `${position.traceId}:${input.quoteAt}:${exitTokenAmount}`,
    tokenAmount: exitTokenAmount, grossProceedsSol: quote.outAmount / 1e9,
    feeSol: 0, rentRecoveredSol: 0, nextStep, isFull,
    executablePeakSolValue: position.executablePeakSolValue == null ? undefined :
      position.executablePeakSolValue * ratio,
    observablePeakSolValue: position.observablePeakSolValue == null ? undefined :
      position.observablePeakSolValue * ratio,
    lastJupiterExecutableSolValue: isFull ? undefined : input.monitorQuote.outAmount / 1e9 * ratio,
    lastHealthyExitRouteAt: input.now() });
  input.apply(result);
  return result;
}
