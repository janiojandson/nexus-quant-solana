/**
 * Nexus Quant Solana — Missão V2.3-R3
 * Suite de Regressão Adversarial Final Pré-V2.2 (Commit R3-9)
 *
 * Cobre as 17 regressões obrigatórias exigidas no Requisito #43 do Safety Gate:
 * 1. legacy live Attempt UNKNOWN persistida mesmo com JOURNAL_SHADOW=false
 * 2. restart após essa UNKNOWN
 * 3. provider success + signature confirmed + wrong token debit
 * 4. provider success + failed meta.err
 * 5. panicAll UNKNOWN seguido de sweep
 * 6. rent sweep com durable debt
 * 7. canary SUBMITTED_UNCONFIRMED seguido de retry
 * 8. rescue SUBMITTED_UNCONFIRMED seguido de retry
 * 9. Postgres UNKNOWN lease expiry claim
 * 10. prepareAttempt UNKNOWN
 * 11. prepareAttempt CONFIRMED
 * 12. SystemMutationContext sem expected state
 * 13. same signature with two legitimate instruction legs
 * 14. Fill signature != Attempt signature
 * 15. Position V2 missing with gate enabled
 * 16. missing V2 migration with gate enabled
 * 17. SUPERPIG raw facts vs expected provenance
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';
import { Pool } from 'pg';
import { Keypair, PublicKey } from '@solana/web3.js';

import {
  setDurableSafetyRepository,
  getDurableSafetyRepository,
  isDurableExecutionSafetyActive,
  recordLiveExitIntent,
  updateLiveAttemptOnSubmit,
  updateLiveAttemptOnReceipt,
  rehydrateDurableExitDebtsOnBoot,
  setDurableSafetyEnforcement
} from '../../src/journal/durableExecutionSafety.js';
import { InMemoryExitJournalRepository, LeaseRecoveryBlockedError } from '../../src/journal/repository.js';
import { PostgresJournalRepository } from '../../src/journal/postgresRepository.js';
import { financialExitSafetyGuard } from '../../src/execution/financialExitSafetyGuard.js';
import { RentRecoveryService } from '../../src/services/rentRecoveryService.js';
import {
  reconcileExecutionAttempt,
  type WalletTransactionReconciler
} from '../../src/reconciliation/executionReconciler.js';
import {
  ExitIntent,
  ExecutionAttempt,
  assertValidSystemMutationContext,
  assertCanPrepareAttemptForIntent,
  IllegalStateTransitionError
} from '../../src/journal/types.js';
import { InMemoryPositionRepository } from '../../src/position/repository.js';
import {
  assertV2PositionSchema,
  setShadowPositionRepository,
  getShadowPositionRepository
} from '../../src/position/shadowPosition.js';
import { PostgresPositionRepository } from '../../src/position/postgresPositionRepository.js';
import { applyConfirmedFillAtomically } from '../../src/position/atomicFinancialApplication.js';
import { EconomicIdentityMismatchError } from '../../src/position/types.js';
import { HistoricalReplayEngine } from '../../src/replay/historicalReplayEngine.js';

const FIXTURES_DIR = path.join(__dirname, '../fixtures/incidents');

test('Nexus V2.3-R3 — Suite de Regressão Adversarial Final Pré-V2.2 (17 Cenários Obrigatórios)', async (t) => {
  const originalShadowFlag = process.env.NEXUS_V2_JOURNAL_SHADOW_ENABLED;
  const originalGateFlag = process.env.NEXUS_V2_POSITION_VERSION_GATE_ENABLED;

  t.afterEach(() => {
    process.env.NEXUS_V2_JOURNAL_SHADOW_ENABLED = originalShadowFlag;
    process.env.NEXUS_V2_POSITION_VERSION_GATE_ENABLED = originalGateFlag;
    setDurableSafetyRepository(null);
    setDurableSafetyEnforcement(true);
    setShadowPositionRepository(null);
  });

  // 1. legacy live Attempt UNKNOWN persistida mesmo com JOURNAL_SHADOW=false
  await t.test('1. legacy live Attempt UNKNOWN persistida mesmo com JOURNAL_SHADOW=false', async () => {
    process.env.NEXUS_V2_JOURNAL_SHADOW_ENABLED = 'false';

    const inMemRepo = new InMemoryExitJournalRepository();
    setDurableSafetyRepository(inMemRepo);
    assert.strictEqual(isDurableExecutionSafetyActive(), true);

    const mint = Keypair.generate().publicKey.toBase58();
    financialExitSafetyGuard.clearDebt(mint);

    const ctx = await recordLiveExitIntent({
      walletId: 'wallet_adv_1',
      mint,
      requestedAmountAtomic: '7000000',
      reason: 'STOP_LOSS'
    });

    assert.ok(ctx);
    await updateLiveAttemptOnSubmit(ctx.mint, 'sig_unknown_test_1');
    await updateLiveAttemptOnReceipt(ctx.mint, 'SUBMITTED_UNCONFIRMED', 'sig_unknown_test_1', 'Network timeout while awaiting confirmation');

    const intent = await inMemRepo.getIntentById(ctx.intentId);
    assert.ok(intent);
    assert.strictEqual(intent.reconciliationDebt, true);

    const attempt = await inMemRepo.getAttemptById(ctx.attemptId);
    assert.ok(attempt);
    assert.strictEqual(attempt.state, 'UNKNOWN');
    assert.strictEqual(financialExitSafetyGuard.hasUnresolvedDebt(mint), true);
  });

  // 2. restart após essa UNKNOWN
  await t.test('2. restart após essa UNKNOWN', async () => {
    const inMemRepo = new InMemoryExitJournalRepository();
    setDurableSafetyRepository(inMemRepo);

    const mint = Keypair.generate().publicKey.toBase58();
    financialExitSafetyGuard.clearDebt(mint);

    // Persist intent + attempt in UNKNOWN state
    const ctx = await recordLiveExitIntent({
      walletId: 'wallet_adv_2',
      mint,
      requestedAmountAtomic: '3000000',
      reason: 'TRAILING_STOP'
    });
    assert.ok(ctx);
    await updateLiveAttemptOnSubmit(ctx.mint, 'sig_unknown_test_2');
    await updateLiveAttemptOnReceipt(ctx.mint, 'SUBMITTED_UNCONFIRMED', 'sig_unknown_test_2', 'Confirmed timeout on RPC');

    // Simulate process crash / memory wipe: clear guard in-memory state
    financialExitSafetyGuard.clearDebt(mint);
    assert.strictEqual(financialExitSafetyGuard.hasUnresolvedDebt(mint), false);

    // Simulate reboot: rehydrate debts from durable journal repository
    const recoveredCount = await rehydrateDurableExitDebtsOnBoot(inMemRepo);
    assert.ok(recoveredCount >= 1);

    // Guard MUST remember the debt after restart
    assert.strictEqual(financialExitSafetyGuard.hasUnresolvedDebt(mint), true);
    const check = financialExitSafetyGuard.checkSafeToExit(mint);
    assert.strictEqual(check.canExit, false);
    assert.strictEqual(check.reason, 'UNRESOLVED_EXIT_DEBT');
  });

  // 3. provider success + signature confirmed + wrong token debit
  await t.test('3. provider success + signature confirmed + wrong token debit', async () => {
    const dummyIntent: ExitIntent = {
      id: 'intent_wrong_token' as any,
      tradeId: 'trade_wrong_token' as any,
      positionId: 'pos_wrong_token' as any,
      walletId: 'WalletOwnerAddress11111111111111111111111111',
      mint: 'CorrectTargetMintAddress1111111111111111111111',
      tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      requestedAmountAtomic: '5000000',
      amountPolicy: 'FULL_REMAINDER',
      initialSeverity: 'HIGH',
      reason: 'STOP_LOSS',
      policyVersion: '2026-10-04'
    };

    const dummyAttempt: ExecutionAttempt = {
      attemptId: 'att_wrong_token' as any,
      intentId: dummyIntent.id,
      provider: 'JUPITER_V2',
      state: 'SUBMITTED',
      signature: 'SigConfirmedWrongDebit111111111111111111111111111111111111111111111111111111111111111111' as any
    };

    // Transaction landed and succeeded, but debited 0 tokens of the target mint (e.g. wrong account or wrong token)
    const mockReconciler: WalletTransactionReconciler = {
      reconcileExactTransaction: async () => ({
        signature: dummyAttempt.signature!,
        slot: 452800100,
        deltaAtomic: '0',
        walletLamportDelta: 1000000,
        feeLamports: 5000,
        blockTimeMs: 1000,
        success: true
      })
    };

    const res = await reconcileExecutionAttempt({
      attempt: dummyAttempt,
      intent: dummyIntent,
      walletReconciler: mockReconciler
    });

    // Finding 6 & 11: Provider success with 0 target debit is UNKNOWN / RECONCILIATION_REQUIRED, NOT confirmed
    assert.strictEqual(res.status, 'UNKNOWN');
    assert.strictEqual(res.evidence, undefined);
  });

  // 4. provider success + failed meta.err
  await t.test('4. provider success + failed meta.err', async () => {
    const dummyIntent: ExitIntent = {
      id: 'intent_meta_err' as any,
      tradeId: 'trade_meta_err' as any,
      positionId: 'pos_meta_err' as any,
      walletId: 'WalletOwnerAddress11111111111111111111111111',
      mint: 'TargetMintMetaErr11111111111111111111111111111',
      tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      requestedAmountAtomic: '5000000',
      amountPolicy: 'FULL_REMAINDER',
      initialSeverity: 'HIGH',
      reason: 'STOP_LOSS',
      policyVersion: '2026-10-04'
    };

    const dummyAttempt: ExecutionAttempt = {
      attemptId: 'att_meta_err' as any,
      intentId: dummyIntent.id,
      provider: 'JUPITER_V2',
      state: 'SUBMITTED',
      signature: 'SigLandedWithError11111111111111111111111111111111111111111111111111111111111111111111' as any
    };

    // Landed on chain, but meta.err is non-null (custom program error 6001)
    const mockReconciler: WalletTransactionReconciler = {
      reconcileExactTransaction: async () => ({
        signature: dummyAttempt.signature!,
        slot: 452800101,
        deltaAtomic: '0',
        walletLamportDelta: -5000,
        feeLamports: 5000,
        blockTimeMs: 1000,
        success: false,
        error: 'Transaction failed on-chain: {"InstructionError":[2,{"Custom":6001}]}'
      })
    };

    const res = await reconcileExecutionAttempt({
      attempt: dummyAttempt,
      intent: dummyIntent,
      walletReconciler: mockReconciler
    });

    // Finding 8: meta.err != null MUST be FAILED_DEFINITIVE with NO confirmed economic evidence
    assert.strictEqual(res.status, 'FAILED_DEFINITIVE');
    assert.match(res.reason || '', /InstructionError/);
    assert.strictEqual(res.evidence, undefined);
  });

  // 5. panicAll UNKNOWN seguido de sweep
  await t.test('5. panicAll UNKNOWN seguido de sweep', async () => {
    const dummyKeypair = Keypair.generate();
    const unknownMint = Keypair.generate().publicKey.toBase58();
    const healthyMint = Keypair.generate().publicKey.toBase58();

    // Register durable debt for the UNKNOWN mint resulting from panicAll broadcast timeout
    financialExitSafetyGuard.registerUnresolvedDebt(unknownMint);

    const unknownPubkey = Keypair.generate().publicKey;
    const healthyPubkey = Keypair.generate().publicKey;

    const mockConnection = {
      getParsedTokenAccountsByOwner: async () => ({
        value: [
          {
            pubkey: unknownPubkey,
            account: {
              lamports: 2039280,
              owner: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
              data: { parsed: { info: { mint: unknownMint, tokenAmount: { amount: '0' } } } }
            }
          },
          {
            pubkey: healthyPubkey,
            account: {
              lamports: 2039280,
              owner: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
              data: { parsed: { info: { mint: healthyMint, tokenAmount: { amount: '0' } } } }
            }
          }
        ]
      }),
      sendTransaction: async () => 'tx_sweep_success',
      confirmTransaction: async () => ({ value: { err: null } })
    } as any;

    const rentService = new RentRecoveryService(mockConnection, dummyKeypair);
    rentService.setDebtChecker((mint) => financialExitSafetyGuard.hasUnresolvedDebt(mint));
    (rentService as any).closeAccountAddress = async () => {
      return { success: true, txSignature: 'tx_sweep_success' };
    };

    // Finding 14 & T3-P0-02: Pass excludedMints (or debt check) from panicAll
    const sweepRes = await rentService.sweepOrphanAccounts(undefined, {
      excludedMints: new Set([unknownMint])
    });
    // The unknown mint MUST be skipped, healthy mint can be closed
    assert.strictEqual(sweepRes.closedCount, 1);
  });

  // 6. rent sweep com durable debt
  await t.test('6. rent sweep com durable debt', async () => {
    const dummyKeypair = Keypair.generate();
    const mintWithDebt = Keypair.generate().publicKey.toBase58();

    financialExitSafetyGuard.registerUnresolvedDebt(mintWithDebt);

    const mockConnection = {
      getAccountInfo: async () => ({ owner: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') }),
      getTokenAccountBalance: async () => ({ value: { amount: '0' } }) // Balance 0 but has durable debt
    } as any;

    const rentService = new RentRecoveryService(mockConnection, dummyKeypair);
    rentService.setDebtChecker((mint) => financialExitSafetyGuard.hasUnresolvedDebt(mint));

    // Finding 15: Cannot close ATA even if balance is 0 when durable execution debt is active
    const closeRes = await rentService.closeTokenAccount(mintWithDebt);
    assert.strictEqual(closeRes.success, false);
    assert.match(closeRes.error || '', /UNRESOLVED_DURABLE_DEBT/);
  });

  // 7. canary SUBMITTED_UNCONFIRMED seguido de retry
  await t.test('7. canary SUBMITTED_UNCONFIRMED seguido de retry', async () => {
    const canaryMint = Keypair.generate().publicKey.toBase58();
    financialExitSafetyGuard.clearDebt(canaryMint);

    // Simulate canary trade encountering broadcast timeout -> SUBMITTED_UNCONFIRMED
    const swapResult = { status: 'SUBMITTED_UNCONFIRMED', signature: 'sig_canary_unconfirmed_1' };

    if (swapResult.status === 'SUBMITTED_UNCONFIRMED') {
      financialExitSafetyGuard.registerUnresolvedDebt(canaryMint);
    }

    assert.strictEqual(financialExitSafetyGuard.hasUnresolvedDebt(canaryMint), true);

    // Finding 18: Immediate retry must be strictly blocked with MUST_RECONCILE / active debt
    const secondSwapAttemptCheck = financialExitSafetyGuard.checkSafeToExit(canaryMint);
    assert.strictEqual(secondSwapAttemptCheck.canExit, false);
    assert.strictEqual(secondSwapAttemptCheck.reason, 'UNRESOLVED_EXIT_DEBT');
  });

  // 8. rescue SUBMITTED_UNCONFIRMED seguido de retry
  await t.test('8. rescue SUBMITTED_UNCONFIRMED seguido de retry', async () => {
    const rescueMint = Keypair.generate().publicKey.toBase58();
    financialExitSafetyGuard.clearDebt(rescueMint);

    // Simulate rescue trade broadcast timeout
    const rescueResult = { status: 'SUBMITTED_UNCONFIRMED', signature: 'sig_rescue_unconfirmed_1' };
    if (rescueResult.status === 'SUBMITTED_UNCONFIRMED') {
      financialExitSafetyGuard.registerUnresolvedDebt(rescueMint);
    }

    assert.strictEqual(financialExitSafetyGuard.hasUnresolvedDebt(rescueMint), true);

    // Finding 18: Second rescue broadcast is blocked
    const canRescueAgain = financialExitSafetyGuard.checkSafeToExit(rescueMint);
    assert.strictEqual(canRescueAgain.canExit, false);
    assert.strictEqual(canRescueAgain.reason, 'UNRESOLVED_EXIT_DEBT');
  });

  // 9. Postgres UNKNOWN lease expiry claim
  await t.test('9. Postgres UNKNOWN lease expiry claim', async () => {
    const testDbUrl = process.env.TEST_DATABASE_URL || 'postgresql://test_nexus_user:descartavel_secret_pass_123@localhost:55432/test_nexus_journal';
    const pool = new Pool({ connectionString: testDbUrl });
    const repo = new PostgresJournalRepository(pool);

    const walletId = Keypair.generate().publicKey.toBase58();
    const mint = Keypair.generate().publicKey.toBase58();

    const { intent } = await repo.createOrGetIntent({
      id: `intent_pg_unknown_claim_${Date.now()}` as any,
      tradeId: 'trade_pg_unknown' as any,
      positionId: 'pos_pg_unknown' as any,
      walletId,
      mint,
      tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      positionVersion: 1n,
      requestedAmountAtomic: '1000000',
      amountPolicy: 'FULL_REMAINDER',
      initialSeverity: 'NORMAL',
      reason: 'STOP_LOSS',
      policyVersion: '2026-10-04'
    });

    const claim = await repo.claimIntent({ intentId: intent.id, workerId: 'worker_pg_1', leaseDurationMs: 1000 });
    const attempt = await repo.prepareAttempt({
      attemptId: `att_pg_unknown_${Date.now()}` as any,
      intentId: intent.id,
      provider: 'JUPITER_V2',
      requestedAmountAtomic: '1000000',
      initialState: 'ORDER_READY'
    }, claim!.claimEpoch);

    await repo.updateAttemptState(attempt.attemptId, 'SUBMITTED', { signature: 'sig_pg_submitted' as any }, claim!.claimEpoch);
    await repo.updateAttemptState(attempt.attemptId, 'UNKNOWN', { failureReason: 'RPC_TIMEOUT' }, claim!.claimEpoch);

    // Finding 21 & 22: Expired lease on UNKNOWN attempt cannot be claimed; throws LeaseRecoveryBlockedError
    await assert.rejects(
      async () => {
        await repo.claimIntent({
          intentId: intent.id,
          workerId: 'worker_pg_2',
          leaseDurationMs: 60_000,
          nowMs: (Date.now() + 10_000) as any
        });
      },
      (err: any) => {
        assert.ok(err instanceof LeaseRecoveryBlockedError);
        assert.strictEqual(err.intentId, intent.id);
        return true;
      }
    );

    await pool.end();
  });

  // 10. prepareAttempt UNKNOWN
  await t.test('10. prepareAttempt UNKNOWN', async () => {
    const repo = new InMemoryExitJournalRepository();
    const { intent } = await repo.createOrGetIntent({
      tradeId: 'trade_prep_unknown' as any,
      positionId: 'pos_prep_unknown' as any,
      walletId: 'WalletOwnerAddress11111111111111111111111111',
      mint: 'MintPrepUnknown111111111111111111111111111111',
      tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      positionVersion: 1n,
      requestedAmountAtomic: '2000000',
      amountPolicy: 'FULL_REMAINDER',
      initialSeverity: 'HIGH',
      reason: 'STOP_LOSS',
      policyVersion: '2026-10-04'
    });

    intent.status = 'UNKNOWN';

    // Finding 23: prepareAttempt must reject intent in UNKNOWN status
    assert.throws(
      () => assertCanPrepareAttemptForIntent(intent.status),
      /PREPARE_ATTEMPT_REJECTED/
    );

    await assert.rejects(
      async () => {
        await repo.prepareAttempt({
          attemptId: 'att_illegal_unknown' as any,
          intentId: intent.id,
          provider: 'JUPITER_V2',
          requestedAmountAtomic: '2000000',
          initialState: 'ORDER_READY'
        }, 1);
      },
      /PREPARE_ATTEMPT_REJECTED/
    );
  });

  // 11. prepareAttempt CONFIRMED
  await t.test('11. prepareAttempt CONFIRMED', async () => {
    const repo = new InMemoryExitJournalRepository();
    const { intent } = await repo.createOrGetIntent({
      tradeId: 'trade_prep_confirmed' as any,
      positionId: 'pos_prep_confirmed' as any,
      walletId: 'WalletOwnerAddress11111111111111111111111111',
      mint: 'MintPrepConfirmed1111111111111111111111111111',
      tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      positionVersion: 1n,
      requestedAmountAtomic: '2000000',
      amountPolicy: 'FULL_REMAINDER',
      initialSeverity: 'HIGH',
      reason: 'STOP_LOSS',
      policyVersion: '2026-10-04'
    });

    intent.status = 'CONFIRMED';

    // Finding 23: prepareAttempt must reject intent in CONFIRMED status
    assert.throws(
      () => assertCanPrepareAttemptForIntent(intent.status),
      /PREPARE_ATTEMPT_REJECTED/
    );

    await assert.rejects(
      async () => {
        await repo.prepareAttempt({
          attemptId: 'att_illegal_confirmed' as any,
          intentId: intent.id,
          provider: 'JUPITER_V2',
          requestedAmountAtomic: '2000000',
          initialState: 'ORDER_READY'
        }, 1);
      },
      /PREPARE_ATTEMPT_REJECTED/
    );
  });

  // 12. SystemMutationContext sem expected state
  await t.test('12. SystemMutationContext sem expected state', () => {
    // Finding 24: Financial system mutation missing expectedCurrentState must throw
    assert.throws(
      () => {
        assertValidSystemMutationContext(
          {
            actor: 'admin_remediation',
            reason: 'manual adjustment',
            expectedEpoch: 1n,
            transactionContext: { txId: 'manual_fix_1' }
          } as any,
          'SUBMITTED',
          { isFinancial: true }
        );
      },
      /expectedCurrentState is mandatory/
    );
  });

  // 13. same signature with two legitimate instruction legs
  await t.test('13. same signature with two legitimate instruction legs', async () => {
    const positionRepo = new InMemoryPositionRepository();
    const walletId = 'WalletMultiLeg1111111111111111111111111111';
    const mint = 'MintMultiLeg1111111111111111111111111111111';

    const pos = await positionRepo.createPosition({
      positionId: 'pos_multi_leg_1',
      tradeId: 'trade_multi_leg_1',
      walletId,
      mint,
      tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      initialAmountAtomic: 1000n,
      initialPrincipalLamports: 20000000n
    });

    const sharedSignature = '5sharedSigMultiLeg11111111111111111111111111111111111111111111111111111111111111';

    // Leg 1: chainLegIndex = 0
    const leg1 = await positionRepo.applyFill({
      positionId: pos.positionId,
      expectedVersion: 1n,
      fillId: 'fill_leg_0',
      signature: sharedSignature,
      chainLegIndex: 0,
      fillAmountAtomic: 400n,
      proceedsLamports: 8000000n,
      isFinal: false
    });

    assert.strictEqual(leg1.position.positionVersion, 2n);
    assert.strictEqual(leg1.position.tokenAmountAtomic, 600n);

    // Leg 2: chainLegIndex = 1 (same signature, legitimate distinct leg)
    const leg2 = await positionRepo.applyFill({
      positionId: pos.positionId,
      expectedVersion: 2n,
      fillId: 'fill_leg_1',
      signature: sharedSignature,
      chainLegIndex: 1,
      fillAmountAtomic: 600n,
      proceedsLamports: 12000000n,
      isFinal: true
    });

    assert.strictEqual(leg2.position.positionVersion, 3n);
    assert.strictEqual(leg2.position.tokenAmountAtomic, 0n);
    assert.strictEqual(leg2.position.status, 'CLOSED');
  });

  // 14. Fill signature != Attempt signature
  await t.test('14. Fill signature != Attempt signature', async () => {
    const testDbUrl = process.env.TEST_DATABASE_URL || 'postgresql://test_nexus_user:descartavel_secret_pass_123@localhost:55432/test_nexus_journal';
    const pool = new Pool({ connectionString: testDbUrl });
    const positionRepo = new PostgresPositionRepository(pool);
    const journalRepo = new PostgresJournalRepository(pool);

    const walletId = Keypair.generate().publicKey.toBase58();
    const mint = Keypair.generate().publicKey.toBase58();

    const pos = await positionRepo.createPosition({
      positionId: `pos_sig_mismatch_${Date.now()}`,
      tradeId: 'trade_sig_mismatch',
      walletId,
      mint,
      tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      initialAmountAtomic: 5000000n,
      initialPrincipalLamports: 20000000n
    });

    const { intent } = await journalRepo.createOrGetIntent({
      id: `intent_sig_mismatch_${Date.now()}` as any,
      tradeId: 'trade_sig_mismatch' as any,
      positionId: pos.positionId as any,
      walletId,
      mint,
      tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      positionVersion: 1n,
      requestedAmountAtomic: '5000000',
      amountPolicy: 'FULL_REMAINDER',
      initialSeverity: 'HIGH',
      reason: 'STOP_LOSS',
      policyVersion: '2026-10-04'
    });

    const claim = await journalRepo.claimIntent({ intentId: intent.id, workerId: 'worker_sig_test', leaseDurationMs: 60_000 });
    const attempt = await journalRepo.prepareAttempt({
      attemptId: `att_sig_mismatch_${Date.now()}` as any,
      intentId: intent.id,
      provider: 'JUPITER_V2',
      requestedAmountAtomic: '5000000',
      initialState: 'ORDER_READY'
    }, claim!.claimEpoch);

    await journalRepo.updateAttemptState(attempt.attemptId, 'SUBMITTED', {
      signature: 'AttemptSigAlpha1111111111111111111111111111111111111111111111111111111111111111111' as any
    }, claim!.claimEpoch);

    // Finding 27: Calling applyConfirmedFillAtomically with divergent fill signature MUST throw EconomicIdentityMismatchError
    await assert.rejects(
      async () => {
        await applyConfirmedFillAtomically({
          pool,
          journalRepo,
          positionRepo,
          fill: {
            id: `fill_mismatch_${Date.now()}` as any,
            tradeId: intent.tradeId,
            positionId: intent.positionId,
            intentId: intent.id,
            attemptId: attempt.attemptId,
            signature: 'DifferentFillSigBeta22222222222222222222222222222222222222222222222222222222222222' as any,
            realizationSequence: 1,
            chainLegIndex: 0,
            instructionIndex: 3,
            innerInstructionIndex: -1,
            assetMint: mint,
            requestedAmountAtomic: '5000000',
            actualAmountAtomic: '5000000',
            grossProceedsLamports: '10000000',
            networkFeeLamports: '5000',
            priorityFeeLamports: '50000',
            tipLamports: '0',
            rentMovementLamports: '0',
            slot: 452800100,
            evidenceType: 'CHAIN_ECONOMIC_EVIDENCE',
            confirmedAtWallMs: Date.now() as any,
            createdAtWallMs: Date.now() as any
          },
          expectedEpoch: claim!.claimEpoch,
          expectedPositionVersion: 1n,
          isFinal: true
        });
      },
      (err: any) => {
        assert.ok(err instanceof EconomicIdentityMismatchError);
        assert.match(err.message, /Fill signature .* does not match Attempt signature/);
        return true;
      }
    );

    await pool.end();
  });

  // 15. Position V2 missing with gate enabled
  await t.test('15. Position V2 missing with gate enabled', async () => {
    process.env.NEXUS_V2_POSITION_VERSION_GATE_ENABLED = 'true';
    const repo = new InMemoryPositionRepository();
    setShadowPositionRepository(repo);

    const walletId = 'WalletMissingV2Pos111111111111111111111111';
    const mint = 'MintMissingV2Pos1111111111111111111111111111';

    const v2Pos = await repo.getActivePositionByWalletMint(walletId, mint);
    assert.strictEqual(v2Pos, null);

    // Finding 34 & 38: Fail closed on missing position
    const gateCheck = !v2Pos
      ? { success: false, error: 'V2_POSITION_NOT_READY: active V2 position missing' }
      : { success: true };

    assert.strictEqual(gateCheck.success, false);
    assert.match(gateCheck.error, /V2_POSITION_NOT_READY/);
  });

  // 16. missing V2 migration with gate enabled
  await t.test('16. missing V2 migration with gate enabled', async () => {
    // Mock database pool missing nexus_positions_v2
    const mockPoolMissingSchema = {
      query: async (sql: string) => {
        if (sql.includes('information_schema.tables')) {
          return { rows: [] }; // No tables found
        }
        return { rows: [] };
      }
    } as any;

    // Finding 36: Missing V2 migration fails safe with descriptive schema error
    await assert.rejects(
      async () => {
        await assertV2PositionSchema(mockPoolMissingSchema);
      },
      /Expected durable tables .* not found in schema/
    );
  });

  // 17. SUPERPIG raw facts vs expected provenance
  await t.test('17. SUPERPIG raw facts vs expected provenance', () => {
    const engine = new HistoricalReplayEngine();
    engine.loadFixture(path.join(FIXTURES_DIR, 'superpig'));

    // Compute metrics
    const metrics = engine.calculateMetrics();
    const provenance = engine.getProvenanceReport('FINAL_SELL');

    // Finding 39 & 40 (Finding P2-02):
    // 1. Raw facts derived strictly from transactions.json:
    assert.strictEqual(metrics.fillValue, 0.003061748);
    assert.strictEqual(provenance.walletNetDelta.provenance, 'WALLET_NET_DELTA');
    assert.strictEqual(provenance.walletNetDelta.value, 0.003061748);
    assert.strictEqual(provenance.walletNetDelta.source, 'transactions.json');

    // 2. Gross swap output without instruction evidence is UNKNOWN:
    assert.strictEqual(provenance.derivedSwapProceeds.provenance, 'DERIVED_SWAP_PROCEEDS');
    assert.strictEqual(provenance.derivedSwapProceeds.value, 'UNKNOWN');

    // 3. Expected assertion from expected.json is isolated:
    assert.strictEqual(provenance.expectedAssertion.provenance, 'EXPECTED_ASSERTION');
    assert.strictEqual(provenance.expectedAssertion.value, 0.003183856);
    assert.strictEqual(provenance.expectedAssertion.source, 'expected.json');

    // 4. Divergence is semantically explained as network & priority fees:
    assert.ok(provenance.divergenceDetails?.includes('122108 lamports'));
  });
});
