import { describe, it } from 'node:test';
import assert from 'node:assert';
import { DexAggregatorService } from './dexAggregator.js';

describe('DexAggregatorService - Roteamento Jupiter v6 & Pump.fun', () => {
  const SOL_MINT = 'So11111111111111111111111111111111111111112';
  const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

  it('deve gerar rota de swap simulada com slippage protegido', async () => {
    const dex = new DexAggregatorService();
    const route = await dex.getQuote({
      inputMint: SOL_MINT,
      outputMint: USDC_MINT,
      amountLamports: 100_000_000, // 0.1 SOL
      slippageBps: 50 // 0.5%
    });

    assert.ok(route);
    assert.strictEqual(route.inputMint, SOL_MINT);
    assert.strictEqual(route.outputMint, USDC_MINT);
    assert.strictEqual(route.slippageBps, 50);
    assert.ok(route.outAmount > 0);
  });

  it('deve rejeitar swaps com slippage abusivo (> 750 bps / 7.5%) para evitar sandwich attack', async () => {
    const dex = new DexAggregatorService();
    await assert.rejects(
      async () => {
        await dex.getQuote({
          inputMint: SOL_MINT,
          outputMint: USDC_MINT,
          amountLamports: 100_000_000,
          slippageBps: 800 // 8% -> Risco MEV excessivo (> 750 bps)
        });
      },
      /Slippage maximo excedido/
    );
  });
});
