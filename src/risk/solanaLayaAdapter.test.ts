import test from 'node:test';
import assert from 'node:assert';
import { SolanaLayaAdapter, normalizeSolanaLayaTacticalMode, shouldBlockSolanaEntryFromLaya } from './solanaLayaAdapter.js';

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

test('SolanaLayaAdapter exige credencial para endpoint público', async () => {
  const oldAuth = process.env.SOLANA_LAYA_AUTH_TOKEN;
  const oldSolana = process.env.SOLANA_LAYA_API_KEY;
  const oldGeneric = process.env.LAYA_API_KEY;
  try {
    delete process.env.SOLANA_LAYA_AUTH_TOKEN;
    delete process.env.SOLANA_LAYA_API_KEY;
    process.env.LAYA_API_KEY = 'legacy-key';

    const adapter = new SolanaLayaAdapter({
      baseUrl: 'https://laya.example',
      httpClient: { post: async () => { throw new Error('não deveria chamar'); } } as any
    });

    await assert.rejects(() => adapter.evaluate(FACTS), /Credencial Laya ausente/);
  } finally {
    if (oldAuth === undefined) delete process.env.SOLANA_LAYA_AUTH_TOKEN;
    else process.env.SOLANA_LAYA_AUTH_TOKEN = oldAuth;
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
  assert.deepStrictEqual(Object.keys(seenPayload.questions), ['action', 'score']);
  assert.deepStrictEqual(Object.keys(seenPayload.questions.action.criteria), ['BUY', 'WAIT', 'ABSTAIN', 'REJECT', 'VETO']);
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

test('SolanaLayaAdapter usa proxy privado sem bearer do cliente', async () => {
  const oldAuth = process.env.SOLANA_LAYA_AUTH_TOKEN;
  const oldCompat = process.env.SOLANA_LAYA_API_KEY;
  try {
    delete process.env.SOLANA_LAYA_AUTH_TOKEN;
    delete process.env.SOLANA_LAYA_API_KEY;
    let seenHeaders: any = null;
    const adapter = new SolanaLayaAdapter({
      baseUrl: 'http://nexus-decisor-laya.railway.internal:8001',
      httpClient: { post: async (_url: string, _payload: any, config: any) => {
        seenHeaders = config.headers;
        return { data: { answers: { route: {
          choice: 'MECHANICAL_PIPELINE', answer_confidence: 0.91, abstention: 'passed'
        } } } };
      } } as any
    });
    const result = await adapter.evaluate(FACTS);
    assert.strictEqual(seenHeaders?.Authorization, undefined);
    assert.strictEqual(result.route, 'MECHANICAL_PIPELINE');
  } finally {
    if (oldAuth === undefined) delete process.env.SOLANA_LAYA_AUTH_TOKEN;
    else process.env.SOLANA_LAYA_AUTH_TOKEN = oldAuth;
    if (oldCompat === undefined) delete process.env.SOLANA_LAYA_API_KEY;
    else process.env.SOLANA_LAYA_API_KEY = oldCompat;
  }
});

test('política Laya Solana suporta LIVE Gatekeeper com corte de score < 75 e ações de veto', () => {
  // Em modo SHADOW, não bloqueia
  assert.strictEqual(shouldBlockSolanaEntryFromLaya({ action: 'BUY', score: 60 }, 'SHADOW').blocked, false);
  assert.strictEqual(shouldBlockSolanaEntryFromLaya({ action: 'REJECT', score: 90 }, 'SHADOW').blocked, false);

  // Em modo LIVE, bloqueia se score < 75 ou ação não for BUY
  assert.strictEqual(shouldBlockSolanaEntryFromLaya({ action: 'BUY', score: 85 }, 'LIVE').blocked, false);
  assert.strictEqual(shouldBlockSolanaEntryFromLaya({ action: 'BUY', score: 70 }, 'LIVE').blocked, true);
  assert.match(shouldBlockSolanaEntryFromLaya({ action: 'BUY', score: 70 }, 'LIVE').reason!, /Score 70 < 75/);

  assert.strictEqual(shouldBlockSolanaEntryFromLaya({ action: 'REJECT', score: 90 }, 'LIVE').blocked, true);
  assert.strictEqual(shouldBlockSolanaEntryFromLaya({ action: 'VETO', score: 90 }, 'LIVE').blocked, true);
  assert.strictEqual(shouldBlockSolanaEntryFromLaya({ action: 'WAIT', score: 80 }, 'LIVE').blocked, true);

  // Normalização de modos
  assert.strictEqual(normalizeSolanaLayaTacticalMode('OFF'), 'OFF');
  assert.strictEqual(normalizeSolanaLayaTacticalMode('SHADOW'), 'SHADOW');
  assert.strictEqual(normalizeSolanaLayaTacticalMode('LIVE'), 'LIVE');
  assert.strictEqual(normalizeSolanaLayaTacticalMode('ACTIVE'), 'LIVE');
  assert.strictEqual(normalizeSolanaLayaTacticalMode(''), 'LIVE');
});

test('SolanaLayaAdapter health usa proxy privado sem bearer e reporta checkpoint', async () => {
  let seenHeaders: any = null;
  const adapter = new SolanaLayaAdapter({
    baseUrl: 'http://nexus-decisor-laya.railway.internal:8001',
    privateProxy: true,
    httpClient: {
      get: async (_url: string, config: any) => {
        seenHeaders = config.headers;
        return { status: 200, data: { status: 'ok', loaded: ['multilingual'] } };
      }
    } as any
  });

  const health = await adapter.checkHealth();
  assert.strictEqual(seenHeaders?.Authorization, undefined);
  assert.strictEqual(health.ok, true);
  assert.deepStrictEqual(health.loaded, ['multilingual']);
});
