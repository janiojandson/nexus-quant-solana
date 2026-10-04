import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  reconcileExecutionAttempt,
  WalletTransactionReconciler,
  ReconciledAttemptResult
} from '../../src/reconciliation/executionReconciler.js';
import { ExecutionAttempt, ExitIntent } from '../../src/journal/types.js';

describe('Exact Signature Reconciliation (Finding R-P0-03 & Phase 19)', () => {
  const dummyIntent: ExitIntent = {
    id: 'intent-audit-001',
    tradeId: 'trade-audit-001',
    positionId: 'pos-audit-001',
    walletId: 'WalletOwner11111111111111111111111111111111',
    mint: 'MintToken111111111111111111111111111111111',
    tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    positionVersion: 1,
    requestedAmountAtomic: '500000000',
    amountPolicy: 'FULL',
    economicDedupeKey: 'dedupe-001',
    initialSeverity: 'HIGH',
    currentSeverity: 'HIGH',
    severityAuditTrail: [],
    reason: 'STOP_LOSS',
    policyVersion: 'v2.3',
    claimEpoch: 1n,
    expiresAtWallMs: Date.now() + 60_000
  };

  it('R-P0-03.4: returns UNKNOWN if attempt has no signature (insufficient identity)', async () => {
    const attempt: ExecutionAttempt = {
      attemptId: 'att-no-sig',
      intentId: dummyIntent.id,
      provider: 'JUPITER_V2',
      requestedAmountAtomic: '500000000',
      state: 'UNKNOWN',
      startedAtWallMs: Date.now()
    };

    let rpcCalled = false;
    const mockReconciler: WalletTransactionReconciler = {
      reconcileExactTransaction: async () => {
        rpcCalled = true;
        return null;
      }
    };

    const res = await reconcileExecutionAttempt({
      attempt,
      intent: dummyIntent,
      walletReconciler: mockReconciler
    });

    assert.equal(res.status, 'UNKNOWN');
    assert.equal(rpcCalled, false, 'Must not query RPC when signature is missing');
    assert.match(res.reason || '', /INSUFFICIENT_IDENTITY/);
  });

  it('R-P0-03.2: confirms attempt when exact signature succeeded and debited expected mint', async () => {
    const attempt: ExecutionAttempt = {
      attemptId: 'att-valid-sig',
      intentId: dummyIntent.id,
      provider: 'JUPITER_V2',
      signature: '5KnpSignatureValid1111111111111111111111111111111111111111111111111111111111111111111',
      requestedAmountAtomic: '500000000',
      state: 'UNKNOWN',
      startedAtWallMs: Date.now()
    };

    const mockReconciler: WalletTransactionReconciler = {
      reconcileExactTransaction: async (params) => {
        assert.equal(params.signature, attempt.signature);
        assert.equal(params.mintAddress, dummyIntent.mint);
        assert.equal(params.expectedOwner, dummyIntent.walletId);
        assert.equal(params.direction, 'OUT');

        return {
          signature: params.signature,
          deltaAtomic: '-500000000',
          walletLamportDelta: 95000000,
          feeLamports: 5000,
          blockTimeMs: 1728000000000,
          success: true
        };
      }
    };

    const res = await reconcileExecutionAttempt({
      attempt,
      intent: dummyIntent,
      walletReconciler: mockReconciler
    });

    assert.equal(res.status, 'CONFIRMED');
    assert.equal(res.actualDebitAtomic, 500000000n);
    assert.equal(res.grossProceedsLamports, 95005000n);
    assert.equal(res.signature, attempt.signature);
  });

  it('R-P0-03 & Phase 19: third-party transaction on the same mint does NOT confirm attempt', async () => {
    // Attempt A with signature A
    const attemptA: ExecutionAttempt = {
      attemptId: 'att-A',
      intentId: dummyIntent.id,
      provider: 'JUPITER_V2',
      signature: 'SigAttemptA111111111111111111111111111111111111111111111111111111111111111111111',
      requestedAmountAtomic: '500000000',
      state: 'UNKNOWN',
      startedAtWallMs: Date.now()
    };

    // Third-party transaction B exists on-chain for the same wallet and mint
    const thirdPartySigB = 'SigThirdPartyB222222222222222222222222222222222222222222222222222222222222222222';

    const onChainDb = new Map<string, any>([
      [thirdPartySigB, {
        signature: thirdPartySigB,
        deltaAtomic: '-500000000',
        walletLamportDelta: 100000000,
        feeLamports: 5000,
        blockTimeMs: 1728000005000,
        success: true
      }]
      // Note: attemptA.signature is NOT in onChainDb (dropped/failed to propagate)
    ]);

    const mockReconciler: WalletTransactionReconciler = {
      reconcileExactTransaction: async (params) => {
        // Reconciliation strictly looks up params.signature
        return onChainDb.get(params.signature) || null;
      }
    };

    // Reconciling attempt A: it must NOT look up or be satisfied by thirdPartySigB
    const resA = await reconcileExecutionAttempt({
      attempt: attemptA,
      intent: dummyIntent,
      walletReconciler: mockReconciler
    });

    assert.equal(resA.status, 'UNKNOWN', 'Attempt A must remain UNKNOWN when its own tx is not found, ignoring third-party tx B');
    assert.equal(resA.actualDebitAtomic, undefined);

    // Now suppose attempt A's tx finally arrives on chain
    onChainDb.set(attemptA.signature!, {
      signature: attemptA.signature!,
      deltaAtomic: '-500000000',
      walletLamportDelta: 95000000,
      feeLamports: 5000,
      blockTimeMs: 1728000010000,
      success: true
    });

    const resAAfter = await reconcileExecutionAttempt({
      attempt: attemptA,
      intent: dummyIntent,
      walletReconciler: mockReconciler
    });

    assert.equal(resAAfter.status, 'CONFIRMED');
    assert.equal(resAAfter.signature, attemptA.signature);
    assert.equal(resAAfter.actualDebitAtomic, 500000000n);
  });

  it('R-P0-03: returns FAILED_DEFINITIVE when exact transaction failed on-chain', async () => {
    const attempt: ExecutionAttempt = {
      attemptId: 'att-reverted',
      intentId: dummyIntent.id,
      provider: 'JUPITER_V2',
      signature: 'SigReverted111111111111111111111111111111111111111111111111111111111111111111111',
      requestedAmountAtomic: '500000000',
      state: 'UNKNOWN',
      startedAtWallMs: Date.now()
    };

    const mockReconciler: WalletTransactionReconciler = {
      reconcileExactTransaction: async () => ({
        signature: attempt.signature!,
        deltaAtomic: '0',
        walletLamportDelta: 0,
        feeLamports: 5000,
        blockTimeMs: 1728000000000,
        success: false,
        error: 'Transaction failed on-chain: InstructionError(Custom(6001))'
      })
    };

    const res = await reconcileExecutionAttempt({
      attempt,
      intent: dummyIntent,
      walletReconciler: mockReconciler
    });

    assert.equal(res.status, 'FAILED_DEFINITIVE');
    assert.match(res.reason || '', /Custom\(6001\)/);
  });

  it('R-P0-03: returns UNKNOWN if transaction succeeded but had zero token debit', async () => {
    const attempt: ExecutionAttempt = {
      attemptId: 'att-zero-debit',
      intentId: dummyIntent.id,
      provider: 'JUPITER_V2',
      signature: 'SigZeroDebit11111111111111111111111111111111111111111111111111111111111111111111',
      requestedAmountAtomic: '500000000',
      state: 'UNKNOWN',
      startedAtWallMs: Date.now()
    };

    const mockReconciler: WalletTransactionReconciler = {
      reconcileExactTransaction: async () => ({
        signature: attempt.signature!,
        deltaAtomic: '0', // No debit
        walletLamportDelta: 0,
        feeLamports: 5000,
        blockTimeMs: 1728000000000,
        success: true
      })
    };

    const res = await reconcileExecutionAttempt({
      attempt,
      intent: dummyIntent,
      walletReconciler: mockReconciler
    });

    assert.equal(res.status, 'UNKNOWN');
    assert.match(res.reason || '', /NO_ECONOMIC_DEBIT/);
  });
});
