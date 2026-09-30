import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import axios from 'axios';
import { DexAggregatorService, JupiterQuoteException } from './dexAggregator.js';

describe('DexAggregatorService - Roteamento Jupiter v6 & Pump.fun', () => {
  const SOL_MINT = 'So11111111111111111111111111111111111111112';
  const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

  const originalGet = axios.get;
  afterEach(() => {
    axios.get = originalGet;
  });

  it('deve gerar rota de swap com slippage protegido', async () => {
    axios.get = (async () => ({
      data: {
        inAmount: '100000000',
        outAmount: '20000000',
        priceImpactPct: '0.42',
        routePlan: [{ swapInfo: { label: 'Raydium CPMM' } }]
      }
    })) as any;

    const dex = new DexAggregatorService();
    const route = await dex.getQuote({
      inputMint: SOL_MINT,
      outputMint: USDC_MINT,
      amountLamports: 100_000_000,
      slippageBps: 50
    });

    assert.strictEqual(route.inputMint, SOL_MINT);
    assert.strictEqual(route.outputMint, USDC_MINT);
    assert.strictEqual(route.slippageBps, 50);
    assert.strictEqual(route.outAmount, 20_000_000);
    assert.strictEqual(route.priceImpactPct, 0.42);
  });

  it('deve rejeitar swaps com slippage abusivo (> 750 bps / 7.5%) para evitar sandwich attack', async () => {
    const dex = new DexAggregatorService();
    await assert.rejects(
      async () => {
        await dex.getQuote({
          inputMint: SOL_MINT,
          outputMint: USDC_MINT,
          amountLamports: 100_000_000,
          slippageBps: 800
        });
      },
      /Slippage maximo excedido/
    );
  });

  it('deve aplicar o teto anti-MEV tambem no caminho autoSlippage (compras)', async () => {
    const dex = new DexAggregatorService();
    await assert.rejects(
      async () => {
        await dex.getQuote({
          inputMint: SOL_MINT,
          outputMint: USDC_MINT,
          amountLamports: 100_000_000,
          autoSlippage: true,
          maxAutoSlippageBps: 1200
        });
      },
      /Slippage maximo excedido/
    );
  });

  // ==========================================================================
  // POLÍTICA FAIL-CLOSED — o fallback silencioso (outAmount = 1.5x) foi removido
  // ==========================================================================

  it('deve lançar JupiterQuoteException em falha de rede, SEM inventar outAmount', async () => {
    axios.get = (async () => {
      throw new Error('ECONNRESET');
    }) as any;

    const dex = new DexAggregatorService();
    await assert.rejects(
      async () => dex.getQuote({
        inputMint: SOL_MINT,
        outputMint: USDC_MINT,
        amountLamports: 100_000_000
      }),
      (err: any) => {
        assert.ok(err instanceof JupiterQuoteException, 'deve ser JupiterQuoteException');
        assert.match(err.message, /Falha na cotação Jupiter/);
        return true;
      }
    );
  });

  it('deve abortar com rate-limit (HTTP 429) em vez de devolver cotação', async () => {
    axios.get = (async () => {
      const e: any = new Error('Too Many Requests');
      e.response = { status: 429, data: { error: 'rate limit exceeded' } };
      throw e;
    }) as any;

    const dex = new DexAggregatorService();
    await assert.rejects(
      async () => dex.getQuote({
        inputMint: SOL_MINT,
        outputMint: USDC_MINT,
        amountLamports: 100_000_000
      }),
      (err: any) => {
        assert.ok(err instanceof JupiterQuoteException);
        assert.strictEqual(err.status, 429);
        assert.match(err.message, /rate limit exceeded/);
        return true;
      }
    );
  });

  it('deve abortar quando a resposta vier sem inAmount/outAmount', async () => {
    axios.get = (async () => ({ data: { routePlan: [] } })) as any;

    const dex = new DexAggregatorService();
    await assert.rejects(
      async () => dex.getQuote({
        inputMint: SOL_MINT,
        outputMint: USDC_MINT,
        amountLamports: 100_000_000
      }),
      /Resposta inválida da Jupiter/
    );
  });

  it('deve preservar o outAmount real (nunca 1.5x) em sucesso', async () => {
    axios.get = (async () => ({
      data: { inAmount: '50000000', outAmount: '1234', priceImpactPct: '0.1' }
    })) as any;

    const dex = new DexAggregatorService();
    const route = await dex.getQuote({
      inputMint: SOL_MINT,
      outputMint: USDC_MINT,
      amountLamports: 50_000_000
    });

    assert.strictEqual(route.outAmount, 1234);
    assert.notStrictEqual(route.outAmount, Math.floor(50_000_000 * 1.5));
    assert.notStrictEqual(route.routePlanSummary, 'Jupiter-Simulated');
  });
});
