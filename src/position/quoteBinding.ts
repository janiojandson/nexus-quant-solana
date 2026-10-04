/**
 * Nexus Quant Solana — V2.3A Bound Execution Quote
 *
 * Quotes are explicitly bound to a Position ID and Position Version at acquisition time.
 * Prevents execution of stale quotes constructed against outdated custody balances.
 */

import { PositionVersion } from '../types/telemetry.js';
import { PositionSnapshot } from './types.js';

export type QuoteSource = 'JUPITER' | 'PUMP_DIRECT' | 'MANUAL';

export interface BoundExecutionQuote {
  readonly positionId: string;
  readonly positionVersion: PositionVersion;
  readonly requestedAmountAtomic: bigint;
  readonly quoteReceivedAtWallMs: number;
  readonly quoteReceivedAtMonoNs: bigint;
  readonly quoteSource: QuoteSource;
  readonly requestId?: string | null;
  readonly inAmountAtomic: bigint;
  readonly outAmountLamports: bigint;
  readonly slippageBps: number;
  readonly rawQuote?: any;
}

export interface BindExecutionQuoteInput {
  snapshot: PositionSnapshot;
  requestedAmountAtomic: bigint;
  quoteSource: QuoteSource;
  outAmountLamports: bigint;
  slippageBps: number;
  requestId?: string | null;
  rawQuote?: any;
}

export function bindExecutionQuote(input: BindExecutionQuoteInput): BoundExecutionQuote {
  return Object.freeze({
    positionId: input.snapshot.positionId,
    positionVersion: input.snapshot.positionVersion,
    requestedAmountAtomic: input.requestedAmountAtomic,
    quoteReceivedAtWallMs: Date.now(),
    quoteReceivedAtMonoNs: process.hrtime.bigint(),
    quoteSource: input.quoteSource,
    requestId: input.requestId ?? null,
    inAmountAtomic: input.requestedAmountAtomic,
    outAmountLamports: input.outAmountLamports,
    slippageBps: input.slippageBps,
    rawQuote: input.rawQuote
  });
}
