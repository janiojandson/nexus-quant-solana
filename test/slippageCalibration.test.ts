import { describe, it, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert';
import axios from 'axios';
import {
  computeCollisionUsd,
  describeSlippageParams,
  MIN_COLLISION_USD,
  MAX_COLLISION_USD,
  FALLBACK_COLLISION_USD,
  HARD_CAP_SLIPPAGE_BPS
} from '../src/blockchain/slippageCalibration.js';
import { DexAggregatorService } from '../src/blockchain/dexAggregator.js';

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const TOKEN_MINT = '9GtBRgzUybm5GLk7ZGjpG88aVpZcvLuTdbwNkRraTK7H';

describe('Calibracao de autoSlippageCollisionUsdValue', () => {
  it('deve produzir os tres casos de referencia do operador', () => {
    assert.strictEqual(computeCollisionUsd(15_000), 25);
    assert.strictEqual(computeCollisionUsd(50_000), 50);
    assert.strictEqual(computeCollisionUsd(200_000), 100);
  });

  it('deve saturar nos limites sem estourar', () => {
    assert.strictEqual(computeCollisionUsd(1), MIN_COLLISION_USD);
    assert.strictEqual(computeCollisionUsd(7_500), MIN_COLLISION_USD);
    assert.strictEqual(computeCollisionUsd(10_000_000), MAX_COLLISION_USD);
  });
  it('deve ser monotonico crescente na faixa de interesse', () => {
    const samples = [15_000, 20_000, 30_000, 50_000, 75_000, 100_000, 150_000, 200_000];
    for (let i = 1; i < samples.length; i++) {
      const prev = computeCollisionUsd(samples[i - 1]);
      const cur = computeCollisionUsd(samples[i]);
      assert.ok(cur >= prev);
    }
  });

  it('deve ser nao-degenerico entre $50k e $200k', () => {
    assert.notStrictEqual(computeCollisionUsd(50_000), computeCollisionUsd(200_000));
  });

  it('deve cair no fallback seguro sem liquidez valida', () => {
    for (const bad of [undefined, null, 0, -1, NaN, Infinity]) {
      assert.strictEqual(computeCollisionUsd(bad as any), FALLBACK_COLLISION_USD);
    }
  });

  it('deve ser sempre inteiro', () => {
    for (const liq of [15_000, 33_333, 50_001, 99_999]) {
      assert.ok(Number.isInteger(computeCollisionUsd(liq)));
    }
  });

  it('deve manter o teto anti-MEV rigido em 750 bps', () => {
    assert.strictEqual(HARD_CAP_SLIPPAGE_BPS, 750);
    assert.strictEqual(DexAggregatorService.MAX_ALLOWED_SLIPPAGE_BPS, 750);
  });
  it('describeSlippageParams preserva telemetria de colisao', () => {
    const s = describeSlippageParams({
      sizeSol: 0.02,
      collisionUsd: 50,
      poolLiquidityUsd: 50_000,
      maxAutoSlippageBps: 750
    });
    assert.match(s, /0\.02 SOL/);
    assert.match(s, /\$50/);
    assert.match(s, /50,000/);
    assert.match(s, /750 bps/);
  });
});

describe('DexAggregatorService V2 delega autoSlippage ao RTSE', () => {
  const origGet = axios.get;
  let sent: any = null;
  let sentUrl = '';
  const logs: string[] = [];
  const origLog = console.log;

  beforeEach(() => {
    sent = null;
    sentUrl = '';
    logs.length = 0;
    console.log = (...a: any[]) => { logs.push(a.join(' ')); };
    axios.get = (async (url: string, cfg: any) => {
      sentUrl = url;
      sent = cfg.params;
      return {
        data: {
          inAmount: '20000000',
          outAmount: '12345',
          priceImpactPct: '0.002',
          slippageBps: 42,
          router: 'metis',
          mode: 'ultra'
        }
      };
    }) as any;
  });
  afterEach(() => {
    axios.get = origGet;
    console.log = origLog;
  });

  it('autoSlippage V2 não envia parâmetros legados de colisão', async () => {
    const dex = new DexAggregatorService('https://fake.invalid', {
      rateLimitMs: 0,
      cacheTtlMs: 0
    });
    await dex.getQuote({
      inputMint: SOL_MINT,
      outputMint: TOKEN_MINT,
      amountLamports: 15_000_000,
      autoSlippage: true,
      poolLiquidityUsd: 15_000,
      maxAutoSlippageBps: 750
    });

    assert.strictEqual(sentUrl, 'https://fake.invalid/order');
    assert.strictEqual(sent.slippageBps, undefined);
    assert.strictEqual(sent.autoSlippageCollisionUsdValue, undefined);
    assert.strictEqual(sent.maxAutoSlippageBps, undefined);
    assert.match(logs.join('\n'), /V2 RTSE/);
    assert.match(logs.join('\n'), /\$25/);
  });

  it('telemetria de colisão continua variando conforme liquidez', async () => {
    const dex = new DexAggregatorService('https://fake.invalid', {
      rateLimitMs: 0,
      cacheTtlMs: 0
    });
    await dex.getQuote({
      inputMint: SOL_MINT,
      outputMint: TOKEN_MINT,
      amountLamports: 20_000_000,
      autoSlippage: true,
      poolLiquidityUsd: 200_000,
      maxAutoSlippageBps: 750
    });

    const out = logs.join('\n');
    assert.match(out, /\$100/);
    assert.match(out, /V2 RTSE/);
  });

  it('saída com slippage explícito envia 500bps', async () => {
    const dex = new DexAggregatorService('https://fake.invalid', {
      rateLimitMs: 0,
      cacheTtlMs: 0
    });
    const quote = await dex.getQuote({
      inputMint: TOKEN_MINT,
      outputMint: SOL_MINT,
      amountLamports: 1_000_000,
      autoSlippage: false,
      slippageBps: 500
    });

    assert.strictEqual(sent.slippageBps, 500);
    assert.strictEqual(quote.slippageBps, 42);
  });

  it('maxAutoSlippage acima de 750 falha antes do HTTP', async () => {
    let calls = 0;
    axios.get = (async () => {
      calls++;
      return { data: {} };
    }) as any;
    const dex = new DexAggregatorService('https://fake.invalid', {
      rateLimitMs: 0,
      cacheTtlMs: 0
    });

    await assert.rejects(
      () => dex.getQuote({
        inputMint: SOL_MINT,
        outputMint: TOKEN_MINT,
        amountLamports: 1_000_000,
        autoSlippage: true,
        maxAutoSlippageBps: 800
      }),
      /Slippage maximo excedido/
    );
    assert.strictEqual(calls, 0);
  });

  it('RTSE retornado acima de 750 falha fechado', async () => {
    axios.get = (async () => ({
      data: {
        inAmount: '1000000',
        outAmount: '500000',
        slippageBps: 800,
        router: 'metis',
        mode: 'ultra'
      }
    })) as any;

    const dex = new DexAggregatorService('https://fake.invalid', {
      rateLimitMs: 0,
      cacheTtlMs: 0
    });

    await assert.rejects(
      () => dex.getQuote({
        inputMint: SOL_MINT,
        outputMint: TOKEN_MINT,
        amountLamports: 1_000_000,
        autoSlippage: true,
        maxAutoSlippageBps: 750
      }),
      /RTSE Jupiter V2 excedeu hard-cap/
    );
  });
});
