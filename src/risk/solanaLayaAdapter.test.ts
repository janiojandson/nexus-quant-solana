import test from 'node:test';
import assert from 'node:assert';
import { SolanaLayaAdapter } from './solanaLayaAdapter.js';

const FACTS = {
  mint: 'MintNative111111111111111111111111111111111',
  liquidityUsd: 45_000,
  holdersCount: 640,
  mintAuthorityRevoked: true,
  freezeAuthorityRevoked: true,
  rugCheckScore: 95,
  lpLockedPct: 100,
  topHoldersPct: 12,
  priceChangeM5: 8.5,
  buysM5: 50,
  sellsM5: 20,
  volumeBuysM5: 25_000,
  volumeSellsM5: 9_000,
  priceUsd: 0.001,
  h1HighPriceUsd: 0.00108
};

test('SolanaLayaAdapter usa contrato nativo e Authorization Bearer', async () => {
  let seenUrl = '';
  let seenPayload: any;
  let seenHeaders: any;
  const httpClient = {
    post: async (url: string, payload: any, config: any) => {
      seenUrl = url;
      seenPayload = payload;
      seenHeaders = config.headers;
      return {
        data: {
          answers: {
            route: { choice: 'MECHANICAL_PIPELINE', answer_confidence: 0.93 },
            residual_risk: { score: 0.7, answer_confidence: 0.82 },
            needs_llm: { noul: 0.18, answer_confidence: 0.82 }
          },
          routing: { model: 'multilingual' }
        }
      };
    }
  } as any;

  const adapter = new SolanaLayaAdapter({
    baseUrl: 'http://nexus-decisor-laya.railway.internal:8000/',
    apiKey: 'secret-test',
    httpClient
  });
  const result = await adapter.evaluate(FACTS);

  assert.strictEqual(seenUrl, 'http://nexus-decisor-laya.railway.internal:8000/v1/systemone');
  assert.strictEqual(seenHeaders.Authorization, 'Bearer secret-test');
  assert.strictEqual(seenPayload.state.domain, 'solana_memecoin');
  assert.match(seenPayload.state.body, /filtros determinísticos obrigatórios/);
  assert.match(seenPayload.state.body, /não autoriza compra, venda, sizing ou execução financeira/);
  assert.strictEqual(seenPayload.state.contractVersion, 'solana-laya/v1');
  assert.strictEqual(seenPayload.state.deterministicGatesPassed, true);
  assert.strictEqual(seenPayload.questions.route.type, 'choice');
  assert.strictEqual(seenPayload.questions.residual_risk.type, 'score');
  assert.strictEqual(seenPayload.questions.needs_llm.type, 'noul');
  assert.match(seenPayload.questions.route.criteria.MECHANICAL_PIPELINE, /regras determinísticas/);
  assert.strictEqual(result.route, 'MECHANICAL_PIPELINE');
  assert.strictEqual(result.routeConfidence, 0.93);
  assert.strictEqual(result.routingModel, 'multilingual');
});

test('SolanaLayaAdapter falha fechado se route ou confiança forem inválidas', async () => {
  const invalidAction = new SolanaLayaAdapter({
    apiKey: 'k',
    httpClient: { post: async () => ({ data: {
      answers: { route: { choice: 'BUY', answer_confidence: 0.99 } }
    } }) } as any
  });
  await assert.rejects(() => invalidAction.evaluate(FACTS), /route inválida/);

  const invalidConfidence = new SolanaLayaAdapter({
    apiKey: 'k',
    httpClient: { post: async () => ({ data: {
      answers: { route: { choice: 'ABSTAIN', answer_confidence: 7 } }
    } }) } as any
  });
  await assert.rejects(
    () => invalidConfidence.evaluate(FACTS),
    /answer_confidence inválida/
  );
});

test('SolanaLayaAdapter exige credencial', async () => {
  const adapter = new SolanaLayaAdapter({
    apiKey: '',
    httpClient: { post: async () => { throw new Error('não deveria chamar'); } } as any
  });
  const old = process.env.LAYA_API_KEY;
  delete process.env.LAYA_API_KEY;
  try {
    await assert.rejects(() => adapter.evaluate(FACTS), /LAYA_API_KEY ausente/);
  } finally {
    if (old !== undefined) process.env.LAYA_API_KEY = old;
  }
});
