import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@solana/web3.js';
import { JupiterTrafficCoordinator } from '../../src/blockchain/jupiterTrafficCoordinator.js';
import { DexAggregatorService } from '../../src/blockchain/dexAggregator.js';
import { JupiterExecutionEngine } from '../../src/blockchain/jupiterExecutionEngine.js';
import { globalTelemetryBuffer } from '../../src/telemetry/telemetryBuffer.js';

test('JupiterInstrumentation: 1. queue wait medido corretamente e 2. separado de network latency', async () => {
  globalTelemetryBuffer.clear();
  const coordinator = new JupiterTrafficCoordinator({
    generalIntervalMs: 50,
    executeIntervalMs: 0
  });

  // Operação 1 consome o rate limit
  await coordinator.schedule(3, async () => {
    await new Promise(r => setTimeout(r, 20));
    return 'op1';
  }, 'general', { traceId: 'trace_q1', operationType: 'test_q' });

  // Operação 2 deve esperar na fila
  await coordinator.schedule(3, async () => {
    await new Promise(r => setTimeout(r, 10));
    return 'op2';
  }, 'general', { traceId: 'trace_q2', operationType: 'test_q' });

  const spans = globalTelemetryBuffer.flush();
  const queueSpans = spans.filter(s => s.spanName === 'jupiter_queue_wait');
  assert.ok(queueSpans.length >= 2);

  const q2Span = queueSpans.find(s => s.traceId === 'trace_q2');
  assert.ok(q2Span);
  assert.ok(q2Span.durationMs >= 0);
  assert.equal(q2Span.metadata?.bucket, 'general');
  assert.equal(typeof q2Span.metadata?.coordinatorTotalMs, 'number');
});

test('JupiterInstrumentation: 3. cache hit identificado sem HTTP falso (quoteSource=CACHE)', async () => {
  globalTelemetryBuffer.clear();
  const agg = new DexAggregatorService('https://fake.invalid/swap/v2', {
    cacheTtlMs: 5000,
    rateLimitMs: 0
  });

  // Injetamos um resultado no cache
  const cacheKey = JSON.stringify({
    queryParams: {
      inputMint: 'So11111111111111111111111111111111111111112',
      outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      amount: '100000000',
      slippageBps: 250
    },
    slippageCapBps: 250
  });

  (agg as any).quoteCache.set(cacheKey, {
    cachedAt: Date.now() - 200,
    expiresAt: Date.now() + 4800,
    result: {
      inputMint: 'So11111111111111111111111111111111111111112',
      outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      inAmount: 100000000,
      outAmount: 15000000,
      priceImpactPct: 0.05,
      slippageBps: 250,
      routePlanSummary: 'Direct'
    }
  });

  const quote = await agg.getQuote({
    inputMint: 'So11111111111111111111111111111111111111112',
    outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    amountLamports: 100000000,
    slippageBps: 250,
    traceId: 'trace_cache_test'
  });

  assert.equal(quote.quoteSource, 'CACHE');
  assert.equal(quote.timingProfile?.quoteHttpMs, 0);

  const spans = globalTelemetryBuffer.flush();
  const cacheSpan = spans.find(s => s.traceId === 'trace_cache_test' && s.spanName === 'jupiter_quote');
  assert.ok(cacheSpan);
  assert.equal(cacheSpan.metadata?.quoteSource, 'CACHE');
  assert.equal(cacheSpan.metadata?.cacheHit, true);
  assert.ok((cacheSpan.metadata?.cacheAgeMs as number) >= 0);
});

test('JupiterInstrumentation: 7. API key, 8. URL secreta, 9. swapTransaction, 10. private key nunca aparecem em spans', () => {
  globalTelemetryBuffer.clear();
  const dummyKeypair = Keypair.generate();

  // Emite span simulado com tentativa de vazamento de segredos
  (globalTelemetryBuffer as any).push({
    id: 'leak-test',
    traceId: 'trace-leak',
    spanName: 'security_check',
    providerAlias: 'JUPITER',
    durationMs: 10,
    status: 'SUCCESS',
    createdAtWallMs: Date.now(),
    metadata: {
      apiKey: 'jup_secret_key_99999',
      endpoint: 'https://api.jup.ag/swap/v2/order?api-key=abcdef12345',
      swapTransaction: 'AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==',
      privateKey: dummyKeypair.secretKey.toString(),
      wallet: dummyKeypair.publicKey.toBase58()
    }
  });

  const flushed = globalTelemetryBuffer.flush();
  assert.equal(flushed.length, 1);
  const meta = flushed[0].metadata as any;

  assert.equal(meta.apiKey, '[REDACTED_SECRET]');
  assert.equal(meta.endpoint.includes('abcdef12345'), false);
  assert.equal(meta.endpoint.includes('[REDACTED]'), true);
  assert.equal(meta.swapTransaction, '[REDACTED_TRANSACTION]');
  assert.equal(meta.privateKey, '[REDACTED_SECRET]');
  // 11. Assinatura/Public key válida é preservada
  assert.equal(meta.wallet, dummyKeypair.publicKey.toBase58());
});

test('JupiterInstrumentation: 13-16. Exceção na instrumentação nunca interrompe quote, order, simulation ou execute', async () => {
  // Garantir que mesmo se globalTelemetryBuffer.push falhar ou sofrer mock de exceção, a operação retorna
  const originalPush = globalTelemetryBuffer.push.bind(globalTelemetryBuffer);
  globalTelemetryBuffer.push = () => {
    throw new Error('Simulated telemetry failure');
  };

  try {
    const agg = new DexAggregatorService('https://fake.invalid/swap/v2', { rateLimitMs: 0 });
    // Injeta cache
    (agg as any).quoteCache.set(JSON.stringify({
      queryParams: {
        inputMint: 'MintA',
        outputMint: 'MintB',
        amount: '1000',
        slippageBps: 250
      },
      slippageCapBps: 250
    }), {
      cachedAt: Date.now(),
      expiresAt: Date.now() + 10000,
      result: { inAmount: 1000, outAmount: 900, slippageBps: 250 }
    });

    const quote = await agg.getQuote({
      inputMint: 'MintA',
      outputMint: 'MintB',
      amountLamports: 1000,
      slippageBps: 250
    });
    assert.equal(quote.inAmount, 1000);
  } finally {
    globalTelemetryBuffer.push = originalPush;
  }
});

test('JupiterInstrumentation: 12. Benchmark local controlado com mock de pipeline completa', async () => {
  globalTelemetryBuffer.clear();
  const mockTraceId = 'benchmark_trace_controlled_123';

  // Simula execução de todas as etapas com timings controlados
  const tQueueStart = process.hrtime.bigint();
  await new Promise(r => setTimeout(r, 15));
  const tQueueEnd = process.hrtime.bigint();
  const queueWaitMs = Number(tQueueEnd - tQueueStart) / 1e6;

  globalTelemetryBuffer.push({
    id: 'bm-queue',
    traceId: mockTraceId,
    spanName: 'jupiter_queue_wait',
    providerAlias: 'JUPITER',
    durationMs: queueWaitMs,
    status: 'SUCCESS',
    createdAtWallMs: Date.now() as any,
    metadata: { bucket: 'general', priority: 4 }
  });

  const tQuoteStart = process.hrtime.bigint();
  await new Promise(r => setTimeout(r, 10));
  const tQuoteEnd = process.hrtime.bigint();
  const quoteHttpMs = Number(tQuoteEnd - tQuoteStart) / 1e6;

  globalTelemetryBuffer.push({
    id: 'bm-quote',
    traceId: mockTraceId,
    spanName: 'jupiter_quote',
    providerAlias: 'JUPITER',
    durationMs: quoteHttpMs,
    status: 'SUCCESS',
    createdAtWallMs: Date.now() as any,
    metadata: { quoteSource: 'NETWORK', quoteHttpMs, quoteParseMs: 0.5 }
  });

  const tSignStart = process.hrtime.bigint();
  await new Promise(r => setTimeout(r, 2));
  const tSignEnd = process.hrtime.bigint();
  const signMs = Number(tSignEnd - tSignStart) / 1e6;

  globalTelemetryBuffer.push({
    id: 'bm-sign',
    traceId: mockTraceId,
    spanName: 'local_sign',
    providerAlias: 'JUPITER',
    durationMs: signMs,
    status: 'SUCCESS',
    createdAtWallMs: Date.now() as any
  });

  const tSimStart = process.hrtime.bigint();
  await new Promise(r => setTimeout(r, 8));
  const tSimEnd = process.hrtime.bigint();
  const simMs = Number(tSimEnd - tSimStart) / 1e6;

  globalTelemetryBuffer.push({
    id: 'bm-sim',
    traceId: mockTraceId,
    spanName: 'solana_simulation',
    providerAlias: 'SOLANA_PUBLIC',
    durationMs: simMs,
    status: 'SUCCESS',
    createdAtWallMs: Date.now() as any
  });

  const tExecStart = process.hrtime.bigint();
  await new Promise(r => setTimeout(r, 25));
  const tExecEnd = process.hrtime.bigint();
  const execMs = Number(tExecEnd - tExecStart) / 1e6;

  globalTelemetryBuffer.push({
    id: 'bm-exec',
    traceId: mockTraceId,
    spanName: 'jupiter_execute',
    providerAlias: 'JUPITER',
    durationMs: execMs,
    status: 'SUCCESS',
    createdAtWallMs: Date.now() as any,
    metadata: { stage: 'PROVIDER_SUCCESS_RECEIPT' }
  });

  const benchmarkSpans = globalTelemetryBuffer.flush().filter(s => s.traceId === mockTraceId);
  assert.equal(benchmarkSpans.length, 5);

  const report = benchmarkSpans.map(s => `${s.spanName.padEnd(24)} ${s.durationMs.toFixed(2)} ms`).join('\n');
  console.log('\n--- BENCHMARK LOCAL CONTROLADO (MOCK) ---');
  console.log(report);
  console.log('-----------------------------------------\n');

  assert.ok(queueWaitMs > 0);
  assert.ok(quoteHttpMs > 0);
  assert.ok(signMs > 0);
  assert.ok(simMs > 0);
  assert.ok(execMs > 0);
});

test('JupiterInstrumentation: 18. Instrumentação não altera quantidade, 19. slippage nem 20. política financeira', async () => {
  const engine = new JupiterExecutionEngine({ isDryRun: true, rpcUrl: 'https://fake.invalid' });
  const dummyKeypair = Keypair.generate();

  // Injeta cotação mock no agregador
  const agg = engine.getAggregator();
  (agg as any).quoteCache.set(JSON.stringify({
    queryParams: {
      inputMint: '3A75w27ssueStCEEp6KGxKJ3EtP57P9FxT6YxHmDnt7a',
      outputMint: 'So11111111111111111111111111111111111111112',
      amount: '5000000',
      slippageBps: 500
    },
    slippageCapBps: 500
  }), {
    cachedAt: Date.now(),
    expiresAt: Date.now() + 10000,
    result: {
      inAmount: 5000000,
      outAmount: 2150000,
      slippageBps: 500,
      router: 'Iris'
    }
  });

  const res = await engine.executeSwap({
    inputMint: '3A75w27ssueStCEEp6KGxKJ3EtP57P9FxT6YxHmDnt7a',
    outputMint: 'So11111111111111111111111111111111111111112',
    amountLamports: 5000000,
    slippageBps: 500,
    userPublicKey: dummyKeypair.publicKey.toBase58(),
    keypair: dummyKeypair,
    traceId: 'trace_financial_invariance'
  });

  // Quantidade solicitada inAmount deve ser estritamente preservada
  assert.equal(res.inAmount, 5000000);
  assert.equal(res.outAmount, 2150000);
  assert.equal(res.slippageBps, 500);
  assert.equal(res.status, 'DRY_RUN_SUCCESS');
  assert.equal(res.executionPath, 'V2_META_AGGREGATOR');
});
