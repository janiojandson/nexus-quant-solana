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
            route: { choice: 'MECHANICAL_PIPELINE', answer_confidence: 0.93, abstention: 'passed' }
          },
          routing: { model: 'multilingual' }
        }
      };
    }
  } as any;

  const adapter = new SolanaLayaAdapter({
    baseUrl: 'https://laya.example/',
    apiKey: 'secret-test',
    httpClient
  });
  const result = await adapter.evaluate(FACTS);

  assert.strictEqual(seenUrl, 'https://laya.example/v1/systemone');
  assert.strictEqual(seenHeaders.Authorization, 'Bearer secret-test');
  assert.strictEqual(seenPayload.state.domain, 'solana_memecoin');
  assert.match(seenPayload.state.body, /filtros determinísticos obrigatórios/);
  assert.match(seenPayload.state.body, /Regras de segurança e execução continuam fora da Laya/);
  assert.strictEqual(seenPayload.state.contractVersion, 'solana-laya/v1');
  assert.strictEqual(seenPayload.state.hardSafetyGatesRemainAuthoritative, true);
  assert.strictEqual(seenPayload.questions.route.type, 'choice');
  assert.deepStrictEqual(Object.keys(seenPayload.questions), ['route']);
  assert.strictEqual(seenPayload.min_confidence, 0.85);
  assert.match(seenPayload.questions.route.criteria.MECHANICAL_PIPELINE, /regras determinísticas/);
  assert.strictEqual(result.route, 'MECHANICAL_PIPELINE');
  assert.strictEqual(result.routeConfidence, 0.93);
  assert.strictEqual(result.routingModel, 'multilingual');
});

test('SolanaLayaAdapter falha fechado se route ou confiança forem inválidas', async () => {
  const invalidAction = new SolanaLayaAdapter({
    baseUrl: 'https://laya.example',
    apiKey: 'k',
    httpClient: { post: async () => ({ data: {
      answers: { route: { choice: 'BUY', answer_confidence: 0.99 } }
    } }) } as any
  });
  await assert.rejects(() => invalidAction.evaluate(FACTS), /ação inválida em PRE_ENTRY_TRIAGE/);

  const invalidConfidence = new SolanaLayaAdapter({
    baseUrl: 'https://laya.example',
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

test('SolanaLayaAdapter exige SOLANA_LAYA_API_KEY e ignora LAYA_API_KEY genérica', async () => {
  const oldSolana = process.env.SOLANA_LAYA_API_KEY;
  const oldGeneric = process.env.LAYA_API_KEY;
  try {
    delete process.env.SOLANA_LAYA_API_KEY;
    process.env.LAYA_API_KEY = 'legacy-key';

    const adapter = new SolanaLayaAdapter({
      baseUrl: 'https://laya.example',
      httpClient: { post: async () => { throw new Error('não deveria chamar'); } } as any
    });

    await assert.rejects(() => adapter.evaluate(FACTS), /SOLANA_LAYA_API_KEY ausente/);
  } finally {
    if (oldSolana === undefined) delete process.env.SOLANA_LAYA_API_KEY;
    else process.env.SOLANA_LAYA_API_KEY = oldSolana;
    if (oldGeneric === undefined) delete process.env.LAYA_API_KEY;
    else process.env.LAYA_API_KEY = oldGeneric;
  }
});

test('SolanaLayaAdapter decide entrada BUY/WAIT/ABSTAIN pelo contrato original', async () => {
  let seenPayload: any;
  const adapter = new SolanaLayaAdapter({
    baseUrl: 'https://laya.example',
    apiKey: 'k',
    httpClient: {
      post: async (_url: string, payload: any) => {
        seenPayload = payload;
        return {
          data: {
            answers: {
              action: { choice: 'BUY', answer_confidence: 0.91, abstention: 'passed' }
            },
            routing: { model: 'multilingual' }
          }
        };
      }
    } as any
  });

  const result = await adapter.evaluateEntry(FACTS);
  assert.strictEqual(seenPayload.state.stage, 'ENTRY_DECISION');
  assert.strictEqual(seenPayload.state.contractVersion, 'solana-laya-entry/v1');
  assert.deepStrictEqual(Object.keys(seenPayload.questions), ['action']);
  assert.deepStrictEqual(Object.keys(seenPayload.questions.action.criteria), ['BUY', 'WAIT', 'ABSTAIN']);
  assert.strictEqual(seenPayload.min_confidence, 0.85);
  assert.strictEqual(result.action, 'BUY');
  assert.strictEqual(result.confidence, 0.91);
});

test('SolanaLayaAdapter força ABSTAIN quando a Laya sinaliza baixa confiança em posição aberta', async () => {
  const adapter = new SolanaLayaAdapter({
    baseUrl: 'https://laya.example',
    apiKey: 'k',
    httpClient: {
      post: async () => ({
        data: {
          answers: {
            action: {
              choice: 'EXIT',
              answer_confidence: 0.42,
              abstention: 'abstained',
              low_confidence: true
            }
          },
          routing: { model: 'multilingual' }
        }
      })
    } as any
  });

  const result = await adapter.evaluatePosition({
    mint: FACTS.mint,
    symbol: 'TEST',
    pnlPct: 0.04,
    peakPnlPct: 0.09,
    holdingSeconds: 120,
    partialTaken: false,
    currentPriceUsd: 0.00104,
    entryPriceUsd: 0.001,
    lastKnownLiquidityUsd: 45_000,
    lastKnownVolume5mUsd: 12_000,
    trailingActive: true,
    stopLossPct: -0.06
  });

  assert.strictEqual(result.action, 'ABSTAIN');
  assert.strictEqual(result.lowConfidence, true);
});
