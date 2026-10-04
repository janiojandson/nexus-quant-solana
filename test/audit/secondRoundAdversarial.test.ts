import { describe, it, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@solana/web3.js';
import {
  FinancialExitSafetyGuard,
  financialExitSafetyGuard
} from '../../src/execution/financialExitSafetyGuard.js';
import {
  getFinancialReadiness,
  getFinancialReadinessStatus,
  setFinancialReadiness,
  isFinancialReady
} from '../../src/core/financialReadiness.js';
import {
  createRequiredTestPool
} from '../helpers/testDatabase.js';
import {
  PostgresJournalRepository
} from '../../src/journal/postgresRepository.js';
import {
  PostgresPositionRepository
} from '../../src/position/postgresRepository.js';
import {
  SolanaWalletService
} from '../../src/blockchain/solanaWallet.js';
import {
  reconcileExecutionAttempt,
  WalletTransactionReconciler
} from '../../src/reconciliation/executionReconciler.js';
import {
  DispatchReservationManager
} from '../../src/position/versionGate.js';
import {
  applyConfirmedFillAtomically
} from '../../src/position/atomicPositionApplication.js';
import {
  InMemoryExitJournalRepository
} from '../../src/journal/repository.js';
import {
  InMemoryPositionRepository
} from '../../src/position/repository.js';
import {
  ExitIntent,
  ExecutionAttempt
} from '../../src/journal/types.js';

describe('Nexus V2.3-R2 — Second-Round Adversarial Regressions (FASES 16, 17, 18, 19)', () => {

  // =========================================================================
  // FASE 17: UNKNOWN Attempt surviving boot fence across restarts
  // =========================================================================
  describe('FASE 17: UNKNOWN Attempt surviving restart & boot fence', () => {
    test('P0-02 / R-P0-01: Persistent UNKNOWN attempt with reconciliation debt survives restart and strictly blocks new sells', async () => {
      const pool = await createRequiredTestPool();

      try {
        const journalRepo = new PostgresJournalRepository({ pool });
        const walletKeypair = Keypair.generate();
        const testWallet = walletKeypair.publicKey.toBase58();
        const debtMint = Keypair.generate().publicKey.toBase58();

        // Ensure safety guard is clean for this mint initially
        financialExitSafetyGuard.clearDebt(debtMint);
        financialExitSafetyGuard.releaseExitLock(debtMint);

        // 1. Initial State: Create intent that ended up in UNKNOWN state with active reconciliation debt
        const intentId = `intent_unk_${Date.now()}` as any;
        const { intent } = await journalRepo.createOrGetIntent({
          id: intentId,
          tradeId: `trade_unk_${Date.now()}` as any,
          positionId: `pos_unk_${Date.now()}` as any,
          walletId: testWallet,
          mint: debtMint,
          tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
          requestedAmountAtomic: '7500000',
          amountPolicy: 'FULL_REMAINDER',
          initialSeverity: 'HIGH',
          reason: 'STOP_LOSS',
          policyVersion: '2026-10-04'
        });

        const claim = await journalRepo.claimIntent({
          workerId: 'worker_pre_crash',
          leaseDurationMs: 10_000,
          intentId: intent.id
        });
        assert.ok(claim);

        const attemptId = `att_unk_${Date.now()}` as any;
        await journalRepo.prepareAttempt({
          attemptId,
          intentId: intent.id,
          provider: 'JUPITER_V2',
          requestedAmountAtomic: '7500000'
        }, claim.claimEpoch);

        // Advance attempt to SUBMITTED
        const inFlightSig = `sig_inflight_${Date.now()}` as any;
        await journalRepo.updateAttemptState(attemptId, 'SUBMITTED', {
          signature: inFlightSig
        }, claim.claimEpoch);

        // Transition to UNKNOWN on timeout with active debt
        await journalRepo.updateAttemptState(attemptId, 'UNKNOWN', {
          failureReason: 'CONFIRMATION_TIMEOUT',
          errorClassification: 'UNKNOWN'
        }, claim.claimEpoch);

        // Set reconciliation debt explicitly in Postgres
        await pool.query(
          "UPDATE exit_intents SET reconciliation_debt = true, status = 'UNKNOWN' WHERE id = $1",
          [intent.id]
        );

        // -----------------------------------------------------------------------
        // SIMULATE CRASH & RESTART SEQUENCE
        // -----------------------------------------------------------------------
        // 1. In-process memory is wiped (simulated reboot)
        const postRestartGuard = new FinancialExitSafetyGuard();
        assert.equal(postRestartGuard.hasUnresolvedDebt(debtMint), false);

        // 2. Readiness transitions to BOOTING
        setFinancialReadiness('BOOTING', 'Node restart underway');
        assert.equal(isFinancialReady(), false);
        assert.equal(getFinancialReadiness(), 'BOOTING');

        // 3. Readiness transitions to RECOVERING_FINANCIAL_STATE
        setFinancialReadiness('RECOVERING_FINANCIAL_STATE', 'Rehydrating durable exit debts from PostgreSQL');
        assert.equal(isFinancialReady(), false);
        assert.equal(getFinancialReadiness(), 'RECOVERING_FINANCIAL_STATE');

        // 4. Boot recovery queries PostgreSQL for unresolved debts
        const debtRows = await pool.query(`
          SELECT DISTINCT ei.mint, ei.id, ei.status, ei.reconciliation_debt
          FROM exit_intents ei
          LEFT JOIN execution_attempts ea ON ea.intent_id = ei.id
          WHERE ei.status IN ('SUBMITTED', 'UNKNOWN')
             OR ei.reconciliation_debt = true
             OR ea.state IN ('SIGNED', 'SUBMITTED', 'UNKNOWN')
        `);

        assert.ok(debtRows.rows.length > 0, 'Must discover durable debt rows in PostgreSQL');
        for (const row of debtRows.rows) {
          postRestartGuard.registerUnresolvedDebt(String(row.mint));
        }

        // 5. Readiness transitions to READY
        setFinancialReadiness('READY', 'Durable debt recovery complete');
        assert.equal(isFinancialReady(), true);

        // 6. Assert that debtMint is durably locked in safety guard
        assert.equal(postRestartGuard.hasUnresolvedDebt(debtMint), true);

        // 7. Any new exit attempt for debtMint is STRICTLY REJECTED
        const exitAttempt = postRestartGuard.acquireExitLock(debtMint, 7500000n);
        assert.equal(exitAttempt.allowed, false);
        assert.equal(exitAttempt.code, 'UNRESOLVED_RECONCILIATION_DEBT');
        assert.match(exitAttempt.reason || '', /UNRESOLVED_EXECUTION_DEBT/);

        // 8. Clean mint not in debt is NOT blocked
        const cleanMint = Keypair.generate().publicKey.toBase58();
        const cleanExit = postRestartGuard.acquireExitLock(cleanMint, 1000n);
        assert.equal(cleanExit.allowed, true);
        postRestartGuard.releaseExitLock(cleanMint);

        // 9. Debt can only be cleared after explicit reconciliation
        postRestartGuard.clearDebt(debtMint);
        assert.equal(postRestartGuard.hasUnresolvedDebt(debtMint), false);
        const unlockedExit = postRestartGuard.acquireExitLock(debtMint, 7500000n);
        assert.equal(unlockedExit.allowed, true);
        postRestartGuard.releaseExitLock(debtMint);

      } finally {
        await pool.end();
      }
    });
  });

  // =========================================================================
  // FASE 18: Third-party transaction immunity integration test
  // =========================================================================
  describe('FASE 18: Third-party transaction immunity in exact signature reconciliation', () => {
    test('Unrelated wallet transactions (airdrop, SOL transfer, wrong mint) never spoof exact execution attempt', async () => {
      const ownerKeypair = Keypair.generate();
      const ownerAddress = ownerKeypair.publicKey.toBase58();
      const targetMint = 'TargetMint11111111111111111111111111111111';
      const otherMint = 'OtherMint222222222222222222222222222222222';

      const targetSignature = '5TargetExecutionAttemptSignature11111111111111111111111111111111111111111111111111111111';
      const thirdPartyTransferSig = '4ThirdPartySolTransferSignature11111111111111111111111111111111111111111111111111111111';
      const thirdPartyAirdropSig = '3ThirdPartyAirdropOtherMintSignature11111111111111111111111111111111111111111111111111';
      const unrelatedTargetMintSig = '2UnrelatedSwapSameMintDifferentSignature11111111111111111111111111111111111111111111';

      // Mock database of on-chain transactions indexed strictly by signature
      const onChainTransactions = new Map<string, any>();

      // 1. Third-party SOL transfer to the wallet (no token changes)
      onChainTransactions.set(thirdPartyTransferSig, {
        transaction: {
          message: {
            accountKeys: [
              { pubkey: { toBase58: () => 'Sender111111111111111111111111111111111111' } },
              { pubkey: { toBase58: () => ownerAddress } }
            ]
          }
        },
        meta: {
          err: null,
          fee: 5000,
          preBalances: [1_000_000_000, 500_000_000],
          postBalances: [900_000_000, 600_000_000],
          preTokenBalances: [],
          postTokenBalances: []
        },
        blockTime: 1728000100
      });

      // 2. Third-party airdrop on a completely different mint
      onChainTransactions.set(thirdPartyAirdropSig, {
        transaction: {
          message: {
            accountKeys: [{ pubkey: { toBase58: () => ownerAddress } }]
          }
        },
        meta: {
          err: null,
          fee: 5000,
          preBalances: [600_000_000],
          postBalances: [599_995_000],
          preTokenBalances: [
            { mint: otherMint, owner: ownerAddress, uiTokenAmount: { amount: '0' } }
          ],
          postTokenBalances: [
            { mint: otherMint, owner: ownerAddress, uiTokenAmount: { amount: '1000000' } }
          ]
        },
        blockTime: 1728000200
      });

      // 3. Unrelated transaction on target mint with different signature
      onChainTransactions.set(unrelatedTargetMintSig, {
        transaction: {
          message: {
            accountKeys: [{ pubkey: { toBase58: () => ownerAddress } }]
          }
        },
        meta: {
          err: null,
          fee: 5000,
          preBalances: [600_000_000],
          postBalances: [610_000_000],
          preTokenBalances: [
            { mint: targetMint, owner: ownerAddress, uiTokenAmount: { amount: '50000000' } }
          ],
          postTokenBalances: [
            { mint: targetMint, owner: ownerAddress, uiTokenAmount: { amount: '0' } }
          ]
        },
        blockTime: 1728000250
      });

      // 4. Target execution transaction
      onChainTransactions.set(targetSignature, {
        transaction: {
          message: {
            accountKeys: [{ pubkey: { toBase58: () => ownerAddress } }]
          }
        },
        meta: {
          err: null,
          fee: 5000,
          preBalances: [600_000_000],
          postBalances: [650_000_000],
          preTokenBalances: [
            { mint: targetMint, owner: ownerAddress, uiTokenAmount: { amount: '100000000' } }
          ],
          postTokenBalances: [
            { mint: targetMint, owner: ownerAddress, uiTokenAmount: { amount: '0' } }
          ]
        },
        blockTime: 1728000300
      });

      const mockConnection: any = {
        getParsedTransaction: async (signature: string) => {
          return onChainTransactions.get(signature) || null;
        }
      };

      const wallet = new SolanaWalletService({
        secretKeyRaw: JSON.stringify(Array.from(ownerKeypair.secretKey)),
        rpcUrl: 'http://mock-rpc-internal.local'
      });
      // Replace underlying connection with our strictly tracked mock
      (wallet as any).connection = mockConnection;

      // TEST CASE A: Requesting reconciliation for an unconfirmed signature
      // Even though owner's wallet has active recent transactions, reconcileExactTransaction must return null
      const unconfirmedResult = await wallet.reconcileExactTransaction({
        signature: 'NonExistentSignatureOnChain111111111111111111111111111111111111111111111111111111111',
        mintAddress: targetMint,
        expectedOwner: ownerAddress,
        direction: 'OUT'
      });
      assert.equal(unconfirmedResult, null, 'Must NOT match third-party transactions when signature is not on-chain');

      // TEST CASE B: Attempting to query with a third-party SOL transfer signature
      const solTransferResult = await wallet.reconcileExactTransaction({
        signature: thirdPartyTransferSig,
        mintAddress: targetMint,
        expectedOwner: ownerAddress,
        direction: 'OUT'
      });
      assert.equal(solTransferResult, null, 'SOL transfer must not reconcile token exit');

      // TEST CASE C: Attempting to query with third-party airdrop on different mint
      const airdropResult = await wallet.reconcileExactTransaction({
        signature: thirdPartyAirdropSig,
        mintAddress: targetMint,
        expectedOwner: ownerAddress,
        direction: 'OUT'
      });
      assert.equal(airdropResult, null, 'Other mint airdrop must not reconcile target mint');

      // TEST CASE D: Exact target signature reconciles ONLY the exact target transaction
      const targetResult = await wallet.reconcileExactTransaction({
        signature: targetSignature,
        mintAddress: targetMint,
        expectedOwner: ownerAddress,
        direction: 'OUT'
      });

      assert.ok(targetResult);
      assert.equal(targetResult.signature, targetSignature);
      assert.equal(targetResult.deltaAtomic, '-100000000');
      assert.equal(targetResult.walletLamportDelta, 50_000_000);
      assert.equal(targetResult.success, true);
    });
  });

  // =========================================================================
  // FASE 19: End-to-end Adversarial Integration (Simulated Lifecycle)
  // =========================================================================
  describe('FASE 19: End-to-end Adversarial Integration Lifecycle', () => {
    test('Complete happy-path & recovery: Safety lock -> Version Gate -> Mock Execution -> Exact Reconciliation -> Atomic CAS Apply', async () => {
      const guard = new FinancialExitSafetyGuard();
      const reservationMgr = new DispatchReservationManager();
      const journalRepo = new InMemoryExitJournalRepository();
      const positionRepo = new InMemoryPositionRepository();

      const testWallet = 'WalletE2E1111111111111111111111111111111111';
      const testMint = 'MintE2E11111111111111111111111111111111111';
      const testTokenProgram = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
      const initialAmountAtomic = 10_000_000n;

      // 1. Create initial position in repository (v1)
      const position = await positionRepo.createPosition({
        positionId: 'pos_e2e_001',
        tradeId: 'trade_e2e_001',
        walletId: testWallet,
        mint: testMint,
        initialAmountAtomic,
        initialPrincipalLamports: 100_000_000n,
        source: 'MANUAL_ENTRY'
      });
      assert.equal(position.positionVersion, 1n);

      // 2. Pre-execution Safety Lock
      const lockRes = guard.acquireExitLock(testMint, initialAmountAtomic);
      assert.equal(lockRes.allowed, true);

      // Concurrent sell is blocked by in-flight lock
      const collisionRes = guard.acquireExitLock(testMint, initialAmountAtomic);
      assert.equal(collisionRes.allowed, false);
      assert.equal(collisionRes.code, 'IN_FLIGHT_COLLISION');

      // 3. Create Exit Intent in Journal
      const { intent } = await journalRepo.createOrGetIntent({
        id: 'intent_e2e_001' as any,
        tradeId: 'trade_e2e_001' as any,
        positionId: position.positionId as any,
        walletId: testWallet,
        mint: testMint,
        tokenProgram: testTokenProgram,
        requestedAmountAtomic: initialAmountAtomic.toString(),
        amountPolicy: 'FULL_REMAINDER',
        initialSeverity: 'NORMAL',
        reason: 'TAKE_PROFIT',
        policyVersion: '2026-10-04'
      });

      const claim = await journalRepo.claimIntent({
        workerId: 'worker_e2e',
        leaseDurationMs: 10_000,
        intentId: intent.id
      });
      assert.ok(claim);

      // 4. Prepare Attempt
      const attempt = await journalRepo.prepareAttempt({
        attemptId: 'att_e2e_001' as any,
        intentId: intent.id,
        provider: 'JUPITER_V2',
        requestedAmountAtomic: initialAmountAtomic.toString()
      }, claim.claimEpoch);

      // 5. Version Gate: reserve dispatch
      const gateReservation = reservationMgr.reserve({
        positionId: position.positionId,
        expectedVersion: position.positionVersion,
        intentId: intent.id,
        timeoutMs: 5000,
        hasDurableDebt: false
      });
      assert.ok(gateReservation.reservationToken);

      // 6. Execution Broadcast
      const txSig = '5ExecSignatureLandedConfirmed111111111111111111111111111111111111111111111111111111';
      await journalRepo.updateAttemptState(attempt.attemptId, 'SUBMITTED', {
        signature: txSig as any
      }, claim.claimEpoch);

      // 7. Mock Reconciler: exact transaction landing confirmed
      const mockReconciler: WalletTransactionReconciler = {
        reconcileExactTransaction: async (p) => {
          if (p.signature === txSig) {
            return {
              signature: txSig,
              deltaAtomic: `-${initialAmountAtomic.toString()}`,
              walletLamportDelta: 120_000_000,
              feeLamports: 5000,
              blockTimeMs: Date.now(),
              success: true
            };
          }
          return null;
        }
      };

      const reconResult = await reconcileExecutionAttempt({
        attempt: (await journalRepo.getAttemptById(attempt.attemptId))!,
        intent,
        walletReconciler: mockReconciler
      });
      assert.equal(reconResult.status, 'CONFIRMED');

      // 8. Atomic application: confirmed fill -> position closed (v1 -> v2)
      const fillId = 'fill_e2e_001' as any;
      await journalRepo.updateAttemptState(attempt.attemptId, 'CONFIRMED', {}, claim.claimEpoch);

      await journalRepo.recordFill({
        id: fillId,
        tradeId: intent.tradeId,
        positionId: intent.positionId,
        intentId: intent.id,
        attemptId: attempt.attemptId,
        signature: txSig as any,
        realizationSequence: 1,
        chainLegIndex: 0,
        instructionIndex: 3,
        innerInstructionIndex: -1,
        assetMint: testMint,
        requestedAmountAtomic: initialAmountAtomic.toString(),
        actualAmountAtomic: initialAmountAtomic.toString(),
        grossProceedsLamports: '120005000',
        networkFeeLamports: '5000',
        priorityFeeLamports: '0',
        tipLamports: '0',
        rentMovementLamports: '0',
        slot: 123456,
        evidenceType: 'RPC_RECEIPT_V2',
        confirmedAtWallMs: Date.now() as any,
        createdAtWallMs: Date.now() as any
      }, claim.claimEpoch);

      const applyRes = await positionRepo.applyFill({
        positionId: position.positionId,
        expectedVersion: 1n,
        fillId,
        signature: txSig,
        fillAmountAtomic: initialAmountAtomic,
        proceedsLamports: 120_005_000n,
        isFinal: true
      });

      assert.equal(applyRes.position.positionVersion, 2n);
      assert.equal(applyRes.position.tokenAmountAtomic, 0n);
      // Finding 30: recordFill leaves intent in CONFIRMED until terminal transactional apply
      const recordedIntent = await journalRepo.getIntentById(intent.id);
      assert.equal(recordedIntent?.status, 'CONFIRMED');

      await journalRepo.releaseTerminalIntent(intent.id, 'APPLIED', claim.claimEpoch);
      const finalizedIntent = await journalRepo.getIntentById(intent.id);
      assert.equal(finalizedIntent?.status, 'APPLIED');

      // 9. Cleanup reservations & locks
      gateReservation.release();
      guard.releaseExitLock(testMint);

      // Verify no locks or reservations leak
      assert.equal(guard.checkSafeToExit(testMint).canExit, true);
    });
  });
});
