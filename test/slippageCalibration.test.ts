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
    // Valores exigidos: $15k -> $25, $50k -> $50, $200k -> $100
    assert.strictEqual(computeCollisionUsd(15_000), 25);
    assert.strictEqual(computeCollisionUsd(50_000), 50);
    assert.strictEqual(computeCollisionUsd(200_000), 100);
  });

  it('deve saturar nos limites sem estourar', () => {
    assert.strictEqual(computeCollisionUsd(1), MIN_COLLISION_USD);
    assert.strictEqual(computeCollisionUsd(7_500), MIN_COLLISION_USD);
    assert.strictEqual(computeCollisionUsd(10_000_000), MAX_COLLISION_USD);
  });

  it('deve ser monotonico crescente na faixa de interesse (15k-200k)', () => {
    const samples = [15_000, 20_000, 30_000, 50_000, 75_000, 100_000, 150_000, 200_000];
    for (let i = 1; i < samples.length; i++) {
      const prev = computeCollisionUsd(samples[i - 1]);
      const cur = computeCollisionUsd(samples[i]);
      assert.ok(cur >= prev, `deve crescer: ${samples[i - 1]} -> ${samples[i]} (${prev} -> ${cur})`);
    }
  });

  it('deve ser Nao-degenêrico: $50k e $200k nao podem dar o mesmo valor', () => {
    // A formula de 0,5% com teto em 100 colapsava这两 para 100.
    assert.notStrictEqual(computeCollisionUsd(50_000), computeCollisionUsd(200_000));
  });

  it('deve cair no fallback seguro sem liquidez valida', () => {
    for (const bad of [undefined, null, 0, -1, NaN, Infinity]) {
      assert.strictEqual(computeCollisionUsd(bad as any), FALLBACK_COLLISION_USD,
        `liquidez ${String(bad)} deveria usar o fallback`);
    }
  });

  it('deve ser sempre inteiro (a Jupiter exige inteiro)', () => {
    for (const liq of [15_000, 33_333, 50_001, 99_999]) {
      const v = computeCollisionUsd(liq);
      assert.ok(Number.isInteger(v), `esperado inteiro, veio ${v}`);
    }
  });

  it('deve manter o teto anti-MEV rigido em 750 bps', () => {
    assert.strictEqual(HARD_CAP_SLIPPAGE_BPS, 750);
    assert.strictEqual(DexAggregatorService.MAX_ALLOWED_SLIPPAGE_BPS, 750);
  });

  it('describeSlippageParams deve expor tamanho, colisao, liq e teto', () => {
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

describe('DexAggregatorService envia a colisao dinamica a Jupiter', () => {
  const origGet = axios.get;
  let sent: any = null;
  const logs: string[] = [];
  const origLog = console.log;

  beforeEach(() => {
    sent = null;
    logs.length = 0;
    console.log = (...a: any[]) => { logs.push(a.join(' ')); };
    axios.get = (async (_u: string, cfg: any) => {
      sent = cfg.params;
      return { data: { inAmount: '20000000', outAmount: '12345', priceImpactPct: '0.2' } };
    }) as any;
  });

  afterEach(() => {
    axios.get = origGet;
    console.log = origLog;
  });

  it('deve usar $25 para pool de $15k', async () => {
    const dex = new DexAggregatorService();
    await dex.getQuote({
      inputMint: SOL_MINT, outputMint: TOKEN_MINT, amountLamports: 15_000_000,
      autoSlippage: true, poolLiquidityUsd: 15_000, maxAutoSlippageBps: 750
    });
    assert.strictEqual(sent.autoSlippageCollisionUsdValue, 25);
    assert.strictEqual(sent.maxAutoSlippageBps, 750);
  });

  it('deve usar $50 para pool de $50k', async () => {
    const dex = new DexAggregatorService();
    await dex.getQuote({
      inputMint: SOL_MINT, outputMint: TOKEN_MINT, amountLamports: 15_000_000,
      autoSlippage: true, poolLiquidityUsd: 50_000, maxAutoSlippageBps: 750
    });
    assert.strictEqual(sent.autoSlippageCollisionUsdValue, 50);
  });

  it('deve usar $100 para pool de $200k', async () => {
    const dex = new DexAggregatorService();
    await dex.getQuote({
      inputMint: SOL_MINT, outputMint: TOKEN_MINT, amountLamports: 15_000_000,
      autoSlippage: true, poolLiquidityUsd: 200_000, maxAutoSlippageBps: 750
    });
    assert.strictEqual(sent.autoSlippageCollisionUsdValue, 100);
  });

  it('deve usar o fallback de $50 sem liquidez informada', async () => {
    const dex = new DexAggregatorService();
    await dex.getQuote({
      inputMint: SOL_MINT, outputMint: TOKEN_MINT, amountLamports: 15_000_000,
      autoSlippage: true, maxAutoSlippageBps: 750
    });
    assert.strictEqual(sent.autoSlippageCollisionUsdValue, FALLBACK_COLLISION_USD);
  });

  it('deve respeitar colisao explicita quando fornecida', async () => {
    const dex = new DexAggregatorService();
    await dex.getQuote({
      inputMint: SOL_MINT, outputMint: TOKEN_MINT, amountLamports: 15_000_000,
      autoSlippage: true, autoSlippageCollisionUsdValue: 77, poolLiquidityUsd: 15_000,
      maxAutoSlippageBps: 750
    });
    assert.strictEqual(sent.autoSlippageCollisionUsdValue, 77);
  });

  it('deve registrar a telemetria do quote', async () => {
    const dex = new DexAggregatorService();
    await dex.getQuote({
      inputMint: SOL_MINT, outputMint: TOKEN_MINT, amountLamports: 20_000_000,
      autoSlippage: true, poolLiquidityUsd: 50_000, maxAutoSlippageBps: 750
    });
    const out = logs.join('\n');
    assert.match(out, /\[JupiterQuote\]/);
    assert.match(out, /0\.02 SOL/);
    assert.match(out, /\$50/);
    assert.match(out, /750 bps/);
  });

  it('NUNCA deve enviar colisao acima do teto de 100', async () => {
    const dex = new DexAggregatorService();
    await dex.getQuote({
      inputMint: SOL_MINT, outputMint: TOKEN_MINT, amountLamports: 15_000_000,
      autoSlippage: true, poolLiquidityUsd: 999_999_999, maxAutoSlippageBps: 750
    });
    assert.strictEqual(sent.autoSlippageCollisionUsdValue, MAX_COLLISION_USD);
  });

  it('NUNCA deve usar a colisao fixa de 1000 em pool rasa', async () => {
    // Regressao do bug original: 1000 USD em pool de 15k gerava 6014 falso.
    const dex = new DexAggregatorService();
    await dex.getQuote({
      inputMint: SOL_MINT, outputMint: TOKEN_MINT, amountLamports: 15_000_000,
      autoSlippage: true, poolLiquidityUsd: 15_000, maxAutoSlippageBps: 750
    });
    assert.notStrictEqual(sent.autoSlippageCollisionUsdValue, 1000);
    assert.ok(sent.autoSlippageCollisionUsdValue <= 100);
  });
});
