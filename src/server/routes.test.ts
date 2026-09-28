import test from 'node:test';
import assert from 'node:assert';
import { handleApiRoutes } from './routes.js';

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
  const mockReq = { url: '/api/positions/TestMint123/exit', method: 'POST', headers: {} } as any;
  let statusCode = 0;
  let responseData = '';

  const mockRes = {
    writeHead: (code: number) => { statusCode = code; },
    end: (data: string) => { responseData = data; }
  } as any;

  let exitCalledWith = '';
  const mockContext = {
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
  const mockReq = { url: '/api/positions/liquidate-all', method: 'POST', headers: {} } as any;
  let statusCode = 0;
  let responseData = '';

  const mockRes = {
    writeHead: (code: number) => { statusCode = code; },
    end: (data: string) => { responseData = data; }
  } as any;

  const liquidatedMints: string[] = [];
  const mockContext = {
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
  mockReq.headers = {};

  let statusCode = 0;
  let responseData = '';
  const mockRes = {
    writeHead: (code: number) => { statusCode = code; },
    end: (data: string) => { responseData = data; }
  } as any;

  let receivedPayload: any = null;
  const mockContext = {
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

