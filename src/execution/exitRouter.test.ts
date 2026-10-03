import assert from 'node:assert/strict';
import test from 'node:test';
import { ExitRouter, type RoutedExitAttempt } from './exitRouter.js';

function attempt(
  status: RoutedExitAttempt['status'],
  overrides: Partial<RoutedExitAttempt> = {}
): RoutedExitAttempt {
  return {
    status,
    txSignature: '',
    inAmount: 1_000,
    outAmount: 0,
    error: status === 'FAILED' ? 'route unavailable' : undefined,
    ...overrides
  };
}

test('Jupiter success is final and never calls Pump fallback', async () => {
  let pumpCalls = 0;
  const router = new ExitRouter({ pumpFallbackEnabled: true });
  const routed = await router.routeAfterJupiter(
    attempt('SUCCESS', { txSignature: 'jup_sig', outAmount: 900 }),
    async () => {
      pumpCalls++;
      return attempt('SUCCESS', { txSignature: 'pump_sig' });
    }
  );

  assert.equal(routed.path, 'JUPITER');
  assert.equal(routed.result.txSignature, 'jup_sig');
  assert.equal(pumpCalls, 0);
});

test('definitive Jupiter failure can fall back to Pump SELL when enabled', async () => {
  let pumpCalls = 0;
  const router = new ExitRouter({ pumpFallbackEnabled: true });
  const routed = await router.routeAfterJupiter(
    attempt('FAILED'),
    async () => {
      pumpCalls++;
      return attempt('SUCCESS', { txSignature: 'pump_sig', outAmount: 850 });
    }
  );

  assert.equal(routed.path, 'PUMP_DIRECT');
  assert.equal(routed.result.status, 'SUCCESS');
  assert.equal(routed.result.txSignature, 'pump_sig');
  assert.equal(routed.fallbackReason, 'JUPITER_DEFINITIVE_FAILURE');
  assert.equal(pumpCalls, 1);
});

test('uncertain Jupiter submission blocks Pump fallback to prevent duplicate sale', async () => {
  let pumpCalls = 0;
  const router = new ExitRouter({ pumpFallbackEnabled: true });
  const routed = await router.routeAfterJupiter(
    attempt('SUBMITTED_UNCONFIRMED', { error: 'uncertain request' }),
    async () => {
      pumpCalls++;
      return attempt('SUCCESS', { txSignature: 'pump_sig' });
    }
  );

  assert.equal(routed.path, 'JUPITER');
  assert.equal(routed.result.status, 'SUBMITTED_UNCONFIRMED');
  assert.equal(routed.fallbackReason, 'JUPITER_UNCERTAIN_BLOCKS_FALLBACK');
  assert.equal(pumpCalls, 0);
});

test('both unavailable leaves exit failed and position must remain open', async () => {
  const router = new ExitRouter({ pumpFallbackEnabled: true });
  const routed = await router.routeAfterJupiter(
    attempt('FAILED', { error: 'jupiter unavailable' }),
    async () => attempt('FAILED', { error: 'curve complete' })
  );

  assert.equal(routed.path, 'PUMP_DIRECT');
  assert.equal(routed.result.status, 'FAILED');
  assert.match(routed.result.error || '', /curve complete/i);
});

test('disabled fallback never calls Pump after Jupiter failure', async () => {
  let pumpCalls = 0;
  const router = new ExitRouter({ pumpFallbackEnabled: false });
  const routed = await router.routeAfterJupiter(attempt('FAILED'), async () => {
    pumpCalls++;
    return attempt('SUCCESS');
  });

  assert.equal(routed.path, 'JUPITER');
  assert.equal(routed.fallbackReason, 'PUMP_FALLBACK_DISABLED');
  assert.equal(pumpCalls, 0);
});
