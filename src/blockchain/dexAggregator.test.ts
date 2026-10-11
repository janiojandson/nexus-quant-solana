import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert';
import axios from 'axios';
import {hubFixture} from './hubTestFixture.js';
let {hub,transport}=hubFixture();
import {beforeEach} from 'node:test';
beforeEach(()=>{({hub,transport}=hubFixture());});
import { DexAggregatorService, JupiterQuoteException } from './dexAggregator.js';

describe('DexAggregatorService - Jupiter', () => {
  const SOL_MINT = 'So11111111111111111111111111111111111111112';
  const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  const originalGet = transport.get;

  afterEach(() => {
    transport.get = originalGet;
  });

  it.skip('freshQuote bypasses a live local cache and exposes quote observation time', async () => {
    let calls=0;
    axios.get=(async()=>({data:{inAmount:'25000000',outAmount:String(++calls*100),priceImpactPct:'0.001',slippageBps:250}})) as any;
    const dex=new DexAggregatorService('https://fake.invalid',{cacheTtlMs:60_000});
    const params={inputMint:SOL_MINT,outputMint:USDC_MINT,amountLamports:25_000_000};
    await dex.getQuote(params);
    const fresh=await dex.getQuote({...params,freshQuote:true});
    assert.equal(calls,2);assert.equal(fresh.outAmount,200);
    assert.ok(Number.isFinite(fresh.observedAtMs));
  });

  it('normaliza priceImpactPct documentado pela Jupiter e aplica piso de slippage', async () => {
    transport.get = (async () => ({
      data: {
        inAmount: '100000000',
        outAmount: '20000000',
        slippageBps: 250, priceImpactPct: '0.0042',
        routePlan: [{ swapInfo: { label: 'Raydium CPMM' } }]
      }
    })) as any;

    const dex = new DexAggregatorService('https://fake.invalid',{hub,cacheTtlMs:0});
    const route = await dex.getQuote({
      inputMint: SOL_MINT,
      outputMint: USDC_MINT,
      amountLamports: 100_000_000,
      slippageBps: 50
    });

    assert.strictEqual(route.slippageBps, 250);
    assert.strictEqual(route.outAmount, 20_000_000);
    assert.strictEqual(route.priceImpactPct, 0.42);
  });

  it('rejeita slippage acima do hard-cap de 750 bps', async () => {
    const dex = new DexAggregatorService('https://fake.invalid',{hub,cacheTtlMs:0});
    await assert.rejects(
      () => dex.getQuote({
        inputMint: SOL_MINT,
        outputMint: USDC_MINT,
        amountLamports: 100_000_000,
        slippageBps: 800
      }),
      /Slippage maximo excedido/
    );
  });

  it('aplica o hard-cap também no autoSlippage', async () => {
    const dex = new DexAggregatorService('https://fake.invalid',{hub,cacheTtlMs:0});
    await assert.rejects(
      () => dex.getQuote({
        inputMint: SOL_MINT,
        outputMint: USDC_MINT,
        amountLamports: 100_000_000,
        autoSlippage: true,
        maxAutoSlippageBps: 1200
      }),
      /Slippage maximo excedido/
    );
  });

  it('falha fechado quando a cotação está indisponível', async () => {
    transport.get = (async () => { throw new Error('ECONNRESET'); }) as any;
    const dex = new DexAggregatorService('https://fake.invalid',{hub,cacheTtlMs:0});

    await assert.rejects(
      () => dex.getQuote({
        inputMint: SOL_MINT,
        outputMint: USDC_MINT,
        amountLamports: 100_000_000
      }),
      (err: any) => err instanceof JupiterQuoteException && /Falha na cotação Jupiter/.test(err.message)
    );
  });

  it('propaga HTTP 429 em vez de inventar cotação', async () => {
    transport.get = (async () => {
      const e: any = new Error('Too Many Requests');
      e.response = { status: 429, data: { error: 'rate limit exceeded' } };
      throw e;
    }) as any;

    const dex = new DexAggregatorService('https://fake.invalid',{hub,cacheTtlMs:0});
    await assert.rejects(
      () => dex.getQuote({
        inputMint: SOL_MINT,
        outputMint: USDC_MINT,
        amountLamports: 100_000_000
      }),
      (err: any) => err instanceof JupiterQuoteException &&
        err.status === 429 &&
        !/secret/.test(err.message)
    );
  });

  it('rejeita resposta sem inAmount/outAmount', async () => {
    transport.get = (async () => ({ data: { routePlan: [] } })) as any;
    const dex = new DexAggregatorService('https://fake.invalid',{hub,cacheTtlMs:0});

    await assert.rejects(
      () => dex.getQuote({
        inputMint: SOL_MINT,
        outputMint: USDC_MINT,
        amountLamports: 100_000_000
      }),
      /Resposta inválida da Jupiter/
    );
  });

  it('preserva outAmount real', async () => {
    transport.get = (async () => ({
      data: { inAmount: '50000000', outAmount: '1234', slippageBps: 250, priceImpactPct: '0.001' }
    })) as any;

    const dex = new DexAggregatorService('https://fake.invalid',{hub,cacheTtlMs:0});
    const route = await dex.getQuote({
      inputMint: SOL_MINT,
      outputMint: USDC_MINT,
      amountLamports: 50_000_000
    });

    assert.strictEqual(route.outAmount, 1234);
    assert.notStrictEqual(route.outAmount, Math.floor(50_000_000 * 1.5));
  });

  it('cache curto evita repetir a mesma chamada', async () => {
    let calls = 0;
    transport.get = (async () => {
      calls++;
      return { data: { inAmount: '100', outAmount: '200', slippageBps: 250, priceImpactPct: '0.001' } };
    }) as any;

    const dex = new DexAggregatorService('https://fake.invalid', {hub,
      rateLimitMs: 0,
      cacheTtlMs: 5000
    });
    const params = { inputMint: SOL_MINT, outputMint: USDC_MINT, amountLamports: 100 };
    await dex.getQuote(params);
    await dex.getQuote(params);
    assert.strictEqual(calls, 1);
  });

  it('envia API key e usa /order V2 sem parâmetros legados', async () => {
    let seenUrl = '';
    let seenConfig: any;
    transport.get = (async (url: string, config: any) => {
      seenUrl = url;
      seenConfig = config;
      return {
        data: {
          inAmount: '100',
          outAmount: '200',
          slippageBps: 250, priceImpactPct: '0.001',
          router: 'metis',
          mode: 'ultra'
        }
      };
    }) as any;

    const dex = new DexAggregatorService('https://fake.invalid', {hub,
      apiKey: 'test-key',
      rateLimitMs: 0,
      cacheTtlMs: 0
    });
    await dex.getQuote({
      inputMint: SOL_MINT,
      outputMint: USDC_MINT,
      amountLamports: 100
    });

    assert.strictEqual(seenUrl, 'https://fake.invalid/order');
    assert.strictEqual(seenConfig.headers['x-api-key'], 'test-key');
    assert.strictEqual(seenConfig.params.instructionVersion, undefined);
    assert.strictEqual(seenConfig.params.amount, '100');
  });
});

it('DexAggregatorService admits hub traffic without obsolete coordinator delay', async () => {
  const originalGet = transport.get;
  const seen: Array<{ priority: number; bucket: string }> = [];
  try {
    transport.get = (async () => ({
      data: { inAmount: '100', outAmount: '200', slippageBps: 250, priceImpactPct: '0.001' }
    })) as any;
    const coordinator: any = {
      async schedule(priority: number, op: () => Promise<unknown>, bucket = 'general') {
        seen.push({ priority, bucket });
        return op();
      }
    };
    const dex = new DexAggregatorService('https://fake.invalid', {hub,
      rateLimitMs: 0,
      cacheTtlMs: 0,
      trafficCoordinator: coordinator
    } as any);

    await dex.getQuote({
      inputMint: 'So11111111111111111111111111111111111111112',
      outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      amountLamports: 100,
      trafficPriority: 3
    } as any);

    assert.deepStrictEqual(seen, []); // The hub owns admission; no obsolete coordinator delay.
  } finally {
    transport.get = originalGet;
  }
});

it('DexAggregatorService returns hub 429 without an independent retry loop', async () => {
  const SOL_MINT = 'So11111111111111111111111111111111111111112';
  const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  const originalGet = transport.get;
  let calls = 0;

  try {
    transport.get = (async () => {
      calls++;
      if (calls === 1) {
        const e: any = new Error('Too Many Requests');
        e.response = { status: 429, headers: {}, data: { error: 'rate limit exceeded' } };
        throw e;
      }
      return { data: { inAmount: '100', outAmount: '200', slippageBps: 250, priceImpactPct: '0.001' } };
    }) as any;

    const dex = new DexAggregatorService('https://fake.invalid', {hub,
      rateLimitMs: 0,
      cacheTtlMs: 0
    });
    await assert.rejects(dex.getQuote({inputMint:SOL_MINT,outputMint:USDC_MINT,amountLamports:100}), (e:any)=>e.status===429);
    assert.strictEqual(calls, 1);
  } finally {
    transport.get = originalGet;
  }
});

describe('bounded RTSE quote replacement',()=>{
 const original=transport.get;
 afterEach(()=>{transport.get=original;});
 it('requests a fresh quote within custom cap when automatic slippage is excessive',async()=>{
  const seen:any[]=[];
  transport.get=(async(_url:string,c:any)=>{seen.push({...c.params});return {data:{inAmount:'1000000',outAmount:seen.length===1?'200':'180',slippageBps:seen.length===1?1000:500}};}) as any;
  const dex=new DexAggregatorService('https://fake.invalid',{hub,rateLimitMs:0,cacheTtlMs:0});
  const result=await dex.getQuote({inputMint:'SOL',outputMint:'TOKEN',amountLamports:1000000,autoSlippage:true,maxAutoSlippageBps:500});
  assert.strictEqual(seen.length,2);assert.strictEqual(seen[1].slippageBps,500);
  assert.strictEqual(result.slippageBps,500);assert.strictEqual(result.outAmount,180);
 });
 it('does not loop or accept an over-cap replacement',async()=>{
  let calls=0;
  transport.get=(async()=>{calls++;return {data:{inAmount:'1000000',outAmount:'200',slippageBps:1000}};}) as any;
  const dex=new DexAggregatorService('https://fake.invalid',{hub,rateLimitMs:0,cacheTtlMs:0});
  await assert.rejects(()=>dex.getQuote({inputMint:'SOL',outputMint:'TOKEN',amountLamports:1000000,autoSlippage:true,maxAutoSlippageBps:750}),/hard-cap/);
  assert.strictEqual(calls,2);
 });
});

describe('V2 quote evidence and cache policy', () => {
  const original = transport.get;
  afterEach(() => { transport.get = original; });
  it('rejects missing slippage instead of assuming zero', async () => {
    transport.get = (async () => ({data:{inAmount:'100',outAmount:'200',priceImpact:0}})) as any;
    const dex = new DexAggregatorService('https://fake.invalid',{hub,rateLimitMs:0,cacheTtlMs:0});
    await assert.rejects(()=>dex.getQuote({inputMint:'SOL',outputMint:'TOKEN',amountLamports:100}),/invalid quote slippage/);
  });
  it('never reuses a cached quote above a later, tighter cap', async () => {
    const seen:any[]=[];
    transport.get=(async (_url:string,c:any)=>{
      seen.push({...c.params});
      return {data:{inAmount:'100',outAmount:'200',slippageBps:c.params.slippageBps ?? 700,priceImpact:0}};
    }) as any;
    const dex=new DexAggregatorService('https://fake.invalid',{hub,rateLimitMs:0,cacheTtlMs:5000});
    const params={inputMint:'SOL',outputMint:'TOKEN',amountLamports:100,autoSlippage:true};
    await dex.getQuote({...params,maxAutoSlippageBps:750});
    const q=await dex.getQuote({...params,maxAutoSlippageBps:300});
    assert.strictEqual(q.slippageBps,300);
    assert.strictEqual(seen.length,3);
    assert.strictEqual(seen[2].slippageBps,300);
  });
  it('falls back from null modern impact to the documented decimal ratio', async () => {
    transport.get=(async()=>({data:{inAmount:'100',outAmount:'200',slippageBps:250,priceImpact:null,priceImpactPct:'0.0042'}})) as any;
    const dex=new DexAggregatorService('https://fake.invalid',{hub,rateLimitMs:0,cacheTtlMs:0});
    assert.strictEqual((await dex.getQuote({inputMint:'SOL',outputMint:'TOKEN',amountLamports:100})).priceImpactPct,0.42);
  });
});
