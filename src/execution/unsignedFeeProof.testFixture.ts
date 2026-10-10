import { PublicKey, SystemProgram, TransactionInstruction, TransactionMessage,
  VersionedTransaction } from '@solana/web3.js';
export const TEST_TAKER = 'FBx2SKLDLsdeLM8owxU8MNVPKAfJpLpmpHHRgiZDqBoi';
export const TEST_SPONSOR = '7rhxnLV8C77o6d8oz26AgK8x8m5ePsdeRawjqvojbjnQ';
export const TEST_SOL_MINT = 'So11111111111111111111111111111111111111112';
export const TEST_TOKEN_MINT = new PublicKey(Buffer.alloc(32, 5)).toBase58();

export function unsignedFeeOrder(taker = TEST_TAKER, sponsor?: string) {
  const signer = new PublicKey(taker), payer = new PublicKey(sponsor ?? taker);
  const message = new TransactionMessage({ payerKey: payer,
    recentBlockhash: new PublicKey(Buffer.alloc(32, 10)).toBase58(), instructions: [
      new TransactionInstruction({ programId: SystemProgram.programId,
        keys: [{ pubkey: signer, isSigner: true, isWritable: true }], data: Buffer.alloc(0) })
    ] }).compileToV0Message();
  return Buffer.from(new VersionedTransaction(message).serialize()).toString('base64');
}

export function feeQuoteFixture(minimum: string, inAmount = 1000, outAmount = Number(minimum)) {
  return { inputMint: TEST_TOKEN_MINT, outputMint: TEST_SOL_MINT,
    inAmount: String(inAmount), outAmount: String(outAmount), otherAmountThreshold: minimum,
    taker: TEST_TAKER, transaction: unsignedFeeOrder(TEST_TAKER, TEST_SPONSOR),
    transactionVersion: 0, feeBps: 0, feeMint: TEST_SOL_MINT, gasless: true,
    signatureFeeLamports: 10_000, signatureFeePayer: TEST_SPONSOR,
    prioritizationFeeLamports: 0, prioritizationFeePayer: null,
    rentFeeLamports: 0, rentFeePayer: null };
}
