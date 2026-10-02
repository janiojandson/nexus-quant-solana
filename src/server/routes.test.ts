import test from 'node:test';
import assert from 'node:assert';
import { handleApiRoutes } from './routes.js';

const TEST_ADMIN_TOKEN = 'unit-test-admin-token';

test('handleApiRoutes: deve responder 200 OK na rota /api/status', async () => {
  const mockReq = { url: '/api/status', method: 'GET', headers: {} } as any;
  let statusCode = 0;
  let headersSent: Record<string, any> = {};
  let responseData = '';

  const mockRes = {
    writeHead: (code: number, headers: any) => {
      statusCode = code;
      headersSent = headers;
    },
    end: (data: string) => {
      responseData = data;
    }
  } as any;

  const mockContext = {
    adminToken: TEST_ADMIN_TOKEN,
    latestState: {
      agent: 'NexusQuant-Solana-01',
      balanceSol: 0.15,
      positions: [],
      closedTrades: []
    }
  } as any;

  const handled = await handleApiRoutes(mockReq, mockRes, mockContext);
  assert.strictEqual(handled, true);
  assert.strictEqual(statusCode, 200);
  assert.ok(responseData.includes('NexusQuant-Solana-01'));
});

test('handleApiRoutes: deve responder 200 OK na rota /health', async () => {
  const mockReq = { url: '/health', method: 'GET', headers: {} } as any;
  let statusCode = 0;
  let responseData = '';

  const mockRes = {
    writeHead: (code: number, headers: any) => { statusCode = code; },
    end: (data: string) => { responseData = data; }
  } as any;

  const mockContext = {
    adminToken: TEST_ADMIN_TOKEN,
    latestState: {
      agent: 'NexusQuant-Solana-01',
      wallet: 'PhantomTestWallet',
      balanceSol: 0.15,
      positions: []
    }
  } as any;

  const handled = await handleApiRoutes(mockReq, mockRes, mockContext);
  assert.strictEqual(handled, true);
  assert.strictEqual(statusCode, 200);
  assert.ok(responseData.includes('ONLINE'));
});

test('handleApiRoutes: rota /api/holdings deve sanitizar e filtrar tokens com símbolo undefined ou vazio', async () => {
  const mockReq = { url: '/api/holdings', method: 'GET', headers: {} } as any;
  let statusCode = 0;
  let responseData = '';

  const mockRes = {
    writeHead: (code: number, headers: any) => { statusCode = code; },
    end: (data: string) => { responseData = data; }
  } as any;

  const mockContext = {
    adminToken: TEST_ADMIN_TOKEN,
    latestState: {
      walletHoldings: [
        { mint: 'MintValido111', symbol: 'GOOD', tokenAmount: 1000, decimals: 6 },
        { mint: 'MintInvalido222', symbol: 'undefined', tokenAmount: 500, decimals: 6 },
        { mint: '', symbol: 'NO_MINT', tokenAmount: 200, decimals: 6 },
        { mint: 'MintVazioSymbol333', symbol: '   ', tokenAmount: 300, decimals: 6 }
      ]
    }
  } as any;

  const handled = await handleApiRoutes(mockReq, mockRes, mockContext);
  assert.strictEqual(handled, true);
  assert.strictEqual(statusCode, 200);
  const parsed = JSON.parse(responseData);
  assert.strictEqual(parsed.length, 1);
  assert.strictEqual(parsed[0].symbol, 'GOOD');
});

test('handleApiRoutes: deve executar venda manual da posição via POST /api/positions/:mint/exit', async () => {
  const mockReq = { url: '/api/positions/TestMint123/exit', method: 'POST', headers: { authorization: `Bearer ${TEST_ADMIN_TOKEN}` } } as any;
  let statusCode = 0;
  let responseData = '';

  const mockRes = {
    writeHead: (code: number) => { statusCode = code; },
    end: (data: string) => { responseData = data; }
  } as any;

  let exitCalledWith = '';
  const mockContext = {
    adminToken: TEST_ADMIN_TOKEN,
    latestState: { positions: [] },
    executeExitOrder: async (mint: string) => {
      exitCalledWith = mint;
      return { success: true, txSignature: 'MockTxSignature123' };
    }
  } as any;

  const handled = await handleApiRoutes(mockReq, mockRes, mockContext);
  assert.strictEqual(handled, true);
  assert.strictEqual(statusCode, 200);
  assert.strictEqual(exitCalledWith, 'TestMint123');
  const resObj = JSON.parse(responseData);
  assert.strictEqual(resObj.success, true);
  assert.strictEqual(resObj.txSignature, 'MockTxSignature123');
});

test('handleApiRoutes: deve executar liquidação global via POST /api/positions/liquidate-all (Panic Button)', async () => {
  const mockReq = { url: '/api/positions/liquidate-all', method: 'POST', headers: { authorization: `Bearer ${TEST_ADMIN_TOKEN}` } } as any;
  let statusCode = 0;
  let responseData = '';

  const mockRes = {
    writeHead: (code: number) => { statusCode = code; },
    end: (data: string) => { responseData = data; }
  } as any;

  const liquidatedMints: string[] = [];
  const mockContext = {
    adminToken: TEST_ADMIN_TOKEN,
    latestState: { positions: [] },
    getAllOpenPositions: () => [
      { mint: 'MintA111', symbol: 'TOKEN_A' },
      { mint: 'MintB222', symbol: 'TOKEN_B' }
    ],
    executeExitOrder: async (mint: string) => {
      liquidatedMints.push(mint);
      return { success: true, txSignature: `Tx_${mint}` };
    }
  } as any;

  const handled = await handleApiRoutes(mockReq, mockRes, mockContext);
  assert.strictEqual(handled, true);
  assert.strictEqual(statusCode, 200);
  assert.deepStrictEqual(liquidatedMints, ['MintA111', 'MintB222']);
  const resObj = JSON.parse(responseData);
  assert.strictEqual(resObj.results.length, 2);
  assert.ok(resObj.message.includes('2 posições'));
});

test('handleApiRoutes: deve executar liquidação avulsa de holding via POST /api/wallet/liquidate-holding', async () => {
  const payload = JSON.stringify({
    mint: 'HoldingMint999',
    symbol: 'HOLDING',
    amount: 5000,
    decimals: 6
  });

  const { EventEmitter } = await import('node:events');
  const mockReq = new EventEmitter() as any;
  mockReq.url = '/api/wallet/liquidate-holding';
  mockReq.method = 'POST';
  mockReq.headers = { authorization: `Bearer ${TEST_ADMIN_TOKEN}` };

  let statusCode = 0;
  let responseData = '';
  const mockRes = {
    writeHead: (code: number) => { statusCode = code; },
    end: (data: string) => { responseData = data; }
  } as any;

  let receivedPayload: any = null;
  const mockContext = {
    adminToken: TEST_ADMIN_TOKEN,
    latestState: {},
    liquidateHolding: async (data: any) => {
      receivedPayload = data;
      return { success: true, txSignature: 'HoldingTxSignature999' };
    }
  } as any;

  const handledPromise = handleApiRoutes(mockReq, mockRes, mockContext);
  // Simula streaming do body
  mockReq.emit('data', Buffer.from(payload));
  mockReq.emit('end');

  const handled = await handledPromise;
  assert.strictEqual(handled, true);

  // Aguarda processamento do evento 'end'
  await new Promise(r => setTimeout(r, 50));
  assert.strictEqual(statusCode, 200);
  assert.strictEqual(receivedPayload.mint, 'HoldingMint999');
  const resObj = JSON.parse(responseData);
  assert.strictEqual(resObj.success, true);
  assert.strictEqual(resObj.txSignature, 'HoldingTxSignature999');
});

test('handleApiRoutes: deve acionar rota POST /api/wallet/sweep-rent com sucesso', async () => {
  const mockReq = { url: '/api/wallet/sweep-rent', method: 'POST', headers: { authorization: `Bearer ${TEST_ADMIN_TOKEN}` } } as any;
  let statusCode = 0;
  let responseData = '';
  const mockRes = {
    writeHead: (code: number) => { statusCode = code; },
    end: (data: string) => { responseData = data; }
  } as any;

  let sweepCalled = false;
  const mockContext = {
    adminToken: TEST_ADMIN_TOKEN,
    latestState: {},
    sweepRent: async () => {
      sweepCalled = true;
      return { closedCount: 2, reclaimedSolEst: 0.00408, errors: [] };
    }
  } as any;

  const handled = await handleApiRoutes(mockReq, mockRes, mockContext);
  assert.strictEqual(handled, true);
  assert.strictEqual(statusCode, 200);
  assert.strictEqual(sweepCalled, true);
  const resObj = JSON.parse(responseData);
  assert.strictEqual(resObj.success, true);
  assert.strictEqual(resObj.closedCount, 2);
  assert.strictEqual(resObj.reclaimedSolEst, 0.00408);
});

test('handleApiRoutes: deve executar POST /api/panic/:mint com sucesso', async () => {
  const mockReq = { url: '/api/panic/PanicMint777', method: 'POST', headers: { authorization: `Bearer ${TEST_ADMIN_TOKEN}` } } as any;
  let statusCode = 0;
  let responseData = '';
  const mockRes = {
    writeHead: (code: number) => { statusCode = code; },
    setHeader: () => {},
    end: (data: string) => { responseData = data; }
  } as any;

  let panicCalledWith = '';
  const mockContext = {
    adminToken: TEST_ADMIN_TOKEN,
    enableLegacyPanicApi: true,
    latestState: { positions: [] },
    panicToken: async (mint: string) => {
      panicCalledWith = mint;
      return { success: true, txid: 'PanicTx_777', message: 'Moeda liquidada e aluguel de ~0.00204 SOL recuperado.' };
    }
  } as any;

  const handled = await handleApiRoutes(mockReq, mockRes, mockContext);
  assert.strictEqual(handled, true);
  assert.strictEqual(statusCode, 200);
  assert.strictEqual(panicCalledWith, 'PanicMint777');
  const resObj = JSON.parse(responseData);
  assert.strictEqual(resObj.success, true);
  assert.strictEqual(resObj.txid, 'PanicTx_777');
  assert.ok(resObj.message.includes('0.00204 SOL'));
});

test('handleApiRoutes: deve executar POST /api/panic/all desarmando e liquidando tudo', async () => {
  const mockReq = { url: '/api/panic/all', method: 'POST', headers: { authorization: `Bearer ${TEST_ADMIN_TOKEN}` } } as any;
  let statusCode = 0;
  let responseData = '';
  const mockRes = {
    writeHead: (code: number) => { statusCode = code; },
    setHeader: () => {},
    end: (data: string) => { responseData = data; }
  } as any;

  let panicAllCalled = false;
  const mockContext = {
    adminToken: TEST_ADMIN_TOKEN,
    enableLegacyPanicApi: true,
    latestState: { circuitBreakerActive: false },
    panicAll: async () => {
      panicAllCalled = true;
      return { success: true, liquidationsCount: 3, message: 'Pânico geral executado com sucesso.' };
    }
  } as any;

  const handled = await handleApiRoutes(mockReq, mockRes, mockContext);
  assert.strictEqual(handled, true);
  assert.strictEqual(statusCode, 200);
  assert.strictEqual(panicAllCalled, true);
  const resObj = JSON.parse(responseData);
  assert.strictEqual(resObj.success, true);
  assert.strictEqual(resObj.liquidationsCount, 3);
  assert.strictEqual(resObj.message, 'Pânico geral executado com sucesso.');
});

test('handleApiRoutes: deve acionar rota POST /api/calibration/run com sucesso', async () => {
  const mockReq = { url: '/api/calibration/run', method: 'POST', headers: { authorization: `Bearer ${TEST_ADMIN_TOKEN}` } } as any;
  let statusCode = 0;
  let responseData = '';
  const mockRes = {
    writeHead: (code: number) => { statusCode = code; },
    setHeader: () => {},
    end: (data: string) => { responseData = data; }
  } as any;

  let calibrationCalled = false;
  const mockContext = {
    adminToken: TEST_ADMIN_TOKEN,
    latestState: {},
    runCalibration: async () => {
      calibrationCalled = true;
      return {
        totalTrades: 50,
        totalDecisions: 120,
        overallWinRate: 55.0,
        overallEV: 3.2,
        gateMetrics: [{ gateName: 'BUY_DOMINANCE', sampleSize: 50, winRate: 55, verdict: 'KEEP' }],
        latencyMetrics: [],
        warnings: []
      };
    }
  } as any;

  const handled = await handleApiRoutes(mockReq, mockRes, mockContext);
  assert.strictEqual(handled, true);
  assert.strictEqual(statusCode, 200);
  assert.strictEqual(calibrationCalled, true);
  const resObj = JSON.parse(responseData);
  assert.strictEqual(resObj.success, true);
  assert.strictEqual(resObj.mode, 'READ_ONLY');
  assert.strictEqual(resObj.summary.totalTrades, 50);
  assert.strictEqual(resObj.gates[0].gateName, 'BUY_DOMINANCE');
});

test('handleApiRoutes: deve responder snapshots na rota GET /api/calibration/snapshots', async () => {
  const mockReq = { url: '/api/calibration/snapshots?limit=10', method: 'GET', headers: {} } as any;
  let statusCode = 0;
  let responseData = '';
  const mockRes = {
    writeHead: (code: number) => { statusCode = code; },
    setHeader: () => {},
    end: (data: string) => { responseData = data; }
  } as any;

  const mockContext = {
    adminToken: TEST_ADMIN_TOKEN,
    latestState: {},
    getSnapshots: async (limit: number) => {
      assert.strictEqual(limit, 10);
      return [{ id: 'snap-1', gate_name: 'BUY_DOMINANCE', gate_verdict: 'KEEP' }];
    }
  } as any;

  const handled = await handleApiRoutes(mockReq, mockRes, mockContext);
  assert.strictEqual(handled, true);
  assert.strictEqual(statusCode, 200);
  const resObj = JSON.parse(responseData);
  assert.strictEqual(resObj.snapshots.length, 1);
  assert.strictEqual(resObj.snapshots[0].gate_name, 'BUY_DOMINANCE');
});




test('handleApiRoutes: deve rejeitar mutação sem bearer token antes de chamar executor', async () => {
  const mockReq = { url: '/api/panic/BlockedMint', method: 'POST', headers: {} } as any;
  let statusCode = 0;
  let responseData = '';
  let executorCalled = false;
  const mockRes = {
    writeHead: (code: number) => { statusCode = code; },
    end: (data: string) => { responseData = data; }
  } as any;
  const mockContext = {
    adminToken: TEST_ADMIN_TOKEN,
    latestState: {},
    panicToken: async () => {
      executorCalled = true;
      return { success: true };
    }
  } as any;

  const handled = await handleApiRoutes(mockReq, mockRes, mockContext);
  assert.strictEqual(handled, true);
  assert.strictEqual(statusCode, 401);
  assert.strictEqual(executorCalled, false);
  assert.strictEqual(JSON.parse(responseData).success, false);
});

test('handleApiRoutes: deve falhar fechado quando admin token não está configurado', async () => {
  const mockReq = {
    url: '/api/wallet/sweep-rent',
    method: 'POST',
    headers: { authorization: 'Bearer qualquer-token' }
  } as any;
  let statusCode = 0;
  let sweepCalled = false;
  const mockRes = {
    writeHead: (code: number) => { statusCode = code; },
    end: () => {}
  } as any;
  const mockContext = {
    adminToken: '',
    latestState: {},
    sweepRent: async () => {
      sweepCalled = true;
      return {};
    }
  } as any;

  await handleApiRoutes(mockReq, mockRes, mockContext);
  assert.strictEqual(statusCode, 503);
  assert.strictEqual(sweepCalled, false);
});

test('handleApiRoutes: CORS deve refletir somente origem explicitamente permitida', async () => {
  const headers: Record<string, string> = {};
  const mockReq = {
    url: '/health',
    method: 'GET',
    headers: { origin: 'https://ops.example' }
  } as any;
  const mockRes = {
    setHeader: (name: string, value: string) => { headers[name] = value; },
    writeHead: () => {},
    end: () => {}
  } as any;
  const mockContext = {
    latestState: { agent: 'test', wallet: 'wallet', balanceSol: 0, positions: [] },
    allowedCorsOrigins: ['https://ops.example', '*']
  } as any;

  await handleApiRoutes(mockReq, mockRes, mockContext);
  assert.strictEqual(headers['Access-Control-Allow-Origin'], 'https://ops.example');
  assert.strictEqual(headers['Vary'], 'Origin');
});

test('handleApiRoutes: legacy panic deve ficar desabilitado por padrão', async () => {
  const mockReq = {
    url: '/api/panic/LegacyMint',
    method: 'POST',
    headers: { authorization: `Bearer ${TEST_ADMIN_TOKEN}` }
  } as any;
  let statusCode = 0;
  let panicCalled = false;
  const mockRes = {
    writeHead: (code: number) => { statusCode = code; },
    end: () => {}
  } as any;
  const mockContext = {
    adminToken: TEST_ADMIN_TOKEN,
    latestState: {},
    panicToken: async () => {
      panicCalled = true;
      return { success: true };
    }
  } as any;

  await handleApiRoutes(mockReq, mockRes, mockContext);
  assert.strictEqual(statusCode, 503);
  assert.strictEqual(panicCalled, false);
});

test('handleApiRoutes: /api/positions/:mint/exit deve preferir executor seguro mesmo se panicToken existir', async () => {
  const mockReq = {
    url: '/api/positions/SafeMint/exit',
    method: 'POST',
    headers: { authorization: `Bearer ${TEST_ADMIN_TOKEN}` }
  } as any;
  let panicCalled = false;
  let exitCalled = false;
  const mockRes = { writeHead: () => {}, end: () => {} } as any;
  const mockContext = {
    adminToken: TEST_ADMIN_TOKEN,
    latestState: {},
    panicToken: async () => {
      panicCalled = true;
      return { success: true };
    },
    executeExitOrder: async () => {
      exitCalled = true;
      return { success: true, txSignature: 'safe-exit-tx' };
    }
  } as any;

  await handleApiRoutes(mockReq, mockRes, mockContext);
  assert.strictEqual(exitCalled, true);
  assert.strictEqual(panicCalled, false);
});

test('handleApiRoutes: /api/positions/liquidate-all não deve chamar panicAll legado', async () => {
  const mockReq = {
    url: '/api/positions/liquidate-all',
    method: 'POST',
    headers: { authorization: `Bearer ${TEST_ADMIN_TOKEN}` }
  } as any;
  let panicAllCalled = false;
  const exited: string[] = [];
  const mockRes = { writeHead: () => {}, end: () => {} } as any;
  const mockContext = {
    adminToken: TEST_ADMIN_TOKEN,
    latestState: { circuitBreakerActive: false },
    panicAll: async () => {
      panicAllCalled = true;
      return { success: true, liquidationsCount: 99 };
    },
    getAllOpenPositions: () => [{ mint: 'SafeA', symbol: 'A' }],
    executeExitOrder: async (mint: string) => {
      exited.push(mint);
      return { success: true, txSignature: 'safe-all-tx' };
    }
  } as any;

  await handleApiRoutes(mockReq, mockRes, mockContext);
  assert.strictEqual(panicAllCalled, false);
  assert.deepStrictEqual(exited, ['SafeA']);
});
