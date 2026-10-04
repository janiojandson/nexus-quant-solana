/**
 * Nexus Quant Solana — Missão V2.3-R2
 * Adversarial Regression Suite: V2 Gate, Custody Checks & Strict Flag Parsing (Commit R2-7)
 *
 * Covers:
 * - FASE 13: parseStrictBooleanEnv throws INVALID_BOOLEAN_ENV on 'TRUE', 'true ', '1'
 * - FASE 7 & 8: DispatchReservationManager expiration does NOT release exposure if durable debt exists
 * - FASE 15: Wire evaluatePreSendVersionGate and reconcilePositionCustody when flags = 111
 */

import test from 'node:test';
import assert from 'node:assert';
import { parseStrictBooleanEnv, InvalidBooleanEnvError } from '../../src/core/strictEnv.js';
import {
  DispatchReservationManager,
  DispatchReservationConflictError,
  evaluatePreSendVersionGate,
  revalidateCustodyAndEvaluateGate
} from '../../src/position/versionGate.js';
import {
  validateFeatureFlagMatrix,
  InvalidFeatureFlagCombinationError
} from '../../src/position/shadowPosition.js';
import { InMemoryPositionRepository } from '../../src/position/repository.js';
import { bindExecutionQuote, BoundExecutionQuote } from '../../src/position/quoteBinding.js';
import { takePositionSnapshot } from '../../src/position/types.js';
import { Keypair } from '@solana/web3.js';

test('Nexus V2.3-R2 — Strict Boolean Env, Dispatch Reservations & V2 Gate', async (t) => {
  // 1. FASE 13: Strict Boolean Parsing
  await t.test('FASE 13: parseStrictBooleanEnv strictly rejects non-exact boolean strings', () => {
    // Valid values
    assert.strictEqual(parseStrictBooleanEnv('TEST_VAR', 'true'), true);
    assert.strictEqual(parseStrictBooleanEnv('TEST_VAR', 'false'), false);
    assert.strictEqual(parseStrictBooleanEnv('TEST_VAR', ''), false);
    assert.strictEqual(parseStrictBooleanEnv('TEST_VAR', undefined), false);

    // Invalid values that must throw INVALID_BOOLEAN_ENV
    const invalidValues = [
      'TRUE',
      'True',
      'true ',
      ' true',
      '1',
      '0',
      'yes',
      'no',
      'on',
      'off',
      'FALSE'
    ];

    for (const val of invalidValues) {
      assert.throws(
        () => parseStrictBooleanEnv('NEXUS_TEST_FLAG', val),
        (err: any) => {
          assert.ok(err instanceof InvalidBooleanEnvError);
          assert.ok(err.message.includes('INVALID_BOOLEAN_ENV'), `Expected INVALID_BOOLEAN_ENV in ${err.message}`);
          return true;
        },
        `Failed to reject invalid boolean value '${val}'`
      );
    }
  });

  // 2. FASE 7 & 8: DispatchReservationManager with Durable Debt retention
  await t.test('FASE 7 & 8: Dispatch reservation expiration does NOT release exposure if durable debt exists', async () => {
    const mgr = new DispatchReservationManager(50); // 50ms timeout
    const positionId = 'pos_reservation_test_1';

    // Case A: Normal reservation without debt expires after 50ms
    const receipt1 = mgr.reserve({
      positionId,
      expectedVersion: 1n,
      intentId: 'intent_normal_1'
    });
    assert.ok(receipt1);

    // Immediate re-reservation is blocked
    assert.throws(
      () => mgr.reserve({ positionId, expectedVersion: 1n }),
      DispatchReservationConflictError
    );

    // Wait 60ms for timeout
    await new Promise(resolve => setTimeout(resolve, 60));

    // After timeout, reservation expired cleanly without debt
    const receipt2 = mgr.reserve({
      positionId,
      expectedVersion: 1n,
      intentId: 'intent_normal_2'
    });
    assert.ok(receipt2);
    receipt2.release();

    // Case B: Reservation with durable debt active DOES NOT expire after timeout
    const debtReceipt = mgr.reserve({
      positionId,
      expectedVersion: 1n,
      intentId: 'intent_debt_active',
      hasDurableDebt: true
    });
    assert.ok(debtReceipt);

    // Wait 60ms for timeout to pass
    await new Promise(resolve => setTimeout(resolve, 60));

    // Even though timeout expired, hasDurableDebt=true blocks subsequent reservation!
    assert.throws(
      () => mgr.reserve({ positionId, expectedVersion: 1n }),
      (err: any) => {
        assert.ok(err instanceof DispatchReservationConflictError);
        assert.ok(err.message.includes('active durable debt'), `Expected durable debt mention, got: ${err.message}`);
        return true;
      }
    );

    // External debt checker also protects reservations with in-flight chain attempts
    const mgrWithChecker = new DispatchReservationManager(50);
    const activeDebtIntents = new Set<string>(['intent_inflight_999']);
    mgrWithChecker.setDurableDebtChecker((intentId: string) => activeDebtIntents.has(intentId));

    mgrWithChecker.reserve({
      positionId: 'pos_checked_1',
      expectedVersion: 1n,
      intentId: 'intent_inflight_999'
    });

    await new Promise(resolve => setTimeout(resolve, 60));

    // Timeout expired, but checker reports active debt -> STILL BLOCKED
    assert.throws(
      () => mgrWithChecker.reserve({ positionId: 'pos_checked_1', expectedVersion: 1n }),
      DispatchReservationConflictError
    );

    // Clear debt -> reservation now expires
    activeDebtIntents.clear();
    const freedReceipt = mgrWithChecker.reserve({ positionId: 'pos_checked_1', expectedVersion: 1n });
    assert.ok(freedReceipt);
    freedReceipt.release();
  });

  // 3. FASE 15: Wire evaluatePreSendVersionGate and reconcilePositionCustody
  await t.test('FASE 15: Pre-send version gate and custody reconciliation evaluate correctly', async () => {
    const repo = new InMemoryPositionRepository();
    const walletId = Keypair.generate().publicKey.toBase58();
    const mint = Keypair.generate().publicKey.toBase58();

    const pos = await repo.createPosition({
      positionId: 'pos_gate_test',
      tradeId: 'trade_gate_test',
      walletId,
      mint,
      initialAmountAtomic: 1000n,
      initialPrincipalLamports: 1_000_000n
    });

    const snapshot = takePositionSnapshot(pos);
    const boundQuote = bindExecutionQuote({
      snapshot,
      requestedAmountAtomic: 1000n,
      quoteSource: 'JUPITER',
      outAmountLamports: 1_000_000n,
      slippageBps: 500
    });

    // Valid gate evaluation
    const validDecision = evaluatePreSendVersionGate({
      currentPosition: snapshot,
      boundQuote,
      intentPolicy: 'FULL_REMAINDER',
      intendedAmountAtomic: 1000n
    });
    assert.strictEqual(validDecision.allowed, true);

    // External custody reconciliation bumps position version
    const custodyDecision = await revalidateCustodyAndEvaluateGate({
      positionRepo: repo,
      positionId: pos.positionId,
      boundQuote, // bound to version 1n
      intentPolicy: 'FULL_REMAINDER',
      observedAtaBalanceAtomic: 800n, // external burn or transfer of 200 tokens
      evidence: {
        source: 'RPC_GET_TOKEN_ACCOUNTS_BY_OWNER',
        reason: 'Pre-send custody reconciliation detected on-chain delta',
        observedSlot: 100_000n
      },
      intendedAmountAtomic: 1000n
    });

    // Version bumped to 2n -> stale quote is strictly rejected!
    assert.strictEqual(custodyDecision.allowed, false);
    assert.strictEqual(custodyDecision.code, 'QUOTE_STALE_FOR_POSITION');

    // Fresh position has updated version 2n and 800n amount
    const freshPos = await repo.getPosition(pos.positionId);
    assert.strictEqual(freshPos?.positionVersion, 2n);
    assert.strictEqual(freshPos?.tokenAmountAtomic, 800n);
  });
});
