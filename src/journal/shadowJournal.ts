/**
 * Nexus Quant Solana — V2.1A Shadow Exit Journal & Historical Replay
 *
 * Operational rules:
 * 1. Default disabled: NEXUS_V2_JOURNAL_SHADOW_ENABLED must default to false.
 * 2. Non-authoritative: In shadow mode, recording is passive; failures never impact trading.
 * 3. Historical Replay: Reconstructs deterministic ExitIntents, Attempts, Fills, and
 *    Reconciliation events from the 4 historical audit incidents (Tesla, SSI, Mr Beast, SUPERPIG).
 */

import * as path from 'path';
import * as fs from 'fs';
import {
  IExitJournalRepository,
  CreateIntentInput
} from './repository';
import {
  ExitIntent,
  ExecutionAttempt,
  FillRecord,
  ExecutionReconciliationEvent,
  computeEconomicDedupeKey
} from './types';
import { evaluateReconciliationState } from './reconciliation';
import {
  createInitialPositionAccounting,
  applyFillToAccounting,
  PositionAccountingSnapshot
} from './accounting';

export function isShadowJournalEnabled(): boolean {
  return process.env.NEXUS_V2_JOURNAL_SHADOW_ENABLED === 'true';
}

export function syntheticReplayId(
  entity: 'intent' | 'attempt' | 'fill' | 'rec',
  incident: string,
  suffix: string | number
): string {
  return `synth_${entity}_${incident}_${suffix}`;
}

export interface IncidentReplayJournalSummary {
  readonly incidentId: string;
  readonly intent: ExitIntent;
  readonly attempts: ExecutionAttempt[];
  readonly fills: FillRecord[];
  readonly reconciliations: ExecutionReconciliationEvent[];
  readonly accounting: PositionAccountingSnapshot;
}

/**
 * Reconstructs journal lifecycle for a historical incident.
 */
export async function reconstructIncidentJournal(
  incidentKey: 'tesla' | 'ssi' | 'mr-beast' | 'superpig',
  repo: IExitJournalRepository,
  fixturesRootDir?: string
): Promise<IncidentReplayJournalSummary> {
  const root = fixturesRootDir || path.join(__dirname, '../../test/fixtures/incidents');
  const incidentDir = path.join(root, incidentKey);

  const manifest = JSON.parse(fs.readFileSync(path.join(incidentDir, 'manifest.json'), 'utf8'));
  const txs: Array<{ signature: string; slot?: number; err?: unknown }> = JSON.parse(
    fs.readFileSync(path.join(incidentDir, 'transactions.json'), 'utf8')
  );
  const expected = JSON.parse(fs.readFileSync(path.join(incidentDir, 'expected.json'), 'utf8'));

  const incidentId = manifest.incidentId;
  const walletId = 'Wallet1111111111111111111111111111111111';
  const mint = txs[0]?.signature ? `Mint_${incidentKey}` : 'MintUnknown';
  const tokenProgram = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
  const requestedAtomic = '1000000000';

  if (incidentKey === 'tesla') {
    // Tesla: Trailing Stop / Price Gap -> Submitted and confirmed on-chain
    const intentRes = await repo.createOrGetIntent({
      id: syntheticReplayId('intent', 'tesla', '1') as any,
      tradeId: 'trade_tesla_historical' as any,
      positionId: 'pos_tesla_historical' as any,
      walletId,
      mint,
      tokenProgram,
      positionVersion: 1,
      requestedAmountAtomic: requestedAtomic,
      amountPolicy: 'FULL_REMAINDER',
      initialSeverity: 'HIGH',
      reason: 'TRAILING_STOP',
      policyVersion: '2026-10-04'
    });

    await repo.claimIntent({ workerId: 'worker_shadow', leaseDurationMs: 30_000 });

    const attempt = await repo.prepareAttempt({
      attemptId: syntheticReplayId('attempt', 'tesla', '1') as any,
      intentId: intentRes.intent.id,
      provider: 'JUPITER_V2',
      requestedAmountAtomic: requestedAtomic,
      initialState: 'ORDER_READY'
    }, 1);

    const sig = txs[0]?.signature || '39ewp5zPn2Yt2R2XKPcYjeYzfEUaCbaYxrUvjeKAcxDXurNmHkax2NQgt7Tf2ohsGfzPGETVjNZcEyTiJDp1QEb4';
    await repo.updateAttemptState(attempt.attemptId, 'SUBMITTED', { signature: sig as any }, 1);
    await repo.updateAttemptState(attempt.attemptId, 'CONFIRMED', {}, 1);

    const fillRes = await repo.recordFill({
      id: syntheticReplayId('fill', 'tesla', '1') as any,
      tradeId: intentRes.intent.tradeId,
      positionId: intentRes.intent.positionId,
      intentId: intentRes.intent.id,
      attemptId: attempt.attemptId,
      signature: sig as any,
      realizationSequence: 1,
      chainLegIndex: 0,
      instructionIndex: 3,
      innerInstructionIndex: -1,
      requestedAmountAtomic: requestedAtomic,
      actualAmountAtomic: requestedAtomic,
      grossProceedsLamports: '41149',
      networkFeeLamports: '5000',
      priorityFeeLamports: '50000',
      tipLamports: '0',
      rentMovementLamports: '0',
      slot: txs[0]?.slot ?? 452790108,
      evidenceType: 'HISTORICAL_RECONSTRUCTION',
      confirmedAtWallMs: 1_700_000_000_000 as any,
      createdAtWallMs: 1_700_000_000_000 as any
    }, 1);

    const initialAcc = createInitialPositionAccounting({
      tradeId: intentRes.intent.tradeId,
      positionId: intentRes.intent.positionId,
      mint,
      initialTokensAtomic: requestedAtomic,
      initialPrincipalLamports: '20000000' // 0.02 SOL
    });
    const finalAcc = applyFillToAccounting(initialAcc, fillRes.fill);

    return {
      incidentId,
      intent: (await repo.getIntentById(intentRes.intent.id))!,
      attempts: [await repo.getAttemptById(attempt.attemptId) as any],
      fills: [fillRes.fill],
      reconciliations: [],
      accounting: finalAcc
    };
  }

  if (incidentKey === 'ssi') {
    // SSI: Liquidity Drain / Panic -> Submitted and confirmed
    const intentRes = await repo.createOrGetIntent({
      id: syntheticReplayId('intent', 'ssi', '1') as any,
      tradeId: 'trade_ssi_historical' as any,
      positionId: 'pos_ssi_historical' as any,
      walletId,
      mint,
      tokenProgram,
      positionVersion: 1,
      requestedAmountAtomic: requestedAtomic,
      amountPolicy: 'FULL_REMAINDER',
      initialSeverity: 'EMERGENCY',
      reason: 'PANIC',
      policyVersion: '2026-10-04'
    });

    await repo.claimIntent({ workerId: 'worker_shadow', leaseDurationMs: 30_000 });

    const attempt = await repo.prepareAttempt({
      attemptId: syntheticReplayId('attempt', 'ssi', '1') as any,
      intentId: intentRes.intent.id,
      provider: 'JUPITER_V2',
      requestedAmountAtomic: requestedAtomic,
      initialState: 'ORDER_READY'
    }, 1);

    const sig = txs[0]?.signature || '4Vq6ahBPh8RdnAp84xLEze4igS3jg8bwgYWxVS3Goy2UqY6TenkPDymizNNMQESriFnoXh5HXM3z4bkZds5YqkoT';
    await repo.updateAttemptState(attempt.attemptId, 'SUBMITTED', { signature: sig as any }, 1);
    await repo.updateAttemptState(attempt.attemptId, 'CONFIRMED', {}, 1);

    const fillRes = await repo.recordFill({
      id: syntheticReplayId('fill', 'ssi', '1') as any,
      tradeId: intentRes.intent.tradeId,
      positionId: intentRes.intent.positionId,
      intentId: intentRes.intent.id,
      attemptId: attempt.attemptId,
      signature: sig as any,
      realizationSequence: 1,
      chainLegIndex: 0,
      instructionIndex: 3,
      innerInstructionIndex: -1,
      requestedAmountAtomic: requestedAtomic,
      actualAmountAtomic: requestedAtomic,
      grossProceedsLamports: '1000000',
      networkFeeLamports: '5000',
      priorityFeeLamports: '50000',
      tipLamports: '0',
      rentMovementLamports: '0',
      slot: txs[0]?.slot ?? 452790200,
      evidenceType: 'HISTORICAL_RECONSTRUCTION',
      confirmedAtWallMs: 1_700_000_000_000 as any,
      createdAtWallMs: 1_700_000_000_000 as any
    }, 1);

    const initialAcc = createInitialPositionAccounting({
      tradeId: intentRes.intent.tradeId,
      positionId: intentRes.intent.positionId,
      mint,
      initialTokensAtomic: requestedAtomic,
      initialPrincipalLamports: '50000000'
    });
    const finalAcc = applyFillToAccounting(initialAcc, fillRes.fill);

    return {
      incidentId,
      intent: (await repo.getIntentById(intentRes.intent.id))!,
      attempts: [await repo.getAttemptById(attempt.attemptId) as any],
      fills: [fillRes.fill],
      reconciliations: [],
      accounting: finalAcc
    };
  }

  if (incidentKey === 'mr-beast') {
    // Mr Beast: Multiple tranches / partial exits
    const intentRes = await repo.createOrGetIntent({
      id: syntheticReplayId('intent', 'mrbeast', '1') as any,
      tradeId: 'trade_mrbeast_historical' as any,
      positionId: 'pos_mrbeast_historical' as any,
      walletId,
      mint,
      tokenProgram,
      positionVersion: 1,
      requestedAmountAtomic: '2000000000',
      amountPolicy: 'FULL_REMAINDER',
      initialSeverity: 'NORMAL',
      reason: 'TAKE_PROFIT_PARTIAL',
      policyVersion: '2026-10-04'
    });

    await repo.claimIntent({ workerId: 'worker_shadow', leaseDurationMs: 30_000 });

    const attempt1 = await repo.prepareAttempt({
      attemptId: syntheticReplayId('attempt', 'mrbeast', '1') as any,
      intentId: intentRes.intent.id,
      provider: 'JUPITER_V2',
      requestedAmountAtomic: '1000000000',
      initialState: 'ORDER_READY'
    }, 1);

    const sig1 = txs[0]?.signature || 'nn7biyBdbtjHS7WPUxEC2xEZGKdgnwctJBB84k2z2o683Sqyuy6fi96cBDFfhpnVEf1mHuZJxTbTP1K5wfbgpXZ';
    await repo.updateAttemptState(attempt1.attemptId, 'CONFIRMED', { signature: sig1 as any }, 1);

    const fill1 = await repo.recordFill({
      id: syntheticReplayId('fill', 'mrbeast', '1') as any,
      tradeId: intentRes.intent.tradeId,
      positionId: intentRes.intent.positionId,
      intentId: intentRes.intent.id,
      attemptId: attempt1.attemptId,
      signature: sig1 as any,
      realizationSequence: 1,
      chainLegIndex: 0,
      instructionIndex: 3,
      innerInstructionIndex: -1,
      requestedAmountAtomic: '1000000000',
      actualAmountAtomic: '1000000000',
      grossProceedsLamports: '50000000',
      networkFeeLamports: '5000',
      priorityFeeLamports: '50000',
      tipLamports: '0',
      rentMovementLamports: '0',
      slot: txs[0]?.slot ?? 452790300,
      evidenceType: 'HISTORICAL_RECONSTRUCTION',
      confirmedAtWallMs: 1_700_000_000_000 as any,
      createdAtWallMs: 1_700_000_000_000 as any
    }, 1);

    const initialAcc = createInitialPositionAccounting({
      tradeId: intentRes.intent.tradeId,
      positionId: intentRes.intent.positionId,
      mint,
      initialTokensAtomic: '2000000000',
      initialPrincipalLamports: '100000000'
    });
    const finalAcc = applyFillToAccounting(initialAcc, fill1.fill);

    return {
      incidentId,
      intent: (await repo.getIntentById(intentRes.intent.id))!,
      attempts: [await repo.getAttemptById(attempt1.attemptId) as any],
      fills: [fill1.fill],
      reconciliations: [],
      accounting: finalAcc
    };
  }

  // superpig
  // SUPERPIG: Unconfirmed crash state, custom error 6001 without program verification
  // Result must be UNKNOWN / MUST_RECONCILE; reconciliationDebt = true; zero double-fill
  const intentRes = await repo.createOrGetIntent({
    id: syntheticReplayId('intent', 'superpig', '1') as any,
    tradeId: 'trade_superpig_historical' as any,
    positionId: 'pos_superpig_historical' as any,
    walletId,
    mint,
    tokenProgram,
    positionVersion: 1,
    requestedAmountAtomic: requestedAtomic,
    amountPolicy: 'FULL_REMAINDER',
    initialSeverity: 'HIGH',
    reason: 'STOP_LOSS',
    policyVersion: '2026-10-04'
  });

  await repo.claimIntent({ workerId: 'worker_shadow', leaseDurationMs: 30_000 });

  const attempt = await repo.prepareAttempt({
    attemptId: syntheticReplayId('attempt', 'superpig', '1') as any,
    intentId: intentRes.intent.id,
    provider: 'JUPITER_V2',
    requestedAmountAtomic: requestedAtomic,
    initialState: 'ORDER_READY'
  }, 1);

  const sig = txs[0]?.signature || 'JxgrAAHwEqBbfpaXYD1T6cVYW97Fk6qgHGLX2Dbdh13HVo19egPNxq9QneBefEuSbLsmeD9GgyMSr6vvUZUq8Rq';
  await repo.updateAttemptState(attempt.attemptId, 'SUBMITTED', { signature: sig as any }, 1);

  // Crash / timeout occurs -> transition to UNKNOWN
  await repo.updateAttemptState(attempt.attemptId, 'UNKNOWN', {
    failureReason: 'UNCONFIRMED_TX_STATE',
    errorClassification: 'UNKNOWN'
  }, 1);

  // Reconciliation evaluation: inconclusive on-chain evidence
  const evalResult = evaluateReconciliationState(
    (await repo.getAttemptById(attempt.attemptId))!,
    { httpTimeout: true, rpcError: 'RPC confirmation timeout' }
  );

  const recEvent = await repo.recordReconciliationEvent({
    attemptId: attempt.attemptId,
    signature: sig as any,
    verdict: evalResult.verdict,
    reason: evalResult.reason,
    onChainStatus: evalResult.onChainStatus,
    blockhashValid: true
  });

  const initialAcc = createInitialPositionAccounting({
    tradeId: intentRes.intent.tradeId,
    positionId: intentRes.intent.positionId,
    mint,
    initialTokensAtomic: requestedAtomic,
    initialPrincipalLamports: '50000000'
  });

  // Intent MUST have reconciliationDebt = true and NO fill recorded
  const currentIntent = (await repo.getIntentById(intentRes.intent.id))!;

  return {
    incidentId,
    intent: currentIntent,
    attempts: [await repo.getAttemptById(attempt.attemptId) as any],
    fills: [], // Zero fills created for unconfirmed SUPERPIG crash
    reconciliations: [recEvent],
    accounting: initialAcc
  };
}
