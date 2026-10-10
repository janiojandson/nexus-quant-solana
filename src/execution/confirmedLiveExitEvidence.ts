export interface ConfirmedWalletExitDelta {
  signature: string;
  deltaAtomic: string;
  /** Wallet SOL change including transaction fee, at confirmed commitment. */
  walletLamportDelta: number;
  feeLamports: number;
  blockTimeMs: number;
}

export function validateConfirmedLiveExitEvidence(
  evidence: ConfirmedWalletExitDelta | null,
  confirmedSignature: string,
  requestedSoldAtomic: number
): { fillId: string; soldAtomic: number; receivedLamports: number; feeLamports: number } {
  if (!evidence) throw new Error('CONFIRMED_WALLET_DELTA_MISSING');
  if (!confirmedSignature || evidence.signature !== confirmedSignature)
    throw new Error('SIGNATURE_MISMATCH');
  if (!Number.isSafeInteger(requestedSoldAtomic) || requestedSoldAtomic <= 0 ||
      evidence.deltaAtomic !== `-${requestedSoldAtomic}`)
    throw new Error('TOKEN_DELTA_MISMATCH');
  if (!Number.isSafeInteger(evidence.walletLamportDelta) || evidence.walletLamportDelta <= 0)
    throw new Error('NET_SOL_DELTA_INVALID');
  if (!Number.isSafeInteger(evidence.feeLamports) || evidence.feeLamports < 0)
    throw new Error('TX_FEE_INVALID');
  return { fillId: evidence.signature, soldAtomic: requestedSoldAtomic,
    receivedLamports: evidence.walletLamportDelta, feeLamports: evidence.feeLamports };
}
