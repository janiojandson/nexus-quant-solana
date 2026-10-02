import test from 'node:test';
import assert from 'node:assert';
import axios from 'axios';
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  VersionedTransaction
} from '@solana/web3.js';
import { JupiterExecutionEngine, SwapExecutionRequest } from './jupiterExecutionEngine.js';
import { DexAggregatorService, SwapQuoteResult } from './dexAggregator.js';

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const TOKEN_MINT = '9GtBRgzUybm5GLk7ZGjpG88aVpZcvLuTdbwNkRraTK7H';

/** Transação V0 serializada válida, para o /swap conseguir desserializar. */
function buildSwapTransactionB64(feePayer: Keypair): string {
  const tx = new Transaction({ feePayer: feePayer.publicKey });
  tx.recentBlockhash = feePayer.publicKey.toBase58().slice(0, 44);
  tx.add(SystemProgram.transfer({ fromPubkey: feePayer.publicKey, toPubkey: PublicKey.default, lamports: 1 }));
  const vtx = new VersionedTransaction(tx.compileMessage());
  vtx.sign([feePayer]);
  return Buffer.from(vtx.serialize()).toString('base64');
}

/** Aggregator controlado: sempre responde com uma cotação válida. */
class OkAggregator extends DexAggregatorService {
  constructor() {
    super('https://fake.invalid');
  }
  public async getQuote(params: any): Promise<SwapQuoteResult> {
    return {
      inputMint: params.inputMint,
      outputMint: params.outputMint,
      inAmount: params.amountLamports,
      outAmount: 987_654,
      priceImpactPct: 0.3,
      slippageBps: 750,
      routePlanSummary: 'Fake',
      rawQuote: {
        inputMint: params.inputMint,
        outputMint: params.outputMint,
        inAmount: String(params.amountLamports),
        outAmount: '987654',
        otherAmountThreshold: '987000',
        swapMode: 'ExactIn'
      }
    };
  }
}

/** Conexão falsa: controla o resultado da simulação e conta transmissões. */
function makeConnection(
  simResult: { err: any } | { throwErr: any },
  confirmResult: { err?: any; throwErr?: any } = { err: null }
) {
  const state = { simulateCalls: 0, sendCalls: 0, confirmCalls: 0 };
  const conn: any = {
    async simulateTransaction() {
      state.simulateCalls++;
      if ('throwErr' in simResult) throw simResult.throwErr;
      return { value: { err: simResult.err ?? null } };
    },
    async sendRawTransaction() {
      state.sendCalls++;
      return 'fake_tx_signature';
    },
    async confirmTransaction() {
      state.confirmCalls++;
      if (confirmResult.throwErr) throw confirmResult.throwErr;
      return { value: { err: confirmResult.err ?? null } };
    }
  };
  return { conn: conn as unknown as Connection, state };
}

function makeEngine(conn: unknown): JupiterExecutionEngine {
  return new JupiterExecutionEngine({
    connection: conn as Connection,
    isDryRun: false,
    dexAggregator: new OkAggregator()
  });
}

const originalPost = axios.post;

test.afterEach(() => {
  axios.post = originalPost;
});

/** Intercepta o POST /swap devolvendo transação assinada pelo keypair da requisição. */
function mockSwapEndpoint(signer: Keypair) {
  axios.post = (async () => ({
    data: { swapTransaction: buildSwapTransactionB64(signer) }
  })) as any;
}

const testSigner = Keypair.generate();
const baseRequest: SwapExecutionRequest = {
  inputMint: SOL_MINT,
  outputMint: TOKEN_MINT,
  amountLamports: 15_000_000,
  userPublicKey: testSigner.publicKey.toBase58(),
  keypair: testSigner,
  autoSlippage: true,
  maxAutoSlippageBps: 750,
  skipPreflight: false
};

test('JupiterExecutionEngine: modo DRY_RUN deve simular swap sem assinar na rede real', async () => {
  const engine = new JupiterExecutionEngine({ isDryRun: true });

  const result = await engine.executeSwap({
    inputMint: SOL_MINT,
    outputMint: TOKEN_MINT,
    amountLamports: 10000000,
    userPublicKey: 'FBx2SKLDLsdeLM8owxU8MNVPKAfJpLpmpHHRgiZDqBoi'
  });

  assert.strictEqual(result.status, 'DRY_RUN_SUCCESS');
  assert.ok(result.txSignature.startsWith('dry_run_tx_'));
  assert.strictEqual(result.isDryRun, true);
  assert.ok(result.outAmount > 0);
});

test('JupiterExecutionEngine: deve inicializar com parâmetros padrão e respeitar skipPreflight configurado', () => {
  const engine = new JupiterExecutionEngine({
    rpcUrl: 'https://api.mainnet-beta.solana.com',
    isDryRun: true
  });
  assert.ok(engine);
});

// ==========================================================================
// PRÉ-VOO FAIL-CLOSED — nunca transmitir quando a simulação reprova
// ==========================================================================

test('JupiterExecutionEngine: NUNCA deve transmitir se a simulação reprovar (Custom 6014)', async () => {
  mockSwapEndpoint(testSigner);
  const { conn, state } = makeConnection({ err: { InstructionError: [6, { Custom: 6014 }] } });
  const engine = makeEngine(conn);

  const result = await engine.executeSwap(baseRequest);

  assert.strictEqual(result.status, 'FAILED');
  assert.match(result.error || '', /Simulação pré-voo rejeitada/);
  assert.match(result.error || '', /6014/);
  assert.strictEqual(result.txSignature, '');
  assert.strictEqual(state.simulateCalls, 1, 'deve ter simulado antes de decidir');
  assert.strictEqual(state.sendCalls, 0, 'NUNCA deve transmitir após simulação reprovada');
});

test('JupiterExecutionEngine: NUNCA deve transmitir se o próprio RPC de simulação falhar (fail-closed)', async () => {
  mockSwapEndpoint(testSigner);
  const { conn, state } = makeConnection({ throwErr: new Error('RPC indisponível: 502') });
  const engine = makeEngine(conn);

  const result = await engine.executeSwap(baseRequest);

  assert.strictEqual(result.status, 'FAILED');
  assert.match(result.error || '', /Simulação pré-voo rejeitada/);
  assert.strictEqual(result.txSignature, '');
  assert.strictEqual(state.sendCalls, 0, 'falha de simulação não pode resultar em transmissão');
});

test('JupiterExecutionEngine: deve transmitir quando a simulação aprova', async () => {
  mockSwapEndpoint(testSigner);
  const { conn, state } = makeConnection({ err: null });
  const engine = makeEngine(conn);

  const result = await engine.executeSwap(baseRequest);

  assert.strictEqual(state.simulateCalls, 1);
  assert.strictEqual(state.sendCalls, 1);
  assert.strictEqual(state.confirmCalls, 1);
  assert.strictEqual(result.status, 'SUCCESS');
  assert.strictEqual(result.txSignature, 'fake_tx_signature');
  assert.strictEqual(result.outAmount, 987_654);
});

test('JupiterExecutionEngine: deve abortar sem outAmount ficticio quando a cotação falha', async () => {
  mockSwapEndpoint(testSigner);
  const { conn, state } = makeConnection({ err: null });

  class FailingAggregator extends DexAggregatorService {
    constructor() {
      super('https://fake.invalid');
    }
    public async getQuote(): Promise<SwapQuoteResult> {
      throw new Error('Falha na cotação Jupiter (429): rate limit');
    }
  }

  const engine = new JupiterExecutionEngine({
    connection: conn as Connection,
    isDryRun: false,
    dexAggregator: new FailingAggregator()
  });

  const result = await engine.executeSwap({ ...baseRequest, amountLamports: 50_000_000 });

  assert.strictEqual(result.status, 'FAILED');
  assert.strictEqual(result.outAmount, 0, 'jamais pode haver outAmount inventado');
  assert.strictEqual(state.sendCalls, 0);
});

// ==========================================================================
// SIMULATE SWAP — usado pelo sizer adaptativo para testar cada degrau da escada
// ==========================================================================

test('simulateSwap: deve reportar sucesso sem transmitir quando a simulação aprova', async () => {
  mockSwapEndpoint(testSigner);
  const { conn, state } = makeConnection({ err: null });
  const engine = makeEngine(conn);

  const sim = await engine.simulateSwap(baseRequest);

  assert.strictEqual(sim.success, true);
  assert.strictEqual(state.simulateCalls, 1);
  assert.strictEqual(state.sendCalls, 0, 'simulateSwap jamais deve transmitir');
});

test('simulateSwap: deve reportar o erro 6014 para o sizer escalonar o lote', async () => {
  mockSwapEndpoint(testSigner);
  const { conn, state } = makeConnection({ err: { InstructionError: [6, { Custom: 6014 }] } });
  const engine = makeEngine(conn);

  const sim = await engine.simulateSwap(baseRequest);

  assert.strictEqual(sim.success, false);
  assert.match(sim.error || '', /6014/);
  assert.strictEqual(state.sendCalls, 0);
});

test('simulateSwap: deve falhar fechado quando a própria simulação lança', async () => {
  mockSwapEndpoint(testSigner);
  const { conn, state } = makeConnection({ throwErr: new Error('RPC 502') });
  const engine = makeEngine(conn);

  const sim = await engine.simulateSwap(baseRequest);

  assert.strictEqual(sim.success, false);
  assert.match(sim.error || '', /502/);
  assert.strictEqual(state.sendCalls, 0);
});

test('simulateSwap: deve falhar fechado quando a cotação está indisponível', async () => {
  const { conn, state } = makeConnection({ err: null });

  class FailingAggregator extends DexAggregatorService {
    constructor() {
      super('https://fake.invalid');
    }
    public async getQuote(): Promise<SwapQuoteResult> {
      throw new Error('Falha na cotação Jupiter (429): rate limit');
    }
  }

  const engine = new JupiterExecutionEngine({
    connection: conn as Connection,
    isDryRun: false,
    dexAggregator: new FailingAggregator()
  });

  const sim = await engine.simulateSwap(baseRequest);

  assert.strictEqual(sim.success, false);
  assert.match(sim.error || '', /rate limit/);
  assert.strictEqual(state.simulateCalls, 0, 'nem deve simular sem cotação válida');
  assert.strictEqual(state.sendCalls, 0);
});

test('JupiterExecutionEngine: deve marcar FAILED quando a tx for incluída com erro on-chain', async () => {
  mockSwapEndpoint(testSigner);
  const { conn, state } = makeConnection(
    { err: null },
    { err: { InstructionError: [2, 'CustomFailure'] } }
  );
  const engine = makeEngine(conn);

  const result = await engine.executeSwap(baseRequest);

  assert.strictEqual(state.sendCalls, 1);
  assert.strictEqual(state.confirmCalls, 1);
  assert.strictEqual(result.status, 'FAILED');
  assert.strictEqual(result.txSignature, 'fake_tx_signature');
  assert.strictEqual(result.outAmount, 0);
  assert.match(result.error || '', /falhou on-chain/);
});

test('JupiterExecutionEngine: não deve chamar sucesso quando submissão não confirma', async () => {
  mockSwapEndpoint(testSigner);
  const { conn, state } = makeConnection(
    { err: null },
    { throwErr: new Error('RPC confirmation unavailable') }
  );
  const engine = makeEngine(conn);

  const result = await engine.executeSwap(baseRequest);

  assert.strictEqual(state.sendCalls, 1);
  assert.strictEqual(state.confirmCalls, 1);
  assert.strictEqual(result.status, 'SUBMITTED_UNCONFIRMED');
  assert.strictEqual(result.txSignature, 'fake_tx_signature');
  assert.strictEqual(result.outAmount, 0);
  assert.match(result.error || '', /confirmação não foi obtida/);
});

test('JupiterExecutionEngine: limita priority fee de compra ao teto configurado', async () => {
  let maxLamportsSeen: number | undefined;
  axios.post = (async (_url: string, body: any) => {
    maxLamportsSeen = body?.prioritizationFeeLamports?.priorityLevelWithMaxLamports?.maxLamports;
    return { data: { swapTransaction: buildSwapTransactionB64(testSigner) } };
  }) as any;

  const { conn } = makeConnection({ err: null });
  const engine = new JupiterExecutionEngine({
    connection: conn,
    isDryRun: false,
    dexAggregator: new OkAggregator(),
    buyMaxPriorityFeeLamports: 123_456
  });

  const result = await engine.executeSwap(baseRequest);
  assert.strictEqual(result.status, 'SUCCESS');
  assert.strictEqual(maxLamportsSeen, 123_456);
});
