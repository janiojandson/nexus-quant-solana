export interface ShadowQuoteProof {
  inAmount: number; outAmount: number; requestId?: string;
  rawQuote?: Record<string, unknown>;
}

export interface ShadowLiquidableValue {
  /** Minimum SOL output from the unsigned quote; hypothetical, not wallet cash. */
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
      !taker) throw new Error('SHADOW_QUOTE_PROOF_UNAVAILABLE');
  const charges = [
    ['signatureFeeLamports', 'signatureFeePayer'],
    ['prioritizationFeeLamports', 'prioritizationFeePayer'],
    ['rentFeeLamports', 'rentFeePayer']
  ] as const;
  let networkFeeLamports = 0;
  let rentReserveLamports = 0;
  for (const [amountKey, payerKey] of charges) {
    const amount = raw?.[amountKey];
    const payer = raw?.[payerKey];
    if (!Number.isSafeInteger(amount) || Number(amount) < 0 ||
        (Number(amount) > 0 && (typeof payer !== 'string' || !payer)))
      throw new Error('SHADOW_QUOTE_PROOF_UNAVAILABLE');
    if (payer === taker) {
      if (amountKey === 'rentFeeLamports') rentReserveLamports += Number(amount);
      else networkFeeLamports += Number(amount);
    }
  }
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
