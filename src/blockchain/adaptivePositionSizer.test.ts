import { describe, it } from 'node:test';
import assert from 'node:assert';
import { AdaptivePositionSizer, LADDER_SOL, MIN_TRADE_AMOUNT_SOL, MAX_TRADE_AMOUNT_SOL } from './adaptivePositionSizer.js';
import { DexAggregatorService, JupiterQuoteException, SwapQuoteResult } from './dexAggregator.js';

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const TOKEN_MINT = '9GtBRgzUybm5GLk7ZGjpG88aVpZcvLuTdbwNkRraTK7H';

class FakeAggregator extends DexAggregatorService {
  public calls: number[] = [];
  constructor(private readonly impactBySol: Record<number, number>) {
    super('https://fake.invalid');
  }

  public async getQuote(params: any): Promise<SwapQuoteResult> {
    const sizeSol = params.amountLamports / 1e9;
    this.calls.push(sizeSol);
    const impact = this.impactBySol[sizeSol];
    if (impact === undefined) {
      throw new JupiterQuoteException(`sem rota para ${sizeSol} SOL`);
    }
    return {
      inputMint: params.inputMint,
      outputMint: params.outputMint,
      inAmount: params.amountLamports,
      outAmount: 1_000_000,
      priceImpactPct: impact,
      slippageBps: 750,
      routePlanSummary: 'Fake'
    };
  }
}

describe('AdaptivePositionSizer - dimensionamento por profundidade de pool', () => {
  const baseParams = {
    inputMint: SOL_MINT,
    outputMint: TOKEN_MINT,
    autoSlippage: true,
    maxAutoSlippageBps: 750
  };

  it('deve manter o lote maximo quando o Price Impact ja e aceitavel', async () => {
    const agg = new FakeAggregator({ 0.05: 0.8, 0.035: 0.5, 0.02: 0.3, 0.015: 0.2 });
    const sizer = new AdaptivePositionSizer(agg);

    const res = await sizer.findExecutableSize(baseParams);

    assert.strictEqual(res.success, true);
    assert.strictEqual(res.sizeSol, MAX_TRADE_AMOUNT_SOL);
    assert.deepStrictEqual(agg.calls, [0.05], 'nao deve cotar lotes menores se o maior serve');
  });

  it('deve reduzir o lote quando o Price Impact excede a tolerancia', async () => {
    // Pool rasa: 0.05 e 0.035 estouram, 0.02 passa.
    const agg = new FakeAggregator({ 0.05: 8.5, 0.035: 4.2, 0.02: 1.9, 0.015: 1.1 });
    const sizer = new AdaptivePositionSizer(agg);

    const res = await sizer.findExecutableSize(baseParams);

    assert.strictEqual(res.success, true);
    assert.strictEqual(res.sizeSol, 0.02);
    assert.deepStrictEqual(agg.calls, [0.05, 0.035, 0.02]);
    assert.strictEqual(res.attempts.length, 3);
    assert.strictEqual(res.attempts[0].accepted, false);
    assert.strictEqual(res.attempts[2].accepted, true);
  });

  it('deve escalar ate o lote minimo antes de desistir', async () => {
    const agg = new FakeAggregator({ 0.05: 9, 0.035: 7, 0.02: 4, 0.015: 2.4 });
    const sizer = new AdaptivePositionSizer(agg);

    const res = await sizer.findExecutableSize(baseParams);

    assert.strictEqual(res.success, true);
    assert.strictEqual(res.sizeSol, MIN_TRADE_AMOUNT_SOL);
    assert.deepStrictEqual(agg.calls, [0.05, 0.035, 0.02, 0.015]);
  });

  it('deve abortar com INSUFFICIENT_POOL_DEPTH quando nem o lote minimo passa', async () => {
    const agg = new FakeAggregator({ 0.05: 12, 0.035: 9, 0.02: 6, 0.015: 3.4 });
    const sizer = new AdaptivePositionSizer(agg);

    const res = await sizer.findExecutableSize(baseParams);

    assert.strictEqual(res.success, false);
    assert.strictEqual(res.sizeSol, 0);
    assert.strictEqual(res.abortReason, 'INSUFFICIENT_POOL_DEPTH');
    assert.match(res.error || '', /INSUFFICIENT_POOL_DEPTH/);
    assert.strictEqual(res.attempts.length, LADDER_SOL.length);
    assert.ok(res.attempts.every((a) => a.accepted === false));
  });

  it('deve abortar com QUOTE_UNAVAILABLE (fail-closed) quando a cotação falha', async () => {
    const agg = new FakeAggregator({});
    const sizer = new AdaptivePositionSizer(agg);

    const res = await sizer.findExecutableSize(baseParams);

    assert.strictEqual(res.success, false);
    assert.strictEqual(res.abortReason, 'QUOTE_UNAVAILABLE');
    assert.strictEqual(res.quote, null);
  });

  it('deve usar a validacao de simulacao para rejeitar lote com erro 6014', async () => {
    // Impacte parece bom, mas a simulacao pre-voo rejeita 0.05 e 0.035 com 6014.
    const agg = new FakeAggregator({ 0.05: 1.0, 0.035: 0.9, 0.02: 0.8, 0.015: 0.7 });
    const sizer = new AdaptivePositionSizer(agg);

    const res = await sizer.findExecutableSize(baseParams, {
      validate: async (_quote, sizeSol) =>
        sizeSol > 0.02 ? 'Simulação pré-voo rejeitada: {"InstructionError":[6,{"Custom":6014}]}' : null
    });

    assert.strictEqual(res.success, true);
    assert.strictEqual(res.sizeSol, 0.02);
    assert.deepStrictEqual(agg.calls, [0.05, 0.035, 0.02]);
  });

  it('deve abortar quando TODOS os lotes falham na simulacao (6014 em todos)', async () => {
    const agg = new FakeAggregator({ 0.05: 1.0, 0.035: 0.9, 0.02: 0.8, 0.015: 0.7 });
    const sizer = new AdaptivePositionSizer(agg);

    const res = await sizer.findExecutableSize(baseParams, {
      validate: async () => '{"InstructionError":[6,{"Custom":6014}]}'
    });

    assert.strictEqual(res.success, false);
    // Todos os degraus passaram no impacto e falharam na simulacao on-chain:
    // a causa e SIMULATION_REJECTED, nao profundidade insuficiente.
    assert.strictEqual(res.abortReason, 'SIMULATION_REJECTED');
  });
});

it('AdaptivePositionSizer: modo econômico respeita escada de no máximo duas tentativas', async () => {
  const agg = new FakeAggregator({ 0.02: 4.0, 0.015: 1.5 });
  const sizer = new AdaptivePositionSizer(agg);

  const res = await sizer.findExecutableSize({
    inputMint: SOL_MINT,
    outputMint: TOKEN_MINT,
    autoSlippage: true,
    maxAutoSlippageBps: 750
  }, {
    ladderSol: [0.02, 0.015]
  });

  assert.strictEqual(res.success, true);
  assert.strictEqual(res.sizeSol, 0.015);
  assert.deepStrictEqual(agg.calls, [0.02, 0.015]);
  assert.strictEqual(res.attempts.length, 2);
});

it('order policy rejection is not mislabeled as liquidity or RPC simulation',async()=>{
 const agg=new FakeAggregator({0.05:1,0.035:1});
 const result=await new AdaptivePositionSizer(agg).findExecutableSize({inputMint:SOL_MINT,outputMint:TOKEN_MINT,autoSlippage:true,maxAutoSlippageBps:750},{
 validate:async()=> 'Jupiter V2 RTSE excedeu hard-cap: 1000bps > 750bps.'
 });
 assert.strictEqual(result.abortReason,'ORDER_POLICY_REJECTED');
 assert.strictEqual(result.attempts.length,1);
 assert.strictEqual(result.attempts[0].rejectedBy,'ORDER_POLICY');
 assert.ok(!result.error?.includes('6014'));
});
