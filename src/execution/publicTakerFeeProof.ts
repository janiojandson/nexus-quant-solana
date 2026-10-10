import { VersionedTransaction } from '@solana/web3.js';

export interface PublicTakerFeeEstimate {
  network: number; rent: number; feePayer: string;
  provenance: 'CONSTRUCTED_PUBLIC_TAKER_ORDER_ESTIMATE';
}

/** Read-only order context, not funding/landing proof. Gasless provider sponsor
 * signatures may exist; the requested taker must remain unsigned. No signing,
 * execution, transmission or relaxation of the ENTRY CPI boundary occurs here. */
export function publicTakerFeeEstimate(raw: Record<string, unknown> | undefined,
  taker: string): PublicTakerFeeEstimate | null {
  if (!raw || raw.taker !== taker || typeof raw.transaction !== 'string' || !raw.transaction ||
      (raw.transactionVersion !== undefined && raw.transactionVersion !== 0)) return null;
  try {
    const tx = VersionedTransaction.deserialize(Buffer.from(raw.transaction, 'base64'));
    const count = tx.message.header.numRequiredSignatures;
    const signers = tx.message.staticAccountKeys.slice(0, count).map(key => key.toBase58());
    const takerIndex = signers.indexOf(taker);
    const feePayer = signers[0];
    if (tx.version !== 0 || !feePayer || takerIndex < 0 || tx.signatures.length !== count ||
        tx.signatures[takerIndex].some(byte => byte !== 0)) return null;
    const fields = [['signatureFeeLamports', 'signatureFeePayer'],
      ['prioritizationFeeLamports', 'prioritizationFeePayer'],
      ['rentFeeLamports', 'rentFeePayer']] as const;
    let network = 0, rent = 0;
    for (const [amountKey, payerKey] of fields) {
      const amount = raw[amountKey], payer = raw[payerKey];
      if (!Number.isSafeInteger(amount) || Number(amount) < 0 ||
          (amountKey === 'signatureFeeLamports' && Number(amount) <= 0) ||
          (payer !== null && (typeof payer !== 'string' || !signers.includes(payer))) ||
          (Number(amount) > 0 && (payer === null ||
            (amountKey !== 'rentFeeLamports' && payer !== feePayer) ||
            (amountKey === 'rentFeeLamports' && payer !== taker && payer !== feePayer)))) return null;
      if (payer === taker) {
        if (amountKey === 'rentFeeLamports') rent += Number(amount);
        else network += Number(amount);
      }
    }
    if (!Number.isSafeInteger(network + rent)) return null;
    return { network, rent, feePayer, provenance: 'CONSTRUCTED_PUBLIC_TAKER_ORDER_ESTIMATE' };
  } catch { return null; }
}
