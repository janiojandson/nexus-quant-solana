import test from 'node:test';
import * as assert from 'node:assert/strict';
import {
  InMemoryExitJournalRepository,
  EconomicConflictError,
  AppendOnlyViolationError,
  LeaseRecoveryBlockedError
} from '../../src/journal/repository';
import {
  computeEconomicDedupeKey,
  StaleEpochError,
  ActiveIntentExclusionError
} from '../../src/journal/types';

test('Nexus V2.1A — Idempotency, Durable Claims, Lease Recovery & Crash Simulation (C2)', async (t) => {
  // 1. Duas createIntent simultâneas -> 1 intent econômico
  await t.test('1. duas createIntent simultâneas resultam em exatamente 1 intent econômico', async () => {
    const repo = new InMemoryExitJournalRepository();
    const input = {
      tradeId: 'trade_concurrent_1' as any,
      positionId: 'pos_concurrent_1' as any,
      walletId: 'Wallet1111111111111111111111111111111111',
      mint: '3A75w27ssueStCEEp6KGxKJ3EtP57P9FxT6YxHmDnt7a',
      tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      positionVersion: 1,
      requestedAmountAtomic: '4375826130',
      amountPolicy: 'FULL_REMAINDER' as const,
      initialSeverity: 'NORMAL' as const,
      reason: 'TRAILING_STOP' as const,
      policyVersion: '2026-10-04'
    };

    // Execute concurrently
    const [res1, res2] = await Promise.all([
      repo.createOrGetIntent(input),
      repo.createOrGetIntent(input)
    ]);

    // Exactly one created: true, the other created: false
    const createdCount = (res1.created ? 1 : 0) + (res2.created ? 1 : 0);
    assert.strictEqual(createdCount, 1, 'Only one invocation can claim creation');
    assert.strictEqual(res1.intent.id, res2.intent.id, 'Both must resolve to identical intent ID');
    assert.strictEqual(res1.intent.economicDedupeKey, res2.intent.economicDedupeKey);
  });

  // 2. Dois workers claim -> apenas 1 claim por intent (SKIP LOCKED)
  await t.test('2. dois workers concorrentes realizam claim e apenas um obtém a intent (SKIP LOCKED)', async () => {
    const repo = new InMemoryExitJournalRepository();
    const { intent } = await repo.createOrGetIntent({
      tradeId: 'trade_worker_1' as any,
      positionId: 'pos_worker_1' as any,
      walletId: 'Wallet1111111111111111111111111111111111',
      mint: '3A75w27ssueStCEEp6KGxKJ3EtP57P9FxT6YxHmDnt7a',
      tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      positionVersion: 1,
      requestedAmountAtomic: '4375826130',
      amountPolicy: 'FULL_REMAINDER',
      initialSeverity: 'NORMAL',
      reason: 'TRAILING_STOP',
      policyVersion: '2026-10-04'
    });

    // Worker A and Worker B try to claim simultaneously
    const [claimA, claimB] = await Promise.all([
      repo.claimIntent({ workerId: 'worker_alpha', leaseDurationMs: 10_000 }),
      repo.claimIntent({ workerId: 'worker_beta', leaseDurationMs: 10_000 })
    ]);

    const winner = claimA || claimB;
    const loser = claimA ? claimB : claimA;

    assert.ok(winner !== null, 'One worker must acquire the claim');
    assert.strictEqual(loser, null, 'The other worker must receive null (SKIP LOCKED)');
    assert.strictEqual(winner.id, intent.id);
    assert.strictEqual(winner.status, 'CLAIMED');
    assert.strictEqual(winner.claimEpoch, 1);
    assert.ok(winner.claimedBy === 'worker_alpha' || winner.claimedBy === 'worker_beta');
  });

  // 3. Worker A morre e lease expira -> Worker B recupera apenas se seguro
  await t.test('3. worker A morre com lease expirada em estado seguro -> worker B recupera com epoch incrementado', async () => {
    const repo = new InMemoryExitJournalRepository();
    const baseTime = 1_000_000;
    const leaseDuration = 5_000;

    const { intent } = await repo.createOrGetIntent({
      tradeId: 'trade_lease_1' as any,
      positionId: 'pos_lease_1' as any,
      walletId: 'Wallet1111111111111111111111111111111111',
      mint: '3A75w27ssueStCEEp6KGxKJ3EtP57P9FxT6YxHmDnt7a',
      tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      positionVersion: 1,
      requestedAmountAtomic: '4375826130',
      amountPolicy: 'FULL_REMAINDER',
      initialSeverity: 'NORMAL',
      reason: 'TRAILING_STOP',
      policyVersion: '2026-10-04',
      nowMs: baseTime
    });

    // Worker A claims at baseTime (expires at baseTime + 5000)
    const claimedA = await repo.claimIntent({
      workerId: 'worker_alpha',
      leaseDurationMs: leaseDuration,
      nowMs: baseTime
    });
    assert.strictEqual(claimedA?.claimedBy, 'worker_alpha');
    assert.strictEqual(claimedA?.claimEpoch, 1);

    // Worker B tries to claim at baseTime + 2000 (lease still active) -> rejected
    const midClaim = await repo.claimIntent({
      workerId: 'worker_beta',
      leaseDurationMs: leaseDuration,
      nowMs: baseTime + 2000
    });
    assert.strictEqual(midClaim, null, 'Cannot claim while lease is active');

    // Worker B tries to claim at baseTime + 6000 (lease expired!) -> successfully re-claims
    const recoveredClaim = await repo.claimIntent({
      workerId: 'worker_beta',
      leaseDurationMs: leaseDuration,
      nowMs: baseTime + 6000
    });
    assert.ok(recoveredClaim !== null);
    assert.strictEqual(recoveredClaim.claimedBy, 'worker_beta');
    assert.strictEqual(recoveredClaim.claimEpoch, 2, 'Epoch must increment to 2');
    assert.strictEqual(recoveredClaim.status, 'CLAIMED');
  });

  // 4. Regra Crítica: Lease expirada com attempt em SUBMITTED / SIGNED / UNKNOWN NÃO permite re-claim cego
  await t.test('4. lease expirada com attempt em SUBMITTED / SIGNED / UNKNOWN bloqueia re-claim sem reconciliação prévia', async () => {
    const repo = new InMemoryExitJournalRepository();
    const baseTime = 1_000_000;
    const leaseDuration = 5_000;

    const { intent } = await repo.createOrGetIntent({
      tradeId: 'trade_blind_1' as any,
      positionId: 'pos_blind_1' as any,
      walletId: 'Wallet1111111111111111111111111111111111',
      mint: '3A75w27ssueStCEEp6KGxKJ3EtP57P9FxT6YxHmDnt7a',
      tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      positionVersion: 1,
      requestedAmountAtomic: '4375826130',
      amountPolicy: 'FULL_REMAINDER',
      initialSeverity: 'NORMAL',
      reason: 'TRAILING_STOP',
      policyVersion: '2026-10-04',
      nowMs: baseTime
    });

    // Worker A claims and submits transaction
    await repo.claimIntent({ workerId: 'worker_alpha', leaseDurationMs: leaseDuration, nowMs: baseTime });
    const attempt = await repo.prepareAttempt({
      attemptId: 'att_submitted_1' as any,
      intentId: intent.id,
      provider: 'JUPITER_V2',
      requestedAmountAtomic: '4375826130',
      initialState: 'ORDER_READY',
      nowMs: baseTime + 100
    });

    // Attempt advances to SUBMITTED
    await repo.updateAttemptState(attempt.attemptId, 'SUBMITTED', {
      signature: '5nwz7eVDSU4MnT3zzmXyP9kg6w1Uo99GDz8qiZtMkcqUebeLgLbXFMtPpgpZtZ36estEnFhS43JyoYGoKp5xHyTN' as any,
      submittedAtWallMs: (baseTime + 200) as any
    });

    // Worker A crashes! Lease expires at baseTime + 6000.
    // Worker B attempts to re-claim.
    // MUST THROW LeaseRecoveryBlockedError because on-chain broadcast was sent!
    await assert.rejects(
      () => repo.claimIntent({ workerId: 'worker_beta', leaseDurationMs: leaseDuration, nowMs: baseTime + 6000 }),
      LeaseRecoveryBlockedError
    );
  });

  // 5. Cenário UNKNOWN: Attempt SUBMITTED -> processo perde resposta -> UNKNOWN -> Reconciliação confirma fill
  await t.test('5. tentativa SUBMITTED entra em UNKNOWN; ao reiniciar, reconciliação confirma sem re-envio', async () => {
    const repo = new InMemoryExitJournalRepository();
    const baseTime = 2_000_000;

    const { intent } = await repo.createOrGetIntent({
      tradeId: 'trade_unknown_flow' as any,
      positionId: 'pos_unknown_flow' as any,
      walletId: 'Wallet1111111111111111111111111111111111',
      mint: '3A75w27ssueStCEEp6KGxKJ3EtP57P9FxT6YxHmDnt7a',
      tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      positionVersion: 1,
      requestedAmountAtomic: '4375826130',
      amountPolicy: 'FULL_REMAINDER',
      initialSeverity: 'NORMAL',
      reason: 'TRAILING_STOP',
      policyVersion: '2026-10-04',
      nowMs: baseTime
    });

    await repo.claimIntent({ workerId: 'worker_alpha', leaseDurationMs: 10_000, nowMs: baseTime });
    const attempt = await repo.prepareAttempt({
      attemptId: 'att_unknown_1' as any,
      intentId: intent.id,
      provider: 'JUPITER_V2',
      requestedAmountAtomic: '4375826130',
      initialState: 'ORDER_READY'
    });

    const txSig = '5nwz7eVDSU4MnT3zzmXyP9kg6w1Uo99GDz8qiZtMkcqUebeLgLbXFMtPpgpZtZ36estEnFhS43JyoYGoKp5xHyTN';
    await repo.updateAttemptState(attempt.attemptId, 'SUBMITTED', { signature: txSig as any });

    // Process loses HTTP socket -> marks UNKNOWN (UNKNOWN NÃO É FAILED!)
    await repo.updateAttemptState(attempt.attemptId, 'UNKNOWN', { failureReason: 'HTTP_SOCKET_TIMEOUT' });
    const unknownIntent = await repo.getIntentById(intent.id);
    assert.strictEqual(unknownIntent?.status, 'UNKNOWN');
    assert.notStrictEqual(unknownIntent?.status, 'FAILED_DEFINITIVE');

    // Simulate crash and restart: snapshot and restore repo
    const snapshot = repo.snapshotState();
    const restartedRepo = InMemoryExitJournalRepository.restoreFromSnapshot(snapshot);

    // Upon restart: Worker must NOT emit a new sell! It checks on-chain evidence
    const savedAttempt = await restartedRepo.getAttemptById(attempt.attemptId);
    assert.strictEqual(savedAttempt?.state, 'UNKNOWN');
    assert.strictEqual(savedAttempt?.signature, txSig);

    // Reconciliation event: On-chain query confirms transaction was confirmed on-chain!
    await restartedRepo.recordReconciliationEvent({
      attemptId: savedAttempt.attemptId,
      signature: savedAttempt.signature,
      verdict: 'CONFIRMED',
      reason: 'On-chain transaction found confirmed in slot 452790108',
      onChainStatus: 'SUCCESS',
      blockhashValid: true
    });

    // Record the on-chain fill idempotently
    const fillResult = await restartedRepo.recordFill({
      id: 'fill_reconciled_1' as any,
      tradeId: intent.tradeId,
      positionId: intent.positionId,
      intentId: intent.id,
      attemptId: savedAttempt.attemptId,
      signature: txSig as any,
      realizationSequence: 1,
      chainLegIndex: 0,
      instructionIndex: 3,
      innerInstructionIndex: -1,
      requestedAmountAtomic: '4375826130',
      actualAmountAtomic: '4375826130',
      grossProceedsLamports: '41149',
      networkFeeLamports: '5000',
      priorityFeeLamports: '50000',
      tipLamports: '0',
      rentMovementLamports: '0',
      slot: 452790108,
      commitment: 'confirmed',
      confirmedAtWallMs: (baseTime + 5000) as any,
      evidenceType: 'CHAIN_PARSED_TRANSACTION',
      createdAtWallMs: (baseTime + 5000) as any
    });

    assert.strictEqual(fillResult.created, true);
    const finalizedIntent = await restartedRepo.getIntentById(intent.id);
    assert.strictEqual(finalizedIntent?.status, 'APPLIED');
  });

  // 6. Testes de Crash em cada estágio do ciclo de vida
  await t.test('6. crash e restart simulados em 8 estágios sucessivos garantem zero double-apply', async () => {
    let repo = new InMemoryExitJournalRepository();
    const baseTime = 3_000_000;

    // Estágio 1: Crash antes do intent
    repo = InMemoryExitJournalRepository.restoreFromSnapshot(repo.snapshotState());
    assert.strictEqual((await repo.getFillsForTrade('trade_crash_stage')).length, 0);

    // Estágio 2: Cria intent -> Crash
    const { intent } = await repo.createOrGetIntent({
      tradeId: 'trade_crash_stage' as any,
      positionId: 'pos_crash_stage' as any,
      walletId: 'Wallet1111111111111111111111111111111111',
      mint: '3A75w27ssueStCEEp6KGxKJ3EtP57P9FxT6YxHmDnt7a',
      tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      positionVersion: 1,
      requestedAmountAtomic: '4375826130',
      amountPolicy: 'FULL_REMAINDER',
      initialSeverity: 'NORMAL',
      reason: 'TRAILING_STOP',
      policyVersion: '2026-10-04',
      nowMs: baseTime
    });
    repo = InMemoryExitJournalRepository.restoreFromSnapshot(repo.snapshotState());
    assert.strictEqual((await repo.getIntentById(intent.id))?.status, 'CREATED');

    // Estágio 3: Claim -> Crash
    await repo.claimIntent({ workerId: 'worker_crash_tester', leaseDurationMs: 10_000, nowMs: baseTime + 10 });
    repo = InMemoryExitJournalRepository.restoreFromSnapshot(repo.snapshotState());
    assert.strictEqual((await repo.getIntentById(intent.id))?.status, 'CLAIMED');

    // Estágio 4: PREPARED -> Crash
    const attempt = await repo.prepareAttempt({
      attemptId: 'att_crash_1' as any,
      intentId: intent.id,
      provider: 'JUPITER_V2',
      requestedAmountAtomic: '4375826130',
      initialState: 'ORDER_READY',
      nowMs: baseTime + 20
    });
    repo = InMemoryExitJournalRepository.restoreFromSnapshot(repo.snapshotState());
    assert.strictEqual((await repo.getAttemptById(attempt.attemptId))?.state, 'ORDER_READY');
    assert.strictEqual((await repo.getIntentById(intent.id))?.status, 'PREPARED');

    // Estágio 5: SIGNED -> Crash
    await repo.updateAttemptState(attempt.attemptId, 'SIGNED', {
      signature: 'sig_crash_stage_123' as any
    });
    repo = InMemoryExitJournalRepository.restoreFromSnapshot(repo.snapshotState());
    assert.strictEqual((await repo.getAttemptById(attempt.attemptId))?.state, 'SIGNED');

    // Estágio 6: SUBMITTED -> Crash
    await repo.updateAttemptState(attempt.attemptId, 'SUBMITTED', {
      submittedAtWallMs: (baseTime + 30) as any
    });
    repo = InMemoryExitJournalRepository.restoreFromSnapshot(repo.snapshotState());
    assert.strictEqual((await repo.getAttemptById(attempt.attemptId))?.state, 'SUBMITTED');
    assert.strictEqual((await repo.getIntentById(intent.id))?.status, 'SUBMITTED');

    // Estágio 7: PROVIDER_SUCCESS / CONFIRMED -> Crash
    await repo.updateAttemptState(attempt.attemptId, 'CONFIRMED', {
      confirmedAtWallMs: (baseTime + 40) as any
    });
    repo = InMemoryExitJournalRepository.restoreFromSnapshot(repo.snapshotState());
    assert.strictEqual((await repo.getAttemptById(attempt.attemptId))?.state, 'CONFIRMED');

    // Estágio 8: CONFIRMED antes de APPLIED -> Grava Fill -> APPLIED
    const fillPayload = {
      id: 'fill_crash_stage_1' as any,
      tradeId: intent.tradeId,
      positionId: intent.positionId,
      intentId: intent.id,
      attemptId: attempt.attemptId,
      signature: 'sig_crash_stage_123' as any,
      realizationSequence: 1,
      chainLegIndex: 0,
      instructionIndex: 3,
      innerInstructionIndex: -1,
      requestedAmountAtomic: '4375826130',
      actualAmountAtomic: '4375826130',
      grossProceedsLamports: '41149',
      networkFeeLamports: '5000',
      priorityFeeLamports: '50000',
      tipLamports: '0',
      rentMovementLamports: '0',
      slot: 452790108,
      commitment: 'confirmed',
      confirmedAtWallMs: (baseTime + 50) as any,
      evidenceType: 'CHAIN_PARSED_TRANSACTION' as const,
      createdAtWallMs: (baseTime + 50) as any
    };

    const record1 = await repo.recordFill(fillPayload);
    assert.strictEqual(record1.created, true);
    assert.strictEqual((await repo.getIntentById(intent.id))?.status, 'APPLIED');

    // Replay / Retry do mesmo fill após restart
    repo = InMemoryExitJournalRepository.restoreFromSnapshot(repo.snapshotState());
    const record2 = await repo.recordFill(fillPayload);
    assert.strictEqual(record2.created, false, 'Replaying confirmed fill MUST NOT create second fill');

    // Total fills for trade must be strictly 1
    const fills = await repo.getFillsForTrade(intent.tradeId);
    assert.strictEqual(fills.length, 1);
  });

  // 7. Teste Worker Zombie: worker A (epoch 1) expira -> worker B (epoch 2) assume -> commit de A com epoch 1 é rejeitado
  await t.test('7. worker zombie: worker A expira, worker B assume (epoch incrementado) e mutação de A com epoch defasado é rejeitada', async () => {
    const repo = new InMemoryExitJournalRepository();
    const baseTime = 4_000_000;
    const leaseDuration = 5_000;

    const { intent } = await repo.createOrGetIntent({
      tradeId: 'trade_zombie_1' as any,
      positionId: 'pos_zombie_1' as any,
      walletId: 'Wallet1111111111111111111111111111111111',
      mint: '3A75w27ssueStCEEp6KGxKJ3EtP57P9FxT6YxHmDnt7a',
      tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      positionVersion: 1,
      requestedAmountAtomic: '4375826130',
      amountPolicy: 'FULL_REMAINDER',
      initialSeverity: 'NORMAL',
      reason: 'TRAILING_STOP',
      policyVersion: '2026-10-04',
      nowMs: baseTime
    });

    // Worker A claims at epoch 1
    const claimA = await repo.claimIntent({
      workerId: 'worker_alpha',
      leaseDurationMs: leaseDuration,
      nowMs: baseTime
    });
    assert.strictEqual(claimA?.claimEpoch, 1);

    // Worker A prepares attempt under epoch 1
    const attemptA = await repo.prepareAttempt({
      attemptId: 'att_zombie_alpha' as any,
      intentId: intent.id,
      provider: 'JUPITER_V2',
      requestedAmountAtomic: '4375826130',
      initialState: 'ORDER_READY',
      nowMs: baseTime + 100
    }, 1);

    // Lease of Worker A expires at baseTime + 6000
    // Worker B claims at baseTime + 6000 -> gets claimEpoch = 2
    const claimB = await repo.claimIntent({
      workerId: 'worker_beta',
      leaseDurationMs: leaseDuration,
      nowMs: baseTime + 6000
    });
    assert.strictEqual(claimB?.claimedBy, 'worker_beta');
    assert.strictEqual(claimB?.claimEpoch, 2);

    // Zombie Worker A wakes up and attempts to update attempt state or commit a fill using epoch 1
    // Database / Repo fencing must REJECT with StaleEpochError (simulating WHERE claim_epoch = 1 -> 0 rows affected)
    await assert.rejects(
      () => repo.updateAttemptState(attemptA.attemptId, 'ORDER_READY', { requestId: 'req_stale' }, 1),
      (err: any) => {
        assert.ok(err instanceof StaleEpochError);
        assert.strictEqual(err.expectedEpoch, 1);
        assert.strictEqual(err.actualEpoch, 2);
        return true;
      }
    );

    // Zombie Worker A also attempts to record a fill with epoch 1 -> REJECTED
    await assert.rejects(
      () => repo.recordFill({
        id: 'fill_zombie_stale' as any,
        tradeId: intent.tradeId,
        positionId: intent.positionId,
        intentId: intent.id,
        attemptId: attemptA.attemptId,
        signature: 'sig_stale_zombie' as any,
        realizationSequence: 1,
        chainLegIndex: 0,
        instructionIndex: 3,
        innerInstructionIndex: -1,
        requestedAmountAtomic: '4375826130',
        actualAmountAtomic: '4375826130',
        grossProceedsLamports: '41149',
        networkFeeLamports: '5000',
        priorityFeeLamports: '50000',
        tipLamports: '0',
        rentMovementLamports: '0',
        slot: 452790108,
        commitment: 'confirmed',
        confirmedAtWallMs: (baseTime + 7000) as any,
        evidenceType: 'CHAIN_PARSED_TRANSACTION',
        createdAtWallMs: (baseTime + 7000) as any
      }, 1),
      StaleEpochError
    );
  });

  // 8. Teste Worker Zombie Variante: A já tinha SUBMITTED transação antes de perder lease -> B NÃO pode enviar outra (MUST_RECONCILE)
  await t.test('8. variante zombie: A submeteu na blockchain antes de perder lease -> re-claim é bloqueado e exige reconciliação', async () => {
    const repo = new InMemoryExitJournalRepository();
    const baseTime = 5_000_000;
    const leaseDuration = 5_000;

    const { intent } = await repo.createOrGetIntent({
      tradeId: 'trade_submitted_zombie' as any,
      positionId: 'pos_submitted_zombie' as any,
      walletId: 'Wallet1111111111111111111111111111111111',
      mint: '3A75w27ssueStCEEp6KGxKJ3EtP57P9FxT6YxHmDnt7a',
      tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      positionVersion: 1,
      requestedAmountAtomic: '4375826130',
      amountPolicy: 'FULL_REMAINDER',
      initialSeverity: 'NORMAL',
      reason: 'TRAILING_STOP',
      policyVersion: '2026-10-04',
      nowMs: baseTime
    });

    // Worker A claims at epoch 1
    await repo.claimIntent({ workerId: 'worker_alpha', leaseDurationMs: leaseDuration, nowMs: baseTime });
    const attempt = await repo.prepareAttempt({
      attemptId: 'att_submitted_variant' as any,
      intentId: intent.id,
      provider: 'JUPITER_V2',
      requestedAmountAtomic: '4375826130',
      initialState: 'ORDER_READY',
      nowMs: baseTime + 100
    }, 1);

    // Worker A successfully broadcasts to network (SUBMITTED)
    await repo.updateAttemptState(attempt.attemptId, 'SUBMITTED', {
      signature: '5nwz7eVDSU4MnT3zzmXyP9kg6w1Uo99GDz8qiZtMkcqUebeLgLbXFMtPpgpZtZ36estEnFhS43JyoYGoKp5xHyTN' as any
    }, 1);

    // Intent must have reconciliationDebt = true
    const currentIntent = await repo.getIntentById(intent.id);
    assert.strictEqual(currentIntent?.reconciliationDebt, true);

    // Lease of Worker A expires at baseTime + 6000
    // Worker B attempts to claim the expired lease -> MUST FAIL with LeaseRecoveryBlockedError
    await assert.rejects(
      () => repo.claimIntent({ workerId: 'worker_beta', leaseDurationMs: leaseDuration, nowMs: baseTime + 6000 }),
      (err: any) => {
        assert.ok(err instanceof LeaseRecoveryBlockedError);
        assert.strictEqual(err.blockingAttemptState, 'SUBMITTED');
        return true;
      }
    );
  });

  // 9. Teste de Exclusão Ativa: Partial Unique Index / Active Intent Exclusion no mesmo (walletId, mint)
  await t.test('9. exclusão ativa: impede 2 intents ativas concorrendo pelo mesmo (walletId, mint)', async () => {
    const repo = new InMemoryExitJournalRepository();
    const walletId = 'Wallet1111111111111111111111111111111111';
    const mint = '3A75w27ssueStCEEp6KGxKJ3EtP57P9FxT6YxHmDnt7a';

    // Cria intent 1 para 1000 tokens
    const { intent: intent1 } = await repo.createOrGetIntent({
      tradeId: 'trade_excl_1' as any,
      positionId: 'pos_excl_1' as any,
      walletId,
      mint,
      tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      positionVersion: 1,
      requestedAmountAtomic: '1000',
      amountPolicy: 'CUSTOM',
      initialSeverity: 'NORMAL',
      reason: 'TAKE_PROFIT_PARTIAL',
      policyVersion: '2026-10-04'
    });
    assert.strictEqual(intent1.status, 'CREATED');

    // Tenta criar intent 2 para mesma wallet e mint mas com parâmetros diferentes (ex: 2000 tokens)
    // Enquanto intent 1 está CREATED (economicamente ativa), criação DEVE ser rejeitada com ActiveIntentExclusionError
    await assert.rejects(
      () => repo.createOrGetIntent({
        tradeId: 'trade_excl_2' as any,
        positionId: 'pos_excl_2' as any,
        walletId,
        mint,
        tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
        positionVersion: 2,
        requestedAmountAtomic: '2000',
        amountPolicy: 'FULL_REMAINDER',
        initialSeverity: 'HIGH',
        reason: 'STOP_LOSS',
        policyVersion: '2026-10-04'
      }),
      (err: any) => {
        assert.ok(err instanceof ActiveIntentExclusionError);
        assert.strictEqual(err.walletId, walletId);
        assert.strictEqual(err.mint, mint);
        assert.strictEqual(err.activeIntentId, intent1.id);
        return true;
      }
    );

    // Finaliza intent 1 (APPLIED via fill)
    await repo.claimIntent({ workerId: 'worker_excl', leaseDurationMs: 10_000 });
    const attempt = await repo.prepareAttempt({
      attemptId: 'att_excl_1' as any,
      intentId: intent1.id,
      provider: 'JUPITER_V2',
      requestedAmountAtomic: '1000',
      initialState: 'ORDER_READY'
    });
    await repo.recordFill({
      id: 'fill_excl_1' as any,
      tradeId: intent1.tradeId,
      positionId: intent1.positionId,
      intentId: intent1.id,
      attemptId: attempt.attemptId,
      signature: 'sig_excl_done' as any,
      realizationSequence: 1,
      chainLegIndex: 0,
      instructionIndex: 3,
      innerInstructionIndex: -1,
      requestedAmountAtomic: '1000',
      actualAmountAtomic: '1000',
      grossProceedsLamports: '10000',
      networkFeeLamports: '5000',
      priorityFeeLamports: '0',
      tipLamports: '0',
      rentMovementLamports: '0',
      evidenceType: 'CHAIN_PARSED_TRANSACTION',
      confirmedAtWallMs: 1000 as any,
      createdAtWallMs: 1000 as any
    });

    const finalIntent1 = await repo.getIntentById(intent1.id);
    assert.strictEqual(finalIntent1?.status, 'APPLIED');

    // Agora que intent 1 é terminal (APPLIED), a intent 2 pode ser criada com sucesso
    const { intent: intent2, created } = await repo.createOrGetIntent({
      tradeId: 'trade_excl_2' as any,
      positionId: 'pos_excl_2' as any,
      walletId,
      mint,
      tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      positionVersion: 2,
      requestedAmountAtomic: '2000',
      amountPolicy: 'FULL_REMAINDER',
      initialSeverity: 'HIGH',
      reason: 'STOP_LOSS',
      policyVersion: '2026-10-04'
    });

    assert.strictEqual(created, true);
    assert.strictEqual(intent2.status, 'CREATED');
  });

  // 10. Teste Crash After Send: claim epoch 5 -> attempt -> sign -> submit -> crash -> restart -> reconcile
  await t.test('10. crash after send: claim epoch 5, submete, crash; restart carrega estado sem reenviar, reconcilia e confirma fill', async () => {
    let repo = new InMemoryExitJournalRepository();
    const baseTime = 6_000_000;

    const { intent } = await repo.createOrGetIntent({
      tradeId: 'trade_crash_send' as any,
      positionId: 'pos_crash_send' as any,
      walletId: 'Wallet1111111111111111111111111111111111',
      mint: '3A75w27ssueStCEEp6KGxKJ3EtP57P9FxT6YxHmDnt7a',
      tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      positionVersion: 1,
      requestedAmountAtomic: '4375826130',
      amountPolicy: 'FULL_REMAINDER',
      initialSeverity: 'NORMAL',
      reason: 'TRAILING_STOP',
      policyVersion: '2026-10-04',
      nowMs: baseTime
    });

    // Simula que houve 4 claims anteriores que expiraram sem submissão de transação
    for (let i = 1; i <= 4; i++) {
      await repo.claimIntent({ workerId: `worker_${i}`, leaseDurationMs: 100, nowMs: baseTime + i * 200 });
    }
    const claim5 = await repo.claimIntent({ workerId: 'worker_5', leaseDurationMs: 10_000, nowMs: baseTime + 1000 });
    assert.strictEqual(claim5?.claimEpoch, 5);

    // Persiste Attempt
    const attempt = await repo.prepareAttempt({
      attemptId: 'att_crash_send_1' as any,
      intentId: intent.id,
      provider: 'JUPITER_V2',
      requestedAmountAtomic: '4375826130',
      initialState: 'ORDER_READY',
      nowMs: baseTime + 1100
    }, 5);

    // Sign & Submit
    const txSig = 'sig_blockchain_in_flight_1234567890';
    await repo.updateAttemptState(attempt.attemptId, 'SIGNED', { signature: txSig as any }, 5);
    await repo.updateAttemptState(attempt.attemptId, 'SUBMITTED', { submittedAtWallMs: (baseTime + 1200) as any }, 5);

    // Process Crash!
    const crashSnapshot = repo.snapshotState();

    // Restart: Fresh process boots and restores snapshot
    repo = InMemoryExitJournalRepository.restoreFromSnapshot(crashSnapshot);

    // Confirma estado restaurado: Intent SUBMITTED, reconciliationDebt = true
    const restoredIntent = await repo.getIntentById(intent.id);
    assert.strictEqual(restoredIntent?.status, 'SUBMITTED');
    assert.strictEqual(restoredIntent?.reconciliationDebt, true);

    const restoredAttempt = await repo.getAttemptById(attempt.attemptId);
    assert.strictEqual(restoredAttempt?.state, 'SUBMITTED');
    assert.strictEqual(restoredAttempt?.signature, txSig);

    // Tentativa de novo claim por outro worker é BLOQUEADA
    await assert.rejects(
      () => repo.claimIntent({ workerId: 'worker_reboot', leaseDurationMs: 10_000, nowMs: baseTime + 20_000 }),
      LeaseRecoveryBlockedError
    );

    // Reconciliador consulta a blockchain pelo txSig e confirma a transação
    await repo.recordReconciliationEvent({
      attemptId: restoredAttempt.attemptId,
      signature: restoredAttempt.signature,
      verdict: 'CONFIRMED',
      reason: 'Confirmed on-chain in slot 452800100',
      onChainStatus: 'SUCCESS',
      blockhashValid: true
    });

    // Registra Fill Idempotente
    const fillResult = await repo.recordFill({
      id: 'fill_crash_send_1' as any,
      tradeId: intent.tradeId,
      positionId: intent.positionId,
      intentId: intent.id,
      attemptId: restoredAttempt.attemptId,
      signature: txSig as any,
      realizationSequence: 1,
      chainLegIndex: 0,
      instructionIndex: 3,
      innerInstructionIndex: -1,
      requestedAmountAtomic: '4375826130',
      actualAmountAtomic: '4375826130',
      grossProceedsLamports: '41149',
      networkFeeLamports: '5000',
      priorityFeeLamports: '50000',
      tipLamports: '0',
      rentMovementLamports: '0',
      slot: 452800100,
      commitment: 'confirmed',
      confirmedAtWallMs: (baseTime + 1300) as any,
      evidenceType: 'CHAIN_PARSED_TRANSACTION',
      createdAtWallMs: (baseTime + 1300) as any
    });

    assert.strictEqual(fillResult.created, true);

    const completedIntent = await repo.getIntentById(intent.id);
    assert.strictEqual(completedIntent?.status, 'APPLIED');
    assert.strictEqual(completedIntent?.reconciliationDebt, false);
  });
});
