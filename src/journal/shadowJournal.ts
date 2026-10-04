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
import { parseStrictBooleanEnv } from '../core/strictEnv.js';

export function isShadowJournalEnabled(): boolean {
  return parseStrictBooleanEnv('NEXUS_V2_JOURNAL_SHADOW_ENABLED', process.env.NEXUS_V2_JOURNAL_SHADOW_ENABLED);
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
  readonly totalConfirmedProceedsLamports: bigint;
  readonly rentRecoveredLamports: bigint;
  readonly accountingDivergenceLamports: bigint;
  readonly fixtureExpected: Record<string, any>;
}

/**
 * Reconstructs journal lifecycle for a historical incident using audited fixture facts.
 * Every entity is tagged with evidenceType: 'HISTORICAL_RECONSTRUCTION'.
 */
export async function reconstructIncidentJournal(
  incidentKey: 'tesla' | 'ssi' | 'mr-beast' | 'superpig',
  repo: IExitJournalRepository,
  fixturesRootDir?: string
): Promise<IncidentReplayJournalSummary> {
  const root = fixturesRootDir || path.join(__dirname, '../../test/fixtures/incidents');
  const incidentDir = path.join(root, incidentKey);

  const manifest = JSON.parse(fs.readFileSync(path.join(incidentDir, 'manifest.json'), 'utf8'));
  const txs: Array<{
    signature: string;
    slot?: number;
    transactionType?: string;
    walletDelta?: number;
    tokenDelta?: number;
  }> = JSON.parse(
    fs.readFileSync(path.join(incidentDir, 'transactions.json'), 'utf8')
  );
  const expected: Record<string, any> = JSON.parse(
    fs.readFileSync(path.join(incidentDir, 'expected.json'), 'utf8')
  );

  const incidentId = manifest.incidentId;
  const walletId = 'Wallet1111111111111111111111111111111111';
  const mint = `Mint_${incidentId}`;
  const tokenProgram = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
  const initialPrincipal = String(Math.round(expected.capitalSwapSol * 1e9));
  const boughtTokens = String(expected.boughtTokensAtomic);

  // Common intent reason: derive from expected taxonomy without inventing unverified labels
  const historicalReason = (expected.taxonomy?.[0] || 'UNKNOWN') as any;

  if (incidentKey === 'tesla' || incidentKey === 'ssi' || incidentKey === 'mr-beast') {
    const partialTx = txs.find(t => t.transactionType === 'PARTIAL_SELL') || txs[1];
    const finalTx = txs.find(t => t.transactionType === 'FINAL_SELL') || txs[3];
    const ataTx = txs.find(t => t.transactionType === 'ATA_CLOSE');

    const partialTokens = String(expected.partialTokensAtomic);
    const partialProceeds = String(Math.round(expected.partialProceedsSol * 1e9));
    const finalTokens = String(expected.finalTokensAtomic);
    const finalProceeds = String(Math.round(expected.finalProceedsSol * 1e9));
    const rentRecovered = ataTx?.walletDelta ? BigInt(Math.round(ataTx.walletDelta * 1e9)) : 1508840n;

    // 1. Create ExitIntent for entire bought balance
    const intentRes = await repo.createOrGetIntent({
      id: syntheticReplayId('intent', incidentKey, 'hist') as any,
      tradeId: `trade_${incidentKey}_historical` as any,
      positionId: `pos_${incidentKey}_historical` as any,
      walletId,
      mint,
      tokenProgram,
      positionVersion: 1,
      requestedAmountAtomic: boughtTokens,
      amountPolicy: 'FULL_REMAINDER',
      initialSeverity: 'HIGH',
      reason: historicalReason,
      policyVersion: '2026-10-04'
    });

    await repo.claimIntent({ workerId: 'worker_shadow', leaseDurationMs: 60_000 });

    // 2. Prepare both attempts while intent is in eligible CLAIMED state
    const attPartial = await repo.prepareAttempt({
      attemptId: syntheticReplayId('attempt', incidentKey, 'partial') as any,
      intentId: intentRes.intent.id,
      provider: 'JUPITER_V2',
      requestedAmountAtomic: partialTokens,
      initialState: 'ORDER_READY'
    }, 1);

    const attFinal = await repo.prepareAttempt({
      attemptId: syntheticReplayId('attempt', incidentKey, 'final') as any,
      intentId: intentRes.intent.id,
      provider: 'JUPITER_V2',
      requestedAmountAtomic: finalTokens,
      initialState: 'ORDER_READY'
    }, 1);

    // 3. Confirm Attempt 1 & Fill 1: PARTIAL EXIT
    await repo.updateAttemptState(attPartial.attemptId, 'SUBMITTED', { signature: partialTx.signature as any }, 1);
    await repo.updateAttemptState(attPartial.attemptId, 'CONFIRMED', {}, 1);

    const fillPartial = await repo.recordFill({
      id: syntheticReplayId('fill', incidentKey, 'partial') as any,
      tradeId: intentRes.intent.tradeId,
      positionId: intentRes.intent.positionId,
      intentId: intentRes.intent.id,
      attemptId: attPartial.attemptId,
      signature: partialTx.signature as any,
      realizationSequence: 1,
      chainLegIndex: 0,
      instructionIndex: 3,
      innerInstructionIndex: -1,
      assetMint: mint,
      requestedAmountAtomic: partialTokens,
      actualAmountAtomic: partialTokens,
      grossProceedsLamports: partialProceeds,
      networkFeeLamports: '5000',
      priorityFeeLamports: '50000',
      tipLamports: '0',
      rentMovementLamports: '0',
      slot: partialTx.slot ?? 452774049,
      evidenceType: 'HISTORICAL_RECONSTRUCTION',
      confirmedAtWallMs: 1_700_000_000_000 as any,
      createdAtWallMs: 1_700_000_000_000 as any
    }, 1);

    // 4. Confirm Attempt 2 & Fill 2: FINAL EXIT
    await repo.updateAttemptState(attFinal.attemptId, 'SUBMITTED', { signature: finalTx.signature as any }, 1);
    await repo.updateAttemptState(attFinal.attemptId, 'CONFIRMED', {}, 1);

    const fillFinal = await repo.recordFill({
      id: syntheticReplayId('fill', incidentKey, 'final') as any,
      tradeId: intentRes.intent.tradeId,
      positionId: intentRes.intent.positionId,
      intentId: intentRes.intent.id,
      attemptId: attFinal.attemptId,
      signature: finalTx.signature as any,
      realizationSequence: 2,
      chainLegIndex: 0,
      instructionIndex: 3,
      innerInstructionIndex: -1,
      assetMint: mint,
      requestedAmountAtomic: finalTokens,
      actualAmountAtomic: finalTokens,
      grossProceedsLamports: finalProceeds,
      networkFeeLamports: '5000',
      priorityFeeLamports: '50000',
      tipLamports: '0',
      rentMovementLamports: String(rentRecovered),
      slot: finalTx.slot ?? 452790108,
      evidenceType: 'HISTORICAL_RECONSTRUCTION',
      confirmedAtWallMs: 1_700_000_000_000 as any,
      createdAtWallMs: 1_700_000_000_000 as any
    }, 1);

    // 4. Accounting incorporating BOTH distinct fills
    const initialAcc = createInitialPositionAccounting({
      tradeId: intentRes.intent.tradeId,
      positionId: intentRes.intent.positionId,
      mint,
      initialTokensAtomic: boughtTokens,
      initialPrincipalLamports: initialPrincipal
    });

    const accPartial = applyFillToAccounting(initialAcc, fillPartial.fill);
    const finalAcc = applyFillToAccounting(accPartial, fillFinal.fill);
    const totalProceeds = BigInt(partialProceeds) + BigInt(finalProceeds);

    if (repo.releaseTerminalIntent) {
      await repo.releaseTerminalIntent(intentRes.intent.id, 'APPLIED', 1);
    } else {
      (intentRes.intent as any).status = 'APPLIED';
    }

    return {
      incidentId,
      intent: (await repo.getIntentById(intentRes.intent.id))!,
      attempts: [
        (await repo.getAttemptById(attPartial.attemptId))!,
        (await repo.getAttemptById(attFinal.attemptId))!
      ],
      fills: [fillPartial.fill, fillFinal.fill],
      reconciliations: [],
      accounting: finalAcc,
      totalConfirmedProceedsLamports: totalProceeds,
      rentRecoveredLamports: rentRecovered,
      accountingDivergenceLamports: 0n,
      fixtureExpected: expected
    };
  }

  // ==========================================
  // SUPERPIG HISTORICAL RECONSTRUCTION
  // ==========================================
  // Preserves sequence: entry -> 3 simulation failures (0 fills) ->
  // timeout / unconfirmed attempt -> eventual confirmed on-chain fill.
  // Preserves historical database accounting divergence.
  const finalExitTx = txs.find(t => t.transactionType === 'FINAL_SELL') || txs[1];
  const ataTx = txs.find(t => t.transactionType === 'ATA_CLOSE');

  const intentRes = await repo.createOrGetIntent({
    id: syntheticReplayId('intent', 'superpig', 'hist') as any,
    tradeId: 'trade_superpig_historical' as any,
    positionId: 'pos_superpig_historical' as any,
    walletId,
    mint,
    tokenProgram,
    positionVersion: 1,
    requestedAmountAtomic: boughtTokens,
    amountPolicy: 'FULL_REMAINDER',
    initialSeverity: 'HIGH',
    reason: historicalReason,
    policyVersion: '2026-10-04'
  });

  await repo.claimIntent({ workerId: 'worker_shadow', leaseDurationMs: 60_000 });

  const attempts: ExecutionAttempt[] = [];

  // 1. 3 Simulation Attempts that failed with customCode 6001 (ZERO fills fabricated)
  const rejectedCount = expected.simulationRejectedCount || 3;
  for (let i = 1; i <= rejectedCount; i++) {
    const att = await repo.prepareAttempt({
      attemptId: syntheticReplayId('attempt', 'superpig', `sim_${i}`) as any,
      intentId: intentRes.intent.id,
      provider: 'JUPITER_V2',
      requestedAmountAtomic: boughtTokens,
      initialState: 'ORDER_READY'
    }, 1);

    await repo.updateAttemptState(att.attemptId, 'FAILED', {
      failureReason: `Simulation failed: custom code 6001 (attempt ${i})`,
      errorClassification: 'UNKNOWN' // Not Jupiter slippage without verified programId
    }, 1);

    attempts.push((await repo.getAttemptById(att.attemptId))!);
  }

  // 2. Timeout / Unconfirmed Attempt (UNKNOWN state, reconciliation debt active)
  const attTimeout = await repo.prepareAttempt({
    attemptId: syntheticReplayId('attempt', 'superpig', 'timeout') as any,
    intentId: intentRes.intent.id,
    provider: 'JUPITER_V2',
    requestedAmountAtomic: boughtTokens,
    initialState: 'ORDER_READY'
  }, 1);

  // 3. Eventual Confirmed on-chain transaction & fill prepared before timeout moves intent to UNKNOWN
  const finalProceedsLamports = String(Math.round(expected.finalProceedsSol * 1e9)); // '3183856'
  const databaseRecordedLamports = String(Math.round(expected.databaseRecordedExitSol * 1e9)); // '10301000'
  const divergenceLamports = BigInt(databaseRecordedLamports) - BigInt(finalProceedsLamports); // 7117144n
  const rentRecovered = ataTx?.walletDelta ? BigInt(Math.round(ataTx.walletDelta * 1e9)) : 1508840n;

  const attFinal = await repo.prepareAttempt({
    attemptId: syntheticReplayId('attempt', 'superpig', 'final_confirmed') as any,
    intentId: intentRes.intent.id,
    provider: 'JUPITER_V2',
    requestedAmountAtomic: boughtTokens,
    initialState: 'ORDER_READY'
  }, 1);

  await repo.updateAttemptState(attTimeout.attemptId, 'SUBMITTED', {
    signature: 'unconfirmed_tx_signature_placeholder' as any
  }, 1);

  await repo.updateAttemptState(attTimeout.attemptId, 'UNKNOWN', {
    failureReason: 'CONFIRMATION_TIMEOUT',
    errorClassification: 'UNKNOWN'
  }, 1);

  const evalResult = evaluateReconciliationState(
    (await repo.getAttemptById(attTimeout.attemptId))!,
    { httpTimeout: true, rpcError: 'RPC confirmation timeout' }
  );

  const recEvent = await repo.recordReconciliationEvent({
    attemptId: attTimeout.attemptId,
    signature: 'unconfirmed_tx_signature_placeholder' as any,
    verdict: evalResult.verdict,
    reason: evalResult.reason,
    onChainStatus: evalResult.onChainStatus,
    blockhashValid: true
  });

  attempts.push((await repo.getAttemptById(attTimeout.attemptId))!);

  await repo.updateAttemptState(attFinal.attemptId, 'SUBMITTED', {
    signature: (finalExitTx?.signature || expected.finalExitTxSignature) as any
  }, 1);

  await repo.updateAttemptState(attFinal.attemptId, 'CONFIRMED', {}, 1);
  attempts.push((await repo.getAttemptById(attFinal.attemptId))!);

  const fillFinal = await repo.recordFill({
    id: syntheticReplayId('fill', 'superpig', 'final_confirmed') as any,
    tradeId: intentRes.intent.tradeId,
    positionId: intentRes.intent.positionId,
    intentId: intentRes.intent.id,
    attemptId: attFinal.attemptId,
    signature: (finalExitTx?.signature || expected.finalExitTxSignature) as any,
    realizationSequence: 1,
    chainLegIndex: 0,
    instructionIndex: 3,
    innerInstructionIndex: -1,
    assetMint: mint,
    requestedAmountAtomic: boughtTokens,
    actualAmountAtomic: boughtTokens,
    grossProceedsLamports: finalProceedsLamports,
    networkFeeLamports: '5000',
    priorityFeeLamports: '50000',
    tipLamports: '0',
    rentMovementLamports: String(rentRecovered),
    slot: finalExitTx?.slot ?? 452800149,
    evidenceType: 'HISTORICAL_RECONSTRUCTION',
    confirmedAtWallMs: 1_700_000_000_000 as any,
    createdAtWallMs: 1_700_000_000_000 as any
  }, 1);

  const initialAcc = createInitialPositionAccounting({
    tradeId: intentRes.intent.tradeId,
    positionId: intentRes.intent.positionId,
    mint,
    initialTokensAtomic: boughtTokens,
    initialPrincipalLamports: initialPrincipal
  });

  const finalAcc = applyFillToAccounting(initialAcc, fillFinal.fill);

  if (repo.releaseTerminalIntent) {
    await repo.releaseTerminalIntent(intentRes.intent.id, 'APPLIED', 1);
  } else {
    (intentRes.intent as any).status = 'APPLIED';
  }

  return {
    incidentId,
    intent: (await repo.getIntentById(intentRes.intent.id))!,
    attempts,
    fills: [fillFinal.fill],
    reconciliations: [recEvent],
    accounting: finalAcc,
    totalConfirmedProceedsLamports: BigInt(finalProceedsLamports),
    rentRecoveredLamports: rentRecovered,
    accountingDivergenceLamports: divergenceLamports,
    fixtureExpected: expected
  };
}
