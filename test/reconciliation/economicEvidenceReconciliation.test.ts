import test from 'node:test';
import assert from 'node:assert/strict';
import {
  reconcileExecutionAttempt,
  type WalletTransactionReconciler,
  type EconomicExecutionEvidence
} from '../../src/reconciliation/executionReconciler.js';
import { ExecutionAttempt, ExitIntent } from '../../src/journal/types.js';

test('Nexus V2.3-R3 — Economic Execution Evidence & Strict Reconciliation (Commit R3-2)', async (t) => {
  const dummyIntent: ExitIntent = {
    id: 'intent_econ_1' as any,
    tradeId: 'trade_econ_1' as any,
    positionId: 'pos_econ_1' as any,
    walletId: 'WalletOwnerAddress11111111111111111111111111',
    mint: 'TargetMintAddress111111111111111111111111111',
    tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    requestedAmountAtomic: '1000000000',
    amountPolicy: 'FULL_BALANCE',
    decisionReason: 'TAKE_PROFIT',
    initiator: 'STRATEGY',
    idempotencyKey: 'idemp_econ_1' as any,
    state: 'SUBMITTED',
    createdAtWallMs: 1000,
    claimEpoch: 1n,
    reconciliationDebt: true
  };

  const dummyAttempt: ExecutionAttempt = {
    attemptId: 'att_econ_1' as any,
    intentId: dummyIntent.id,
    attemptSequence: 1,
    state: 'SUBMITTED',
    signature: 'SigLandedOnChain1111111111111111111111111111111111111111111111111111111111111111111',
    createdAtWallMs: 1050
  };

  await t.test('1. meta.err != null: Transaction landed on-chain but failed -> FAILED_DEFINITIVE, no economic effect', async () => {
    const mockReconciler: WalletTransactionReconciler = {
      reconcileExactTransaction: async () => ({
        signature: dummyAttempt.signature!,
        slot: 123456,
        deltaAtomic: '0',
        walletLamportDelta: -5000,
        feeLamports: 5000,
        blockTimeMs: 1000,
        success: false,
        error: 'Transaction failed on-chain: {"InstructionError":[2,{"Custom":1}]}'
      })
    };

    const result = await reconcileExecutionAttempt({
      attempt: dummyAttempt,
      intent: dummyIntent,
      walletReconciler: mockReconciler
    });

    assert.equal(result.status, 'FAILED_DEFINITIVE');
    assert.match(result.reason || '', /InstructionError/);
    assert.equal(result.evidence, undefined);
  });

  await t.test('2. Succeeded on-chain but debited wrong token / 0 tokens -> UNKNOWN, no economic effect', async () => {
    const mockReconciler: WalletTransactionReconciler = {
      reconcileExactTransaction: async () => ({
        signature: dummyAttempt.signature!,
        slot: 123457,
        deltaAtomic: '0', // No debit for target mint
        walletLamportDelta: 0,
        feeLamports: 5000,
        blockTimeMs: 1000,
        success: true
      })
    };

    const result = await reconcileExecutionAttempt({
      attempt: dummyAttempt,
      intent: dummyIntent,
      walletReconciler: mockReconciler
    });

    assert.equal(result.status, 'UNKNOWN');
    assert.match(result.reason || '', /NO_ECONOMIC_DEBIT/);
    assert.equal(result.evidence, undefined);
  });

  await t.test('3. Exact token debit on-chain produces EconomicExecutionEvidence with derived amounts', async () => {
    const mockReconciler: WalletTransactionReconciler = {
      reconcileExactTransaction: async () => ({
        signature: dummyAttempt.signature!,
        slot: 123458,
        deltaAtomic: '-1000000000', // Outgoing 1,000,000,000 atomic units
        remainingCustodyAtomic: '0',
        inputTokenAccount: 'OwnerATA111111111111111111111111111111111111111',
        walletLamportDelta: 49_995_000, // Net +49.995m lamports
        feeLamports: 5000, // 5k fee
        blockTimeMs: 1000,
        success: true
      })
    };

    const result = await reconcileExecutionAttempt({
      attempt: dummyAttempt,
      intent: dummyIntent,
      walletReconciler: mockReconciler
    });

    assert.equal(result.status, 'CONFIRMED');
    assert.equal(result.actualDebitAtomic, 1000000000n);
    assert.equal(result.grossProceedsLamports, 50_000_000n); // 49_995_000 + 5000
    assert.equal(result.networkFeeLamports, 5000n);

    assert.ok(result.evidence, 'Evidence must be present');
    assert.equal(result.evidence.signature, dummyAttempt.signature);
    assert.equal(result.evidence.slot, 123458);
    assert.equal(result.evidence.inputMint, dummyIntent.mint);
    assert.equal(result.evidence.wallet, dummyIntent.walletId);
    assert.equal(result.evidence.actualDebitAtomic, 1000000000n);
    assert.equal(result.evidence.actualCreditAtomic, 50_000_000n);
    assert.equal(result.evidence.remainingCustodyAtomic, 0n);
    assert.equal(result.evidence.evidenceSource, 'ON_CHAIN_TRANSACTION');
    assert.equal(result.evidence.commitment, 'confirmed');
  });

  await t.test('4. Partial token debit reflects exact on-chain debit without fallback to requestedAmount', async () => {
    const mockReconciler: WalletTransactionReconciler = {
      reconcileExactTransaction: async () => ({
        signature: dummyAttempt.signature!,
        slot: 123459,
        deltaAtomic: '-450000000', // Only 450,000,000 debited instead of 1,000,000,000
        remainingCustodyAtomic: '550000000',
        inputTokenAccount: 'OwnerATA111111111111111111111111111111111111111',
        walletLamportDelta: 22_495_000,
        feeLamports: 5000,
        blockTimeMs: 1000,
        success: true
      })
    };

    const result = await reconcileExecutionAttempt({
      attempt: dummyAttempt,
      intent: dummyIntent,
      walletReconciler: mockReconciler
    });

    assert.equal(result.status, 'CONFIRMED');
    assert.equal(result.actualDebitAtomic, 450000000n);
    assert.notEqual(result.actualDebitAtomic, BigInt(dummyIntent.requestedAmountAtomic));
    assert.equal(result.evidence?.remainingCustodyAtomic, 550000000n);
  });
});
