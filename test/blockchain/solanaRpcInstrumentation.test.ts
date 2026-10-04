import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
import {
  SolanaWalletService,
  resolveRpcProviderAlias,
  parseRpcError
} from '../../src/blockchain/solanaWallet.js';
import {
  globalTelemetryBuffer,
  getGlobalTelemetryInternalErrorCount,
  resetGlobalTelemetryInternalErrorCount
} from '../../src/telemetry/telemetryBuffer.js';

test('SolanaRpcInstrumentation: 1-4. Provider alias classification (Helius, QuickNode, Solana Public, Custom Private, Unknown)', () => {
  // 1. Helius
  assert.equal(resolveRpcProviderAlias('https://mainnet.helius-rpc.com/?api-key=secret-123'), 'HELIUS');
  assert.equal(resolveRpcProviderAlias('https://rpc.helius.xyz/?api-key=token-456'), 'HELIUS');

  // 2. QuickNode
  assert.equal(resolveRpcProviderAlias('https://solana-mainnet.quiknode.pro/abc-secret/'), 'QUICKNODE');
  assert.equal(resolveRpcProviderAlias('https://my-node.quicknode.com/'), 'QUICKNODE');

  // 3. Solana Public
  assert.equal(resolveRpcProviderAlias('https://api.mainnet-beta.solana.com'), 'SOLANA_PUBLIC');
  assert.equal(resolveRpcProviderAlias('https://api.devnet.solana.com'), 'SOLANA_PUBLIC');
  assert.equal(resolveRpcProviderAlias(undefined), 'SOLANA_PUBLIC');
  assert.equal(resolveRpcProviderAlias(''), 'SOLANA_PUBLIC');

  // 4. Custom Private & Unknown
  assert.equal(resolveRpcProviderAlias('http://localhost:8899'), 'CUSTOM_PRIVATE');
  assert.equal(resolveRpcProviderAlias('http://127.0.0.1:8899'), 'CUSTOM_PRIVATE');
  assert.equal(resolveRpcProviderAlias('https://my-rpc.railway.internal:8899'), 'CUSTOM_PRIVATE');
  assert.equal(resolveRpcProviderAlias('https://custom-private-solana.org/rpc'), 'CUSTOM_PRIVATE');
  assert.equal(resolveRpcProviderAlias('not-a-valid-url'), 'UNKNOWN');
  assert.equal(resolveRpcProviderAlias('ftp://invalid-scheme.com'), 'UNKNOWN');
});

test('SolanaRpcInstrumentation: 5-6. URL real e API key nunca aparecem no span', async () => {
  globalTelemetryBuffer.clear();
  const kp = Keypair.generate();
  const secretKeyRaw = JSON.stringify(Array.from(kp.secretKey));
  const sensitiveApiKey = 'helius-super-secret-token-xyz999';
  const sensitiveUrl = `https://mainnet.helius-rpc.com/?api-key=${sensitiveApiKey}`;

  const wallet = new SolanaWalletService({
    secretKeyRaw,
    rpcUrl: sensitiveUrl
  });

  assert.equal(wallet.getProviderAlias(), 'HELIUS');

  // Mock de conexão
  (wallet as any).connection = {
    getBalance: async () => 1_500_000_000
  };

  const balance = await wallet.getBalanceSol();
  assert.equal(balance, 1.5);

  const spans = globalTelemetryBuffer.flush();
  assert.equal(spans.length, 1);
  const span = spans[0];

  assert.equal(span.spanName, 'solana_rpc');
  assert.equal(span.providerAlias, 'HELIUS');
  assert.equal(span.metadata?.method, 'getBalance');

  const dumped = JSON.stringify(span);
  assert.equal(dumped.includes(sensitiveApiKey), false, 'API key vazou no span!');
  assert.equal(dumped.includes('mainnet.helius-rpc.com'), false, 'URL bruta vazou no span!');
  assert.equal(dumped.includes('api-key'), false, 'Token de query vazou no span!');
});

test('SolanaRpcInstrumentation: 7-8. getBalance e getAccountInfo mantêm retorno idêntico', async () => {
  globalTelemetryBuffer.clear();
  const kp = Keypair.generate();
  const secretKeyRaw = JSON.stringify(Array.from(kp.secretKey));
  const wallet = new SolanaWalletService({ secretKeyRaw });

  (wallet as any).connection = {
    getBalance: async () => 3_250_000_000
  };

  const bal = await wallet.getBalanceSol();
  assert.equal(bal, 3.25);

  // Delta atômico
  (wallet as any).connection = {
    getParsedTransaction: async () => ({
      slot: 289456123,
      meta: {
        preTokenBalances: [{ mint: 'TokenMintA', owner: wallet.getPublicKey(), uiTokenAmount: { amount: '1000' } }],
        postTokenBalances: [{ mint: 'TokenMintA', owner: wallet.getPublicKey(), uiTokenAmount: { amount: '6000' } }]
      }
    })
  };

  const delta = await wallet.getReceivedTokenDeltaAtomic('sig123', 'TokenMintA');
  assert.equal(delta, '5000');
});

test('SolanaRpcInstrumentation: 9-10. Erro RPC e timeout mantêm comportamento original', async () => {
  globalTelemetryBuffer.clear();
  const kp = Keypair.generate();
  const secretKeyRaw = JSON.stringify(Array.from(kp.secretKey));
  const wallet = new SolanaWalletService({ secretKeyRaw });

  // 9. Erro padrão
  (wallet as any).connection = {
    getBalance: async () => {
      throw new Error('Connection refused by peer');
    }
  };

  const balFail = await wallet.getBalanceSol();
  assert.equal(balFail, 0); // Mantém comportamento original de getBalanceSol que retorna 0 em falha

  let spans = globalTelemetryBuffer.flush();
  assert.equal(spans.length, 1);
  assert.equal(spans[0].status, 'ERROR');
  assert.equal(spans[0].metadata?.success, false);
  assert.equal(spans[0].metadata?.timedOut, false);
  assert.equal(spans[0].metadata?.errorClass, 'Error');

  // 10. Timeout
  (wallet as any).connection = {
    getBalance: async () => {
      const timeoutErr = new Error('Gateway Timeout');
      timeoutErr.name = 'TimeoutError';
      throw timeoutErr;
    }
  };

  await wallet.getBalanceSol();
  spans = globalTelemetryBuffer.flush();
  assert.equal(spans.length, 1);
  assert.equal(spans[0].status, 'ERROR');
  assert.equal(spans[0].metadata?.timedOut, true);
  assert.equal(spans[0].metadata?.errorClass, 'TimeoutError');
});

test('SolanaRpcInstrumentation: 11. Latency medida por monotonic clock (diffMonotonicMs)', async () => {
  globalTelemetryBuffer.clear();
  const kp = Keypair.generate();
  const secretKeyRaw = JSON.stringify(Array.from(kp.secretKey));
  const wallet = new SolanaWalletService({ secretKeyRaw });

  (wallet as any).connection = {
    getBalance: async () => {
      await new Promise(r => setTimeout(r, 25));
      return 1_000_000_000;
    }
  };

  await wallet.getBalanceSol();
  const spans = globalTelemetryBuffer.flush();
  assert.equal(spans.length, 1);
  const span = spans[0];

  assert.ok(span.durationMs >= 20, `Duração esperada >= 20ms, obteve ${span.durationMs}`);
  assert.ok(typeof span.metadata?.rpcStartedMonoNs === 'string');
  assert.ok(typeof span.metadata?.rpcCompletedMonoNs === 'string');
  assert.equal(typeof span.metadata?.elapsedMs, 'number');
});

test('SolanaRpcInstrumentation: 12-14. sourceSlot registrado somente quando presente e ZERO getSlot ou RPC extra', async () => {
  globalTelemetryBuffer.clear();
  const kp = Keypair.generate();
  const secretKeyRaw = JSON.stringify(Array.from(kp.secretKey));
  const wallet = new SolanaWalletService({ secretKeyRaw });

  let getSlotCalled = false;

  (wallet as any).connection = {
    getSlot: async () => {
      getSlotCalled = true;
      return 999999999;
    },
    // getBalance não tem slot na resposta
    getBalance: async () => 2_000_000_000,
    // getParsedTransaction tem slot nativo
    getParsedTransaction: async () => ({
      slot: 310500123,
      meta: null
    })
  };

  await wallet.getBalanceSol();
  await wallet.getReceivedTokenDeltaAtomic('txSlotTest', 'Mint1');

  assert.equal(getSlotCalled, false, 'getSlot NUNCA deve ser chamado!');

  const spans = globalTelemetryBuffer.flush();
  assert.equal(spans.length, 2);

  const getBalSpan = spans.find(s => s.metadata?.method === 'getBalance');
  assert.ok(getBalSpan);
  assert.equal(getBalSpan.metadata?.sourceSlot, undefined);

  const getTxSpan = spans.find(s => s.metadata?.method === 'getParsedTransaction');
  assert.ok(getTxSpan);
  assert.equal(getTxSpan.metadata?.sourceSlot, 310500123);
});

test('SolanaRpcInstrumentation: 12 (específico). Teste quantitativo de contagem de chamadas (ANTES === DEPOIS)', async () => {
  const kp = Keypair.generate();
  const secretKeyRaw = JSON.stringify(Array.from(kp.secretKey));
  const wallet = new SolanaWalletService({ secretKeyRaw });

  let rawCallsCount = 0;
  (wallet as any).connection = {
    getBalance: async () => {
      rawCallsCount++;
      return 1_000_000_000;
    },
    getParsedTransaction: async () => {
      rawCallsCount++;
      return { slot: 100, meta: null };
    },
    getSignaturesForAddress: async () => {
      rawCallsCount++;
      return [];
    },
    getParsedTokenAccountsByOwner: async () => {
      rawCallsCount++;
      return { value: [] };
    }
  };

  // Executa cada operação
  rawCallsCount = 0;
  await wallet.getBalanceSol();
  assert.equal(rawCallsCount, 1, 'getBalance deve fazer exatamente 1 chamada RPC');

  rawCallsCount = 0;
  await wallet.getReceivedTokenDeltaAtomic('tx1', 'mint1');
  assert.equal(rawCallsCount, 1, 'getReceivedTokenDeltaAtomic deve fazer exatamente 1 chamada RPC');

  rawCallsCount = 0;
  await wallet.findRecentTokenDeltaTransaction('mint1', Date.now());
  assert.equal(rawCallsCount, 1, 'findRecentTokenDeltaTransaction sem txs deve fazer exatamente 1 chamada RPC');

  rawCallsCount = 0;
  await wallet.getSplTokenAccounts();
  assert.equal(rawCallsCount, 2, 'getSplTokenAccounts deve fazer exatamente 2 chamadas RPC (1 SPL + 1 Token-2022)');
});

test('SolanaRpcInstrumentation: 15. Commitment original preservado', async () => {
  globalTelemetryBuffer.clear();
  const kp = Keypair.generate();
  const secretKeyRaw = JSON.stringify(Array.from(kp.secretKey));
  const wallet = new SolanaWalletService({ secretKeyRaw });

  let capturedCommitment: string | undefined = undefined;
  (wallet as any).connection = {
    getParsedTransaction: async (_sig: string, opts: any) => {
      capturedCommitment = opts?.commitment;
      return null;
    }
  };

  await wallet.getReceivedTokenDeltaAtomic('sigCommitment', 'mint1');
  assert.equal(capturedCommitment, 'confirmed');

  const spans = globalTelemetryBuffer.flush();
  assert.equal(spans[0].metadata?.commitment, 'confirmed');
});

test('SolanaRpcInstrumentation: 16. Erro Custom sem programId não é classificado arbitrariamente (classification = UNKNOWN)', () => {
  // Caso A: Com código 6014 mas SEM programId -> UNKNOWN
  const errorNoProgram = new Error('Instruction 0: custom program error: 0x177e');
  const parsedA = parseRpcError(errorNoProgram);
  assert.ok(parsedA.customProgramError);
  assert.equal(parsedA.customProgramError.customCode, 6014);
  assert.equal(parsedA.customProgramError.programId, undefined);
  assert.equal(parsedA.customProgramError.classification, 'UNKNOWN');

  // Caso B: Com código 6014 E com programId -> SLIPPAGE_EXCEEDED
  const errorWithProgram: any = new Error('Instruction 0: custom program error: 0x177e');
  errorWithProgram.logs = [
    'Program JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4 invoke [1]',
    'Program JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4 failed: custom program error: 0x177e'
  ];
  const parsedB = parseRpcError(errorWithProgram);
  assert.ok(parsedB.customProgramError);
  assert.equal(parsedB.customProgramError.customCode, 6014);
  assert.equal(parsedB.customProgramError.programId, 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4');
  assert.equal(parsedB.customProgramError.classification, 'SLIPPAGE_EXCEEDED');

  // Caso C: Logs digest truncado a no máximo 200 caracteres
  assert.ok((parsedB.customProgramError.logsDigest?.length ?? 0) <= 200);
});

test('SolanaRpcInstrumentation: 17-18. Telemetry failure não quebra RPC e telemetryInternalErrorCount incrementa', async () => {
  resetGlobalTelemetryInternalErrorCount();
  assert.equal(getGlobalTelemetryInternalErrorCount(), 0);

  const kp = Keypair.generate();
  const secretKeyRaw = JSON.stringify(Array.from(kp.secretKey));
  const wallet = new SolanaWalletService({ secretKeyRaw });

  (wallet as any).connection = {
    getBalance: async () => 5_000_000_000
  };

  // Simula falha catastrófica interna no buffer de telemetria
  const originalPush = globalTelemetryBuffer.push.bind(globalTelemetryBuffer);
  (globalTelemetryBuffer as any).push = () => {
    throw new Error('Simulated ring-buffer internal crash');
  };

  try {
    const bal = await wallet.getBalanceSol();
    // RPC DEVE ter sucesso intacto
    assert.equal(bal, 5.0);
    // Contador interno de erro de telemetria DEVE ter incrementado
    assert.ok(getGlobalTelemetryInternalErrorCount() >= 1);
  } finally {
    // Restaura buffer
    (globalTelemetryBuffer as any).push = originalPush;
    resetGlobalTelemetryInternalErrorCount();
  }
});

test('SolanaRpcInstrumentation: 19. BigInt continua seguro em deltas e saldos', async () => {
  globalTelemetryBuffer.clear();
  const kp = Keypair.generate();
  const secretKeyRaw = JSON.stringify(Array.from(kp.secretKey));
  const wallet = new SolanaWalletService({ secretKeyRaw });

  const largeRawAmount = '9007199254740993000'; // Maior que MAX_SAFE_INTEGER
  (wallet as any).connection = {
    getParsedTransaction: async () => ({
      slot: 12345,
      meta: {
        preTokenBalances: [],
        postTokenBalances: [{
          mint: 'BigIntMint',
          owner: wallet.getPublicKey(),
          uiTokenAmount: { amount: largeRawAmount }
        }]
      }
    })
  };

  const delta = await wallet.getReceivedTokenDeltaAtomic('txBigInt', 'BigIntMint');
  assert.equal(delta, largeRawAmount);
});

test('SolanaRpcInstrumentation: 20. Nenhuma alteração na validação financeira de risco (10%)', () => {
  const kp = Keypair.generate();
  const secretKeyRaw = JSON.stringify(Array.from(kp.secretKey));
  const wallet = new SolanaWalletService({ secretKeyRaw });

  // 10% de 2.0 SOL = 0.20 SOL
  assert.equal(wallet.validateTradeAllocation(0.20, 2.0).allowed, true);
  assert.equal(wallet.validateTradeAllocation(0.21, 2.0).allowed, false);
});

test('SolanaRpcInstrumentation: 13. Benchmark local controlado (mock) de chamadas RPC instrumentadas', async () => {
  globalTelemetryBuffer.clear();
  const kp = Keypair.generate();
  const secretKeyRaw = JSON.stringify(Array.from(kp.secretKey));
  const wallet = new SolanaWalletService({
    secretKeyRaw,
    rpcUrl: 'https://mainnet.helius-rpc.com/?api-key=mock-key'
  });

  (wallet as any).connection = {
    getBalance: async () => {
      await new Promise(r => setTimeout(r, 12));
      return 2_000_000_000;
    },
    getParsedTransaction: async () => {
      await new Promise(r => setTimeout(r, 18));
      return { slot: 290001, meta: null };
    }
  };

  await wallet.getBalanceSol();
  await wallet.getReceivedTokenDeltaAtomic('benchTx', 'benchMint');

  const spans = globalTelemetryBuffer.flush();
  const balSpan = spans.find(s => s.metadata?.method === 'getBalance');
  const txSpan = spans.find(s => s.metadata?.method === 'getParsedTransaction');

  assert.ok(balSpan);
  assert.ok(txSpan);

  console.log('\n--- BENCHMARK LOCAL CONTROLADO (MOCK RPC) ---');
  console.log(`provider = ${balSpan.providerAlias} | method = ${balSpan.metadata?.method} | duration = ${balSpan.durationMs.toFixed(2)} ms`);
  console.log(`provider = ${txSpan.providerAlias} | method = ${txSpan.metadata?.method} | duration = ${txSpan.durationMs.toFixed(2)} ms`);
  console.log('---------------------------------------------\n');
});
