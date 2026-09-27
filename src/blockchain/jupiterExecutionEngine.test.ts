import test from 'node:test';
import assert from 'node:assert';
import { JupiterExecutionEngine, SwapExecutionRequest } from './jupiterExecutionEngine.js';

test('JupiterExecutionEngine: modo DRY_RUN deve simular swap sem assinar na rede real', async () => {
  const engine = new JupiterExecutionEngine({
    isDryRun: true
  });

  const request: SwapExecutionRequest = {
    inputMint: 'So11111111111111111111111111111111111111112', // SOL
    outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
    amountLamports: 10000000, // 0.01 SOL
    userPublicKey: 'FBx2SKLDLsdeLM8owxU8MNVPKAfJpLpmpHHRgiZDqBoi'
  };

  const result = await engine.executeSwap(request);

  assert.strictEqual(result.status, 'DRY_RUN_SUCCESS');
  assert.ok(result.txSignature.startsWith('dry_run_tx_'));
  assert.strictEqual(result.isDryRun, true);
  assert.ok(result.outAmount > 0);
});
