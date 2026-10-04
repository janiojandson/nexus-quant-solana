import test from 'node:test';
import assert from 'node:assert';
import {
  takePositionSnapshot,
  DurablePosition
} from '../../src/position/types.js';
import {
  bindExecutionQuote
} from '../../src/position/quoteBinding.js';
import {
  evaluatePreSendVersionGate,
  evaluateIntentSupersedeEligibility,
  isPositionVersionGateEnabled
} from '../../src/position/versionGate.js';
import { ExitIntent } from '../../src/journal/types.js';

function createMockPosition(overrides?: Partial<DurablePosition>): DurablePosition {
  return {
    positionId: 'pos-gate-test',
    tradeId: 'trade-gate-test',
    walletId: 'wallet-gate-test',
    mint: 'mint-gate-test',
    tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    status: 'OPEN',
    positionVersion: 4n,
    tokenAmountAtomic: 1_000n,
    initialAmountAtomic: 1_000n,
    initialPrincipalLamports: 15_000_000n,
    confirmedProceedsLamports: 0n,
    openedAt: new Date(),
    updatedAt: new Date(),
    closedAt: null,
    lastFillId: null,
    lastChainSignature: null,
    reconciliationRequired: false,
    source: 'LIVE_EXECUTOR',
    provenance: null,
    ...overrides
  };
}

test('Quote Binding (C3): cria BoundExecutionQuote com metadata imutável', () => {
  const pos = createMockPosition({ positionVersion: 4n, tokenAmountAtomic: 900n });
  const snapshot = takePositionSnapshot(pos);

  const boundQuote = bindExecutionQuote({
    snapshot,
    requestedAmountAtomic: 900n,
    quoteSource: 'JUPITER',
    outAmountLamports: 12_000_000n,
    slippageBps: 500,
    requestId: 'req-jup-123'
  });

  assert.strictEqual(boundQuote.positionId, 'pos-gate-test');
  assert.strictEqual(boundQuote.positionVersion, 4n);
  assert.strictEqual(boundQuote.requestedAmountAtomic, 900n);
  assert.strictEqual(boundQuote.quoteSource, 'JUPITER');
  assert.strictEqual(boundQuote.requestId, 'req-jup-123');
  assert.strictEqual(Object.isFrozen(boundQuote), true);
});

test('Pre-Send Gate (C3) - Requisito 15: Quote Stale Test (v4 quote rejeitada após mutação para v5)', () => {
  // 1. Snapshot da posição em v4 com 1.000 tokens
  const posV4 = createMockPosition({ positionVersion: 4n, tokenAmountAtomic: 1_000n });
  const snapshotV4 = takePositionSnapshot(posV4);

  // 2. Cria quote vinculada à versão 4 (amount 900)
  const boundQuoteV4 = bindExecutionQuote({
    snapshot: snapshotV4,
    requestedAmountAtomic: 900n,
    quoteSource: 'JUPITER',
    outAmountLamports: 12_000_000n,
    slippageBps: 500
  });

  // 3. Posição sofre mutação (partial fill ou reconciliação) e avança para v5
  const posV5 = createMockPosition({ positionVersion: 5n, tokenAmountAtomic: 800n });
  const snapshotV5 = takePositionSnapshot(posV5);

  // 4. Pre-send gate avalia quote v4 contra snapshot v5
  let rpcCallsSent = 0;
  const decision = evaluatePreSendVersionGate({
    currentPosition: snapshotV5,
    boundQuote: boundQuoteV4,
    intentPolicy: 'PARTIAL_50',
    intendedAmountAtomic: 900n
  });

  if (decision.allowed) {
    rpcCallsSent++;
  }

  // Verifica rejeição formal sem nenhum RPC de envio
  assert.strictEqual(decision.allowed, false);
  assert.strictEqual((decision as any).code, 'QUOTE_STALE_FOR_POSITION');
  assert.strictEqual((decision as any).expectedVersion, 4n);
  assert.strictEqual((decision as any).currentVersion, 5n);
  assert.strictEqual(rpcCallsSent, 0, 'Zero RPC transmitido após detecção de quote stale');
});

test('Pre-Send Gate (C3) - Requisito 16: Mesma Versão com Quantidade Divergente (QUOTE_AMOUNT_MISMATCH)', () => {
  const posV4 = createMockPosition({ positionVersion: 4n, tokenAmountAtomic: 1_000n });
  const snapshotV4 = takePositionSnapshot(posV4);

  // Quote cotada para 900 unidades
  const boundQuote = bindExecutionQuote({
    snapshot: snapshotV4,
    requestedAmountAtomic: 900n,
    quoteSource: 'JUPITER',
    outAmountLamports: 12_000_000n,
    slippageBps: 500
  });

  // Intenção requeria 850 unidades (divergência por arredondamento ou cache incorreto)
  const decision = evaluatePreSendVersionGate({
    currentPosition: snapshotV4,
    boundQuote,
    intentPolicy: 'PARTIAL_50',
    intendedAmountAtomic: 850n
  });

  assert.strictEqual(decision.allowed, false);
  assert.strictEqual((decision as any).code, 'QUOTE_AMOUNT_MISMATCH');
  assert.strictEqual((decision as any).expectedAmount, 850n);
  assert.strictEqual((decision as any).currentAmount, 900n);
});

test('Pre-Send Gate (C3) - Requisito 17: FULL_REMAINDER exige quote exata do saldo remanescente', () => {
  const pos = createMockPosition({ positionVersion: 2n, tokenAmountAtomic: 1_000n });
  const snapshot = takePositionSnapshot(pos);

  // Quote com montante menor que o total remanescente
  const boundQuotePartial = bindExecutionQuote({
    snapshot,
    requestedAmountAtomic: 500n,
    quoteSource: 'JUPITER',
    outAmountLamports: 7_000_000n,
    slippageBps: 500
  });

  // FULL_REMAINDER não aceita 500 quando posição tem 1.000
  const rejected = evaluatePreSendVersionGate({
    currentPosition: snapshot,
    boundQuote: boundQuotePartial,
    intentPolicy: 'FULL_REMAINDER'
  });
  assert.strictEqual(rejected.allowed, false);
  assert.strictEqual((rejected as any).code, 'QUOTE_AMOUNT_MISMATCH');

  // Quote com montante idêntico ao saldo remanescente (1.000n)
  const boundQuoteFull = bindExecutionQuote({
    snapshot,
    requestedAmountAtomic: 1_000n,
    quoteSource: 'JUPITER',
    outAmountLamports: 14_000_000n,
    slippageBps: 500
  });

  const accepted = evaluatePreSendVersionGate({
    currentPosition: snapshot,
    boundQuote: boundQuoteFull,
    intentPolicy: 'FULL_REMAINDER',
    intendedAmountAtomic: 1_000n
  });
  assert.strictEqual(accepted.allowed, true);
  assert.strictEqual(accepted.reason, 'VERSION_AND_AMOUNT_MATCH');
});

test('Pre-Send Gate (C3) - Requisito 7: Partial Amount exige revalidação se versão mudar mesmo com saldo suficiente', () => {
  // Posição: 10.000 tokens, v17
  const posV17 = createMockPosition({ positionVersion: 17n, tokenAmountAtomic: 10_000n });
  const snapshotV17 = takePositionSnapshot(posV17);

  // Quote para venda parcial de 5.000 tokens em v17
  const boundQuoteV17 = bindExecutionQuote({
    snapshot: snapshotV17,
    requestedAmountAtomic: 5_000n,
    quoteSource: 'JUPITER',
    outAmountLamports: 75_000_000n,
    slippageBps: 500
  });

  // Posição sofre outra mutação e passa para v18 com 9.000 tokens (ainda tem >= 5.000!)
  const posV18 = createMockPosition({ positionVersion: 18n, tokenAmountAtomic: 9_000n });
  const snapshotV18 = takePositionSnapshot(posV18);

  // Gate DEVE rejeitar porque a versão econômica mudou, não importando que 9.000 >= 5.000
  const decision = evaluatePreSendVersionGate({
    currentPosition: snapshotV18,
    boundQuote: boundQuoteV17,
    intentPolicy: 'PARTIAL_50',
    intendedAmountAtomic: 5_000n
  });

  assert.strictEqual(decision.allowed, false);
  assert.strictEqual((decision as any).code, 'QUOTE_STALE_FOR_POSITION');
  assert.strictEqual((decision as any).expectedVersion, 17n);
  assert.strictEqual((decision as any).currentVersion, 18n);
});

test('Pre-Send Gate (C3) - Requisito 9: Pre-Send Supersede Policy (CREATED vs SUBMITTED)', () => {
  const baseIntent: Partial<ExitIntent> = {
    id: 'intent-test-9' as any,
    tradeId: 'trade-9' as any,
    positionId: 'pos-9' as any,
    walletId: 'wallet-9',
    mint: 'mint-9',
    tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    positionVersion: 1n,
    requestedAmountAtomic: '500',
    amountPolicy: 'PARTIAL_50',
    economicDedupeKey: 'dedupe-9',
    initialSeverity: 'NORMAL',
    currentSeverity: 'NORMAL',
    severityAuditTrail: [],
    reason: 'STOP_LOSS',
    policyVersion: '2.0',
    claimEpoch: 0n,
    reconciliationDebt: false,
    createdAtWallMs: 0 as any,
    expiresAtWallMs: 0 as any
  };

  // 1. Early state CREATED -> safe to supersede
  const decisionCreated = evaluateIntentSupersedeEligibility({
    ...baseIntent,
    status: 'CREATED'
  } as ExitIntent);
  assert.strictEqual(decisionCreated.canSupersedeSafely, true);
  assert.strictEqual(decisionCreated.action, 'SUPERSEDE');

  // 2. Early state PREPARED (unsigned) -> safe to supersede
  const decisionPrepared = evaluateIntentSupersedeEligibility({
    ...baseIntent,
    status: 'PREPARED'
  } as ExitIntent);
  assert.strictEqual(decisionPrepared.canSupersedeSafely, true);
  assert.strictEqual(decisionPrepared.action, 'SUPERSEDE');

  // 3. Broadcast state SUBMITTED -> CANNOT be superseded, requires MUST_RECONCILE
  const decisionSubmitted = evaluateIntentSupersedeEligibility({
    ...baseIntent,
    status: 'SUBMITTED'
  } as ExitIntent);
  assert.strictEqual(decisionSubmitted.canSupersedeSafely, false);
  assert.strictEqual(decisionSubmitted.action, 'MUST_RECONCILE');

  // 4. Uncertain state UNKNOWN -> CANNOT be superseded, requires MUST_RECONCILE
  const decisionUnknown = evaluateIntentSupersedeEligibility({
    ...baseIntent,
    status: 'UNKNOWN'
  } as ExitIntent);
  assert.strictEqual(decisionUnknown.canSupersedeSafely, false);
  assert.strictEqual(decisionUnknown.action, 'MUST_RECONCILE');
});

test('Pre-Send Gate (C3) - Requisito 10: Reconciliation Required bloqueia irreversivelmente', () => {
  const posWithDebt = createMockPosition({
    positionVersion: 3n,
    tokenAmountAtomic: 500n,
    reconciliationRequired: true
  });
  const snapshot = takePositionSnapshot(posWithDebt);

  const boundQuote = bindExecutionQuote({
    snapshot,
    requestedAmountAtomic: 500n,
    quoteSource: 'JUPITER',
    outAmountLamports: 6_000_000n,
    slippageBps: 500
  });

  const decision = evaluatePreSendVersionGate({
    currentPosition: snapshot,
    boundQuote,
    intentPolicy: 'FULL_REMAINDER',
    intendedAmountAtomic: 500n
  });

  assert.strictEqual(decision.allowed, false);
  assert.strictEqual((decision as any).code, 'POSITION_RECONCILIATION_REQUIRED');
});

test('Pre-Send Gate (C3) - Requisito 26 & 27: Feature flag NEXUS_V2_POSITION_VERSION_GATE_ENABLED', () => {
  const origJ = process.env.NEXUS_V2_JOURNAL_SHADOW_ENABLED;
  const origP = process.env.NEXUS_V2_POSITION_SHADOW_ENABLED;
  const origG = process.env.NEXUS_V2_POSITION_VERSION_GATE_ENABLED;

  try {
    delete process.env.NEXUS_V2_JOURNAL_SHADOW_ENABLED;
    delete process.env.NEXUS_V2_POSITION_SHADOW_ENABLED;
    delete process.env.NEXUS_V2_POSITION_VERSION_GATE_ENABLED;
    assert.strictEqual(isPositionVersionGateEnabled(), false, 'Padrão deve ser FALSE');

    // 001 alone fails closed with InvalidFeatureFlagCombinationError
    process.env.NEXUS_V2_POSITION_VERSION_GATE_ENABLED = 'true';
    assert.throws(() => isPositionVersionGateEnabled(), /Invalid feature flag combination \[001\]/);

    // 111 (all three enabled) succeeds
    process.env.NEXUS_V2_JOURNAL_SHADOW_ENABLED = 'true';
    process.env.NEXUS_V2_POSITION_SHADOW_ENABLED = 'true';
    assert.strictEqual(isPositionVersionGateEnabled(), true);
  } finally {
    if (origJ !== undefined) process.env.NEXUS_V2_JOURNAL_SHADOW_ENABLED = origJ;
    else delete process.env.NEXUS_V2_JOURNAL_SHADOW_ENABLED;
    if (origP !== undefined) process.env.NEXUS_V2_POSITION_SHADOW_ENABLED = origP;
    else delete process.env.NEXUS_V2_POSITION_SHADOW_ENABLED;
    if (origG !== undefined) process.env.NEXUS_V2_POSITION_VERSION_GATE_ENABLED = origG;
    else delete process.env.NEXUS_V2_POSITION_VERSION_GATE_ENABLED;
  }
});
