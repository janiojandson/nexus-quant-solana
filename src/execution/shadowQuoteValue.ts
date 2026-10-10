import { publicTakerFeeEstimate } from './publicTakerFeeProof.js';

export interface ShadowQuoteProof {
  inAmount: number; outAmount: number; requestId?: string;
  rawQuote?: Record<string, unknown>;
}

export interface ShadowLiquidableValue {
  /** Legacy ledger name: quoted minimum includes route/platform costs. It is
   * not the authoritative before-cost spot mark for the initial stop. */
  grossLamports: number;
  /** Conservative haircut plus taker-paid network/rent reserve; not an actual tx fee. */
  feeLamports: number;
  netLamports: number;
  expectedOutLamports: number;
  minimumOutLamports: number;
  bpsHaircutLamports: number;
  networkFeeLamports: number;
  rentReserveLamports: number;
  conservativeNetLamports: number;
}

/** Fail closed unless the quote proves an exact-size conservative SOL lower bound. */
export function shadowLiquidableValue(
  quote: ShadowQuoteProof, expectedInputAtomic: number, taker: string
): ShadowLiquidableValue {
  if (quote.inAmount !== expectedInputAtomic || !Number.isSafeInteger(expectedInputAtomic) ||
      expectedInputAtomic <= 0) throw new Error('SHADOW_QUOTE_SIZE_MISMATCH');
  const raw = quote.rawQuote;
  const minRaw = raw?.otherAmountThreshold;
  const minOut = typeof minRaw === 'string' && /^\d+$/.test(minRaw) ? Number(minRaw) : NaN;
  const feeBps = raw?.feeBps;
  if (!Number.isSafeInteger(quote.outAmount) || quote.outAmount <= 0 ||
      !Number.isSafeInteger(minOut) || minOut <= 0 || minOut > quote.outAmount ||
      !Number.isInteger(feeBps) || Number(feeBps) < 0 || Number(feeBps) > 10_000 ||
      raw?.inAmount !== String(expectedInputAtomic) || raw?.outAmount !== String(quote.outAmount) ||
      typeof raw?.inputMint !== 'string' || !raw.inputMint ||
      (Number(feeBps) > 0 && (typeof raw?.feeMint !== 'string' ||
        (raw.feeMint !== raw.inputMint && raw.feeMint !== raw.outputMint))) ||
      raw?.outputMint !== 'So11111111111111111111111111111111111111112' ||
      !taker) throw new Error('SHADOW_QUOTE_PROOF_UNAVAILABLE');
  const fees = publicTakerFeeEstimate(raw, taker);
  if (!fees) throw new Error('SHADOW_QUOTE_PROOF_UNAVAILABLE');
  const networkFeeLamports = fees.network;
  const rentReserveLamports = fees.rent;
  const haircut = Math.ceil(minOut * Number(feeBps) / 10_000);
  const feeLamports = haircut + networkFeeLamports + rentReserveLamports;
  const netLamports = minOut - feeLamports;
  if (!Number.isSafeInteger(feeLamports) || netLamports <= 0)
    throw new Error('SHADOW_QUOTE_NET_NONPOSITIVE');
  return { grossLamports: minOut, feeLamports, netLamports,
    expectedOutLamports: quote.outAmount, minimumOutLamports: minOut,
    bpsHaircutLamports: haircut, networkFeeLamports, rentReserveLamports,
    conservativeNetLamports: netLamports };
}
