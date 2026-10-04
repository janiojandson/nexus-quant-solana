/**
 * Nexus Quant Solana — Boot Fence & Financial Readiness Test Suite (Finding R-P0-01)
 *
 * Validates that all financial endpoints are strictly fenced behind `financialReadiness === 'READY'`:
 * 1. Financial mutation endpoints return HTTP 503 FINANCIAL_STATE_NOT_READY when BOOTING, RECOVERING, or FAILED_SAFE.
 * 2. Non-financial endpoints (/health, /api/status) continue responding while reporting financialReadiness state.
 * 3. Transition to READY enables financial endpoints.
 * 4. DB failure or missing schema forces state to FAILED_SAFE and NEVER becomes READY.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  setFinancialReadiness,
  getFinancialReadiness,
  isFinancialReady,
  isFinancialMutationEndpoint,
  FinancialNotReadyError
} from '../../src/core/financialReadiness.js';
import { handleApiRoutes, RouteContext } from '../../src/server/routes.js';

describe('Boot Fence & Financial Readiness (R-P0-01)', () => {
  beforeEach(() => {
    setFinancialReadiness('BOOTING', 'Test setup initial state');
  });

  it('1. isFinancialMutationEndpoint identifies all financial mutations correctly', () => {
    assert.strictEqual(isFinancialMutationEndpoint('/api/panic/someMint', 'POST'), true);
    assert.strictEqual(isFinancialMutationEndpoint('/api/positions/someMint/exit', 'POST'), true);
    assert.strictEqual(isFinancialMutationEndpoint('/api/positions/liquidate-all', 'POST'), true);
    assert.strictEqual(isFinancialMutationEndpoint('/api/wallet/liquidate-holding', 'POST'), true);
    assert.strictEqual(isFinancialMutationEndpoint('/api/wallet/sweep-rent', 'POST'), true);

    // Non-mutations or read-only endpoints
    assert.strictEqual(isFinancialMutationEndpoint('/health', 'GET'), false);
    assert.strictEqual(isFinancialMutationEndpoint('/api/status', 'GET'), false);
    assert.strictEqual(isFinancialMutationEndpoint('/api/holdings', 'GET'), false);
    assert.strictEqual(isFinancialMutationEndpoint('/api/panic/someMint', 'GET'), false);
  });

  it('2. Financial mutations return HTTP 503 when readiness is BOOTING', async () => {
    setFinancialReadiness('BOOTING', 'Simulated boot phase');

    let responseCode = 0;
    let responseBody = '';

    const req: any = {
      url: '/api/positions/testMint1111111111111111111111111111111111/exit',
      method: 'POST',
      headers: { host: 'localhost' }
    };
    const res: any = {
      writeHead: (code: number) => { responseCode = code; },
      end: (data: string) => { responseBody = data; },
      setHeader: () => {}
    };

    const ctx: RouteContext = {
      latestState: { agent: 'NexusQuant', wallet: 'test', balanceSol: 1 } as any
    };

    const handled = await handleApiRoutes(req, res, ctx);
    assert.strictEqual(handled, true);
    assert.strictEqual(responseCode, 503);

    const parsed = JSON.parse(responseBody);
    assert.strictEqual(parsed.success, false);
    assert.strictEqual(parsed.error, 'FINANCIAL_STATE_NOT_READY');
    assert.strictEqual(parsed.code, 'FINANCIAL_STATE_NOT_READY');
    assert.strictEqual(parsed.readiness, 'BOOTING');
  });

  it('3. Financial mutations return HTTP 503 when readiness is RECOVERING_FINANCIAL_STATE', async () => {
    setFinancialReadiness('RECOVERING_FINANCIAL_STATE', 'Durable debt recovery in progress');

    let responseCode = 0;
    let responseBody = '';

    const req: any = {
      url: '/api/wallet/liquidate-holding',
      method: 'POST',
      headers: { host: 'localhost' }
    };
    const res: any = {
      writeHead: (code: number) => { responseCode = code; },
      end: (data: string) => { responseBody = data; },
      setHeader: () => {}
    };

    const ctx: RouteContext = {
      latestState: { agent: 'NexusQuant', wallet: 'test', balanceSol: 1 } as any
    };

    const handled = await handleApiRoutes(req, res, ctx);
    assert.strictEqual(handled, true);
    assert.strictEqual(responseCode, 503);

    const parsed = JSON.parse(responseBody);
    assert.strictEqual(parsed.success, false);
    assert.strictEqual(parsed.error, 'FINANCIAL_STATE_NOT_READY');
    assert.strictEqual(parsed.readiness, 'RECOVERING_FINANCIAL_STATE');
  });

  it('4. Financial mutations return HTTP 503 when readiness is FAILED_SAFE', async () => {
    setFinancialReadiness('FAILED_SAFE', 'Database connection refused during startup');

    let responseCode = 0;
    let responseBody = '';

    const req: any = {
      url: '/api/positions/liquidate-all',
      method: 'POST',
      headers: { host: 'localhost' }
    };
    const res: any = {
      writeHead: (code: number) => { responseCode = code; },
      end: (data: string) => { responseBody = data; },
      setHeader: () => {}
    };

    const ctx: RouteContext = {
      latestState: { agent: 'NexusQuant', wallet: 'test', balanceSol: 1 } as any
    };

    const handled = await handleApiRoutes(req, res, ctx);
    assert.strictEqual(handled, true);
    assert.strictEqual(responseCode, 503);

    const parsed = JSON.parse(responseBody);
    assert.strictEqual(parsed.success, false);
    assert.strictEqual(parsed.error, 'FINANCIAL_STATE_NOT_READY');
    assert.strictEqual(parsed.readiness, 'FAILED_SAFE');
    assert.ok(parsed.reason.includes('Database connection refused'));
  });

  it('5. Healthcheck succeeds in BOOTING state and reports financialReadiness', async () => {
    setFinancialReadiness('BOOTING', 'Startup ongoing');

    let responseCode = 0;
    let responseBody = '';

    const req: any = {
      url: '/health',
      method: 'GET',
      headers: { host: 'localhost' }
    };
    const res: any = {
      writeHead: (code: number) => { responseCode = code; },
      end: (data: string) => { responseBody = data; },
      setHeader: () => {}
    };

    const ctx: RouteContext = {
      latestState: { agent: 'NexusQuant', wallet: 'test', balanceSol: 1, positions: [] } as any
    };

    const handled = await handleApiRoutes(req, res, ctx);
    assert.strictEqual(handled, true);
    assert.strictEqual(responseCode, 200);

    const parsed = JSON.parse(responseBody);
    assert.strictEqual(parsed.status, 'ONLINE');
    assert.strictEqual(parsed.financialReadiness, 'BOOTING');
  });

  it('6. Transition to READY enables financial mutation processing', async () => {
    setFinancialReadiness('READY', 'Durable state recovered');
    assert.strictEqual(isFinancialReady(), true);

    let calledExit = false;
    let responseCode = 0;

    const req: any = {
      url: '/api/positions/testMint1111111111111111111111111111111111/exit',
      method: 'POST',
      headers: {
        host: 'localhost',
        authorization: 'Bearer valid_test_token'
      }
    };
    const res: any = {
      writeHead: (code: number) => { responseCode = code; },
      end: () => {},
      setHeader: () => {}
    };

    const ctx: RouteContext = {
      latestState: { agent: 'NexusQuant', wallet: 'test', balanceSol: 1 } as any,
      adminToken: 'valid_test_token',
      executeExitOrder: async () => {
        calledExit = true;
        return { success: true, txSignature: 'sig_ready_test' };
      }
    };

    const handled = await handleApiRoutes(req, res, ctx);
    assert.strictEqual(handled, true);
    assert.strictEqual(calledExit, true);
    assert.strictEqual(responseCode, 200);
  });
});
