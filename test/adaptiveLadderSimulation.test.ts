import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { AdaptivePositionSizer, LADDER_SOL } from '../src/blockchain/adaptivePositionSizer.js';
import { DexAggregatorService, SwapQuoteResult } from '../src/blockchain/dexAggregator.js';

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const TOKEN_MINT = '9GtBRgzUybm5GLk7ZGjpG88aVpZcvLuTdbwNkRraTK7H';
const E6014 = 'Simulação pré-voo rejeitada: {"InstructionError":[8,{"Custom":6014}]}';

/** Cotação com impacto configurável por degrau. */
class ScriptedAggregator extends DexAggregatorService {
  public calls: number[] = [];
  constructor(private readonly impactBySol: Record<number, number>) {
    super('https://fake.invalid');
  }
  public async getQuote(params: any): Promise<SwapQuoteResult> {
    const sizeSol = params.amountLamports / 1e9;
    this.calls.push(sizeSol);
    const impact = this.impactBySol[sizeSol];
    if (impact === undefined) throw new Error(`sem impacto definido para ${sizeSol}`);
    return {
      inputMint: params.inputMint,
      outputMint: params.outputMint,
      inAmount: params.amountLamports,
      outAmount: 5_402_359,
      priceImpactPct: impact,
      slippageBps: 750,
      routePlanSummary: 'Fake'
    };
  }
}

/** Todos os degraus baratos: isola a falha na simulação. */
const allCheap: Record<number, number> = { 0.05: 0.031, 0.035: 0.031, 0.02: 0.031, 0.015: 0.031 };

const baseParams = {
  inputMint: SOL_MINT,
  outputMint: TOKEN_MINT,
  autoSlippage: true,
  maxAutoSlippageBps: 750
};

describe('Escada adaptativa sob erro 6014 (SlippageExceeded)', () => {
  const logs: string[] = [];
  const origWarn = console.warn;
  const origLog = console.log;

  beforeEach(() => {
    logs.length = 0;
    console.warn = (...a: any[]) => { logs.push(a.join(' ')); };
    console.log = (...a: any[]) => { logs.push(a.join(' ')); };
  });

  afterEach(() => {
    console.warn = origWarn;
    console.log = origLog;
  });

  // -------------------------------------------------------------------
  // Cenário 1 — Escalonamento com sucesso no meio da escada
  // -------------------------------------------------------------------

  it('Cenário 1: aprova no degrau 0.02 após 6014 em 0.05 e 0.035', async () => {
    const agg = new ScriptedAggregator(allCheap);
    const sizer = new AdaptivePositionSizer(agg);

    const simCalls: number[] = [];
    const res = await sizer.findExecutableSize(baseParams, {
      validate: async (_q, sizeSol) => {
        simCalls.push(sizeSol);
        return sizeSol > 0.02 ? E6014 : null;
      }
    });

    assert.strictEqual(res.success, true, 'não deve abortar');
    assert.strictEqual(res.sizeSol, 0.02, 'lote autorizado deve ser exatamente 0.02 SOL');
    assert.deepStrictEqual(simCalls, [0.05, 0.035, 0.02], 'deve tentar 3 degraus e parar no 0.02');

    assert.strictEqual(res.attempts.length, 3);
    assert.strictEqual(res.attempts[0].rejectedBy, 'SIMULATION');
    assert.strictEqual(res.attempts[1].rejectedBy, 'SIMULATION');
    assert.strictEqual(res.attempts[2].accepted, true);
    assert.strictEqual(res.attempts[2].rejectedBy, undefined);

    for (const a of res.attempts) {
      assert.ok(a.priceImpactPct <= 2.5, 'impacto deve estar dentro da tolerância');
      assert.notStrictEqual(a.rejectedBy, 'PRICE_IMPACT');
    }
  });

  it('Cenário 1: deve registrar a sequência de degraus e a aprovação nos logs', async () => {
    const sizer = new AdaptivePositionSizer(new ScriptedAggregator(allCheap));
    await sizer.findExecutableSize(baseParams, {
      validate: async (_q, sizeSol) => (sizeSol > 0.02 ? E6014 : null)
    });

    const out = logs.join('\n');
    assert.match(out, /Degrau 0\.05 SOL: SIMULA(Ç|A)[ÃA]O REPROVADA/);
    assert.match(out, /Degrau 0\.035 SOL: SIMULA(Ç|A)[ÃA]O REPROVADA/);
    assert.match(out, /Degrau 0\.02 SOL: APROVADO/);
    assert.match(out, /6014/);
  });

  it('Cenário 1: contrato do hook — null aprova, string rejeita', async () => {
    const r1 = await new AdaptivePositionSizer(new ScriptedAggregator(allCheap))
      .findExecutableSize(baseParams, { validate: async () => null });
    assert.strictEqual(r1.success, true);
    assert.strictEqual(r1.sizeSol, 0.05);

    const r2 = await new AdaptivePositionSizer(new ScriptedAggregator(allCheap))
      .findExecutableSize(baseParams, { validate: async () => 'falhou' });
    assert.strictEqual(r2.success, false);
  });

  // -------------------------------------------------------------------
  // Cenário 2 — Esgotamento da escada (pool ilíquida)
  // -------------------------------------------------------------------

  it('Cenário 2: aborta com SIMULATION_REJECTED quando 6014 reprova toda a escada', async () => {
    const agg = new ScriptedAggregator(allCheap);
    const sizer = new AdaptivePositionSizer(agg);

    const res = await sizer.findExecutableSize(baseParams, { validate: async () => E6014 });

    assert.strictEqual(res.success, false);
    assert.strictEqual(res.sizeSol, 0);
    assert.strictEqual(res.quote, null);
    assert.strictEqual(res.abortReason, 'SIMULATION_REJECTED');
    assert.strictEqual(res.attempts.length, LADDER_SOL.length);
    assert.ok(res.attempts.every(a => a.rejectedBy === 'SIMULATION'));
    assert.deepStrictEqual(agg.calls, LADDER_SOL, 'deve tentar todos os degraus');
  });

  it('Cenário 2: a mensagem de erro NÃO deve culpar o Price Impact', async () => {
    const sizer = new AdaptivePositionSizer(new ScriptedAggregator(allCheap));
    const res = await sizer.findExecutableSize(baseParams, { validate: async () => E6014 });

    const msg = res.error || '';
    assert.match(msg, /SIMULATION_REJECTED/);
    assert.match(msg, /6014/);
    assert.doesNotMatch(msg, /profundidade insuficiente|SlippageExceeded/i);
    // A mensagem antiga era enganosa: dizia que o Price Impact não atingiu o teto
    assert.doesNotMatch(msg, /nenhum lote.*atingiu Price Impact/i);
  });

  it('Cenário 2: aborta com INSUFFICIENT_POOL_DEPTH quando a falha é só de impacto', async () => {
    const agg = new ScriptedAggregator({ 0.05: 9.9, 0.035: 8, 0.02: 6, 0.015: 4 });
    const sizer = new AdaptivePositionSizer(agg);
    const res = await sizer.findExecutableSize(baseParams, { validate: async () => null });

    assert.strictEqual(res.success, false);
    assert.strictEqual(res.abortReason, 'INSUFFICIENT_POOL_DEPTH');
    assert.match(res.error || '', /INSUFFICIENT_POOL_DEPTH/);
    assert.ok(res.attempts.every(a => a.rejectedBy === 'PRICE_IMPACT'));
  });

  it('Cenário 2: mistura de causas — impacto barra 0.05, 6014 barra os demais', async () => {
    const agg = new ScriptedAggregator({ 0.05: 9.9, 0.035: 0.5, 0.02: 0.4, 0.015: 0.3 });
    const sizer = new AdaptivePositionSizer(agg);
    const res = await sizer.findExecutableSize(baseParams, { validate: async () => E6014 });

    assert.strictEqual(res.success, false);
    assert.strictEqual(res.attempts.some(a => a.rejectedBy === 'PRICE_IMPACT'), true,
      '0.05 deve ter sido barrado por impacto');
    assert.strictEqual(res.attempts.filter(a => a.rejectedBy === 'SIMULATION').length, 3,
      'os 3 degraus que passaram no impacto devem ter chegado à simulação');
    assert.strictEqual(res.abortReason, 'SIMULATION_REJECTED');
    assert.ok(res.attempts.every(a => a.rejectedBy !== undefined));
  });

  it('Cenário 2: nenhum lote é transmission quando a escada esgota', async () => {
    // O sizer só COTA e SIMULA. A transmissão é do executeSwap, chamado
    // apenas com sizing.success === true.
    const res = await new AdaptivePositionSizer(new ScriptedAggregator(allCheap))
      .findExecutableSize(baseParams, { validate: async () => E6014 });
    assert.strictEqual(res.success, false);
    assert.strictEqual(res.sizeSol, 0);
    assert.strictEqual(res.quote, null);
  });
});
