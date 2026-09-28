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
