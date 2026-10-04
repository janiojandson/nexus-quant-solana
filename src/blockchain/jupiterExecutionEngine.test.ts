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
const V2_BASE = 'https://fake.invalid';

function buildSwapTransactionB64(wallet: Keypair, feePayer: Keypair = wallet): string {
  const tx = new Transaction({ feePayer: feePayer.publicKey });
  tx.recentBlockhash = Keypair.generate().publicKey.toBase58();
  tx.add(SystemProgram.transfer({
    fromPubkey: wallet.publicKey,
    toPubkey: PublicKey.default,
    lamports: 1
  }));
  const vtx = new VersionedTransaction(tx.compileMessage());
  if (feePayer === wallet) vtx.sign([wallet]);
  else vtx.sign([feePayer]);
  return Buffer.from(vtx.serialize()).toString('base64');
}
class OkAggregator extends DexAggregatorService {
  constructor() {
    super(V2_BASE, { apiKey: 'test-key', rateLimitMs: 0, cacheTtlMs: 0 });
  }

  public async getQuote(params: any): Promise<SwapQuoteResult> {
    return {
      inputMint: params.inputMint,
      outputMint: params.outputMint,
      inAmount: params.amountLamports,
      outAmount: 987_654,
      priceImpactPct: 0.3,
      slippageBps: 15,
      routePlanSummary: 'Fake V2',
      router: 'metis',
      mode: 'ultra',
      requestId: 'quote-request',
      feeBps: 2,
      feeMint: SOL_MINT
    };
  }

  public async waitForRateSlot(): Promise<void> {
    return;
  }
}

function makeConnection(simResult: { err: any } | { throwErr: any }) {
  const state = { simulateCalls: 0 };
  const conn: any = {
    async simulateTransaction() {
      state.simulateCalls++;
      if ('throwErr' in simResult) throw simResult.throwErr;
      return { value: { err: simResult.err ?? null, unitsConsumed: 123_456 } };
    }
  };
  return { conn: conn as unknown as Connection, state };
}
const originalGet = axios.get;
const originalPost = axios.post;

test.afterEach(() => {
  axios.get = originalGet;
  axios.post = originalPost;
});

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

function makeEngine(conn: Connection, signer = testSigner): JupiterExecutionEngine {
  return new JupiterExecutionEngine({
    connection: conn,
    isDryRun: false,
    dexAggregator: new OkAggregator(),
    apiKey: 'test-key',
    v2BaseUrl: V2_BASE,
    confirmationTimeoutMs: 20_000
  });
}

function mockOrder(
  signer = testSigner,
  overrides: Record<string, unknown> = {},
  feePayer: Keypair = signer
) {
  axios.get = (async (url: string) => {
    assert.strictEqual(url, V2_BASE + '/order');
    return {
      data: {
        transaction: buildSwapTransactionB64(signer, feePayer),
        requestId: 'req-v2-1',
        inAmount: String(baseRequest.amountLamports),
        outAmount: '987654',
        router: 'metis',
        mode: 'ultra',
        slippageBps: 15,
        feeBps: 2,
        feeMint: SOL_MINT,
        lastValidBlockHeight: '123456',
        ...overrides
      }
    };
  }) as any;
}

function mockExecuteSuccess(
  totalOutputAmount = '900000',
  signature = 'fake_v2_signature'
) {
  axios.post = (async (url: string, body: any) => {
    assert.strictEqual(url, V2_BASE + '/execute');
    assert.strictEqual(body.requestId, 'req-v2-1');
    assert.ok(body.signedTransaction);
    return {
      data: {
        status: 'Success',
        signature,
        code: 0,
        totalInputAmount: String(baseRequest.amountLamports),
        totalOutputAmount,
        inputAmountResult: String(baseRequest.amountLamports),
        outputAmountResult: '987654'
      }
    };
  }) as any;
}
test('Jupiter V2 uses injected coordinator for general order and separate execute bucket', async () => {
  mockOrder();
  mockExecuteSuccess();
  const { conn } = makeConnection({ err: null });
  const seen: Array<{ priority: number; bucket: string }> = [];
  const coordinator: any = {
    async schedule(priority: number, op: () => Promise<unknown>, bucket = 'general') {
      seen.push({ priority, bucket });
      return op();
    }
  };
  const engine = new JupiterExecutionEngine({
    connection: conn,
    isDryRun: false,
    dexAggregator: new OkAggregator(),
    apiKey: 'test-key',
    v2BaseUrl: V2_BASE,
    confirmationTimeoutMs: 20_000,
    trafficCoordinator: coordinator
  } as any);

  const result = await engine.executeSwap({
    ...baseRequest,
    trafficPriority: 1
  } as any);

  assert.strictEqual(result.status, 'SUCCESS');
  assert.deepStrictEqual(seen, [
    { priority: 1, bucket: 'general' },
    { priority: 1, bucket: 'execute' }
  ]);
});

test('Jupiter V2: DRY_RUN usa quote V2 sem executar /execute', async () => {
  let postCalls = 0;
  axios.post = (async () => {
    postCalls++;
    throw new Error('não deveria chamar /execute');
  }) as any;

  const engine = new JupiterExecutionEngine({
    isDryRun: true,
    dexAggregator: new OkAggregator(),
    apiKey: 'test-key',
    v2BaseUrl: V2_BASE
  });

  const result = await engine.executeSwap({
    inputMint: SOL_MINT,
    outputMint: TOKEN_MINT,
    amountLamports: 10_000_000,
    userPublicKey: testSigner.publicKey.toBase58()
  });

  assert.strictEqual(result.status, 'DRY_RUN_SUCCESS');
  assert.ok(result.txSignature.startsWith('dry_run_v2_'));
  assert.strictEqual(result.executionPath, 'V2_META_AGGREGATOR');
  assert.strictEqual(result.router, 'metis');
  assert.strictEqual(postCalls, 0);
});

test('Jupiter V2: simulação 6014 barra /execute', async () => {
  mockOrder();
  let postCalls = 0;
  axios.post = (async () => { postCalls++; throw new Error('não chamar'); }) as any;
  const { conn, state } = makeConnection({ err: { InstructionError: [6, { Custom: 6014 }] } });
  const engine = makeEngine(conn);

  const result = await engine.executeSwap(baseRequest);

  assert.strictEqual(result.status, 'FAILED');
  assert.match(result.error || '', /6014/);
  assert.strictEqual(state.simulateCalls, 1);
  assert.strictEqual(postCalls, 0);
});
test('Jupiter V2: falha do RPC de simulação é fail-closed', async () => {
  mockOrder();
  let postCalls = 0;
  axios.post = (async () => { postCalls++; throw new Error('não chamar'); }) as any;
  const { conn } = makeConnection({ throwErr: new Error('RPC indisponível: 502') });
  const engine = makeEngine(conn);

  const result = await engine.executeSwap(baseRequest);

  assert.strictEqual(result.status, 'FAILED');
  assert.match(result.error || '', /502/);
  assert.strictEqual(postCalls, 0);
});

test('Jupiter V2: sucesso usa totalOutputAmount refletido na wallet', async () => {
  mockOrder();
  mockExecuteSuccess('900000');
  const { conn, state } = makeConnection({ err: null });
  const engine = makeEngine(conn);

  const result = await engine.executeSwap(baseRequest);

  assert.strictEqual(state.simulateCalls, 1);
  assert.strictEqual(result.status, 'SUCCESS');
  assert.strictEqual(result.txSignature, 'fake_v2_signature');
  assert.strictEqual(result.outAmount, 900_000);
  assert.notStrictEqual(result.outAmount, 987_654, 'não deve usar outputAmountResult/quote como realizado');
  assert.strictEqual(result.router, 'metis');
  assert.strictEqual(result.requestId, 'req-v2-1');
});
test('Jupiter V2: simulateSwap nunca chama /execute', async () => {
  mockOrder();
  let postCalls = 0;
  axios.post = (async () => { postCalls++; throw new Error('não chamar'); }) as any;
  const { conn, state } = makeConnection({ err: null });
  const engine = makeEngine(conn);

  const sim = await engine.simulateSwap(baseRequest);

  assert.strictEqual(sim.success, true);
  assert.strictEqual(state.simulateCalls, 1);
  assert.strictEqual(postCalls, 0);
});

test('Jupiter V2: simulateSwap propaga 6014', async () => {
  mockOrder();
  let postCalls = 0;
  axios.post = (async () => { postCalls++; throw new Error('não chamar'); }) as any;
  const { conn } = makeConnection({ err: { InstructionError: [6, { Custom: 6014 }] } });
  const engine = makeEngine(conn);

  const sim = await engine.simulateSwap(baseRequest);

  assert.strictEqual(sim.success, false);
  assert.match(sim.error || '', /6014/);
  assert.strictEqual(postCalls, 0);
});

test('Jupiter V2: /order indisponível falha sem /execute', async () => {
  axios.get = (async () => {
    const err: any = new Error('rate limit');
    err.response = { status: 429, data: { error: 'rate limit' } };
    throw err;
  }) as any;
  let postCalls = 0;
  axios.post = (async () => { postCalls++; throw new Error('não chamar'); }) as any;
  const { conn } = makeConnection({ err: null });
  const engine = makeEngine(conn);
  const result = await engine.executeSwap(baseRequest);

  assert.strictEqual(result.status, 'FAILED');
  assert.match(result.error || '', /rate limit/);
  assert.strictEqual(postCalls, 0);
});

test('Jupiter V2: resposta Failed do /execute não vira sucesso', async () => {
  mockOrder();
  axios.post = (async () => ({
    data: {
      status: 'Failed',
      signature: 'failed_sig',
      code: -1001,
      error: 'aggregator rejected'
    }
  })) as any;
  const { conn } = makeConnection({ err: null });
  const engine = makeEngine(conn);

  const result = await engine.executeSwap(baseRequest);

  assert.strictEqual(result.status, 'FAILED');
  assert.strictEqual(result.outAmount, 0);
  assert.match(result.error || '', /-1001/);
});

test('Jupiter V2: timeout repete somente o MESMO requestId/transação', async () => {
  mockOrder();
  const payloads: any[] = [];
  axios.post = (async (_url: string, body: any) => {
    payloads.push({ ...body });
    throw new Error('ECONNRESET');
  }) as any;
  const { conn } = makeConnection({ err: null });
  const engine = makeEngine(conn);

  const result = await engine.executeSwap(baseRequest);

  assert.strictEqual(result.status, 'SUBMITTED_UNCONFIRMED');
  assert.strictEqual(payloads.length, 2);
  assert.strictEqual(payloads[0].requestId, payloads[1].requestId);
  assert.strictEqual(payloads[0].signedTransaction, payloads[1].signedTransaction);
  assert.match(result.error || '', /reconciliar o requestId/);
});
test('Jupiter V2: retry idempotente pode resolver resposta incerta', async () => {
  mockOrder();
  const payloads: any[] = [];
  let calls = 0;
  axios.post = (async (_url: string, body: any) => {
    payloads.push({ ...body });
    calls++;
    if (calls === 1) throw new Error('gateway timeout');
    return {
      data: {
        status: 'Success',
        signature: 'resolved_sig',
        code: 0,
        totalInputAmount: String(baseRequest.amountLamports),
        totalOutputAmount: '888000'
      }
    };
  }) as any;

  const { conn } = makeConnection({ err: null });
  const engine = makeEngine(conn);
  const result = await engine.executeSwap(baseRequest);

  assert.strictEqual(result.status, 'SUCCESS');
  assert.strictEqual(result.txSignature, 'resolved_sig');
  assert.strictEqual(result.outAmount, 888_000);
  assert.strictEqual(payloads.length, 2);
  assert.deepStrictEqual(payloads[0], payloads[1]);
});

test('Jupiter V2: aceita transação JupiterZ com signer adicional', async () => {
  const maker = Keypair.generate();
  mockOrder(testSigner, { router: 'jupiterz' }, maker);
  mockExecuteSuccess('777000', 'jz_sig');
  const { conn } = makeConnection({ err: null });
  const engine = makeEngine(conn);

  const result = await engine.executeSwap(baseRequest);

  assert.strictEqual(result.status, 'SUCCESS');
  assert.strictEqual(result.router, 'jupiterz');
  assert.strictEqual(result.txSignature, 'jz_sig');
});
test('Jupiter V2: RTSE acima do hard-cap bloqueia antes de /execute', async () => {
  mockOrder(testSigner, { slippageBps: 800 });
  let postCalls = 0;
  axios.post = (async () => { postCalls++; throw new Error('não chamar'); }) as any;
  const { conn } = makeConnection({ err: null });
  const engine = makeEngine(conn);

  const result = await engine.executeSwap(baseRequest);

  assert.strictEqual(result.status, 'FAILED');
  assert.match(result.error || '', /hard-cap/);
  assert.strictEqual(postCalls, 0);
});

test('Jupiter V2: saída explícita preserva slippage 500bps', async () => {
  let seenParams: any;
  axios.get = (async (_url: string, config: any) => {
    seenParams = config.params;
    return {
      data: {
        transaction: buildSwapTransactionB64(testSigner),
        requestId: 'req-v2-1',
        inAmount: '1000000',
        outAmount: '500000',
        router: 'metis',
        mode: 'ultra',
        slippageBps: 500
      }
    };
  }) as any;
  mockExecuteSuccess('500000');
  const { conn } = makeConnection({ err: null });
  const engine = makeEngine(conn);

  const result = await engine.executeSwap({
    ...baseRequest,
    inputMint: TOKEN_MINT,
    outputMint: SOL_MINT,
    amountLamports: 1_000_000,
    autoSlippage: false,
    slippageBps: 500
  });

  assert.strictEqual(result.status, 'SUCCESS');
  assert.strictEqual(seenParams.slippageBps, 500);
});

test('RTSE over cap requests exactly one fresh capped order before simulation', async () => {
 const seen: any[] = [];
 axios.get = (async (_url:string, config:any) => {
   seen.push({...config.params});
   return {data:{transaction:buildSwapTransactionB64(testSigner),requestId:'capped-'+seen.length,
    inAmount:String(baseRequest.amountLamports),outAmount:'987654',slippageBps:seen.length===1?1000:500}};
 }) as any;
 const {conn,state}=makeConnection({err:null});
 const result=await makeEngine(conn).simulateSwap({...baseRequest,maxAutoSlippageBps:500});
 assert.strictEqual(result.success,true);
 assert.strictEqual(seen.length,2);
 assert.strictEqual(seen[0].slippageBps,undefined);
 assert.strictEqual(seen[1].slippageBps,500);
 assert.strictEqual(state.simulateCalls,1);
});
test('capped replacement rejected if provider ignores cap; no simulation or execution', async () => {
 let getCalls=0,postCalls=0;
 axios.get=(async()=>{getCalls++;return {data:{transaction:buildSwapTransactionB64(testSigner),requestId:'unsafe',slippageBps:1000}};}) as any;
 axios.post=(async()=>{postCalls++;throw Error('never');}) as any;
 const {conn,state}=makeConnection({err:null});
 const result=await makeEngine(conn).simulateSwap(baseRequest);
 assert.strictEqual(result.success,false);assert.strictEqual(getCalls,2);
 assert.strictEqual(state.simulateCalls,0);assert.strictEqual(postCalls,0);
 assert.match(result.error||'',/hard-cap/);
});

test('Jupiter V2 requires final wallet totals rather than gross route output', async()=>{
 mockOrder();axios.post=(async()=>({data:{status:'Success',code:0,signature:'pending-accounting',inputAmountResult:'15000000',outputAmountResult:'900000'}})) as any;
 const {conn}=makeConnection({err:null});const result=await makeEngine(conn).executeSwap(baseRequest);
 assert.strictEqual(result.status,'SUBMITTED_UNCONFIRMED');assert.strictEqual(result.outAmount,0);assert.strictEqual(result.txSignature,'pending-accounting');
});
test('Jupiter V2 refuses expired RFQ before simulation',async()=>{
 mockOrder(testSigner,{router:'jupiterz',expireAt:new Date(Date.now()-1000).toISOString()});
 const {conn,state}=makeConnection({err:null});const result=await makeEngine(conn).simulateSwap(baseRequest);
 assert.strictEqual(result.success,false);assert.strictEqual(state.simulateCalls,0);assert.match(result.error||'',/expireAt/);
});
test('Jupiter V2 checks RFQ expiry again after preflight',async()=>{
 mockOrder(testSigner,{expireAt:new Date(Date.now()+60000).toISOString()});
 let posts=0;axios.post=(async()=>{posts++;throw Error('never');}) as any;
 const now=Date.now;const {conn}=makeConnection({err:null});
 (conn as any).simulateTransaction=async()=>{Date.now=()=>now()+120000;return {value:{err:null}};};
 try{const r=await makeEngine(conn).executeSwap(baseRequest);assert.strictEqual(r.status,'FAILED');assert.strictEqual(posts,0);}
 finally{Date.now=now;}
});
test('Jupiter V2 refuses unknown slippage before signing',async()=>{
 mockOrder(testSigner,{slippageBps:undefined});
 const {conn,state}=makeConnection({err:null});const result=await makeEngine(conn).simulateSwap(baseRequest);
 assert.strictEqual(result.success,false);assert.strictEqual(state.simulateCalls,0);
});
