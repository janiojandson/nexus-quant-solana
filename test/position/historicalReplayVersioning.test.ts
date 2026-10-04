import test from 'node:test';
import assert from 'node:assert';
import {
  isPositionShadowEnabled,
  getFeatureFlagMatrix,
  compareLegacyAndV2Position,
  reconstructIncidentPositionLifecycle
} from '../../src/position/shadowPosition.js';
import {
  InMemoryPositionRepository
} from '../../src/position/repository.js';

test('Shadow Position (C4): feature flag padrão é false e matriz de flags é coerente', () => {
  const origP = process.env.NEXUS_V2_POSITION_SHADOW_ENABLED;
  const origJ = process.env.NEXUS_V2_JOURNAL_SHADOW_ENABLED;
  const origG = process.env.NEXUS_V2_POSITION_VERSION_GATE_ENABLED;

  try {
    delete process.env.NEXUS_V2_POSITION_SHADOW_ENABLED;
    delete process.env.NEXUS_V2_JOURNAL_SHADOW_ENABLED;
    delete process.env.NEXUS_V2_POSITION_VERSION_GATE_ENABLED;

    assert.strictEqual(isPositionShadowEnabled(), false);
    const m000 = getFeatureFlagMatrix();
    assert.strictEqual(m000.code, '000');
    assert.strictEqual(m000.description, 'Legacy Puro');

    process.env.NEXUS_V2_JOURNAL_SHADOW_ENABLED = 'true';
    const m100 = getFeatureFlagMatrix();
    assert.strictEqual(m100.code, '100');
    assert.strictEqual(m100.description, 'Journal Shadow');

    process.env.NEXUS_V2_POSITION_SHADOW_ENABLED = 'true';
    const m110 = getFeatureFlagMatrix();
    assert.strictEqual(m110.code, '110');
    assert.strictEqual(m110.description, 'Journal + Position Shadow');

    process.env.NEXUS_V2_POSITION_VERSION_GATE_ENABLED = 'true';
    const m111 = getFeatureFlagMatrix();
    assert.strictEqual(m111.code, '111');
    assert.strictEqual(m111.description, 'Teste Local com Version Gate Ativo');
  } finally {
    if (origP !== undefined) process.env.NEXUS_V2_POSITION_SHADOW_ENABLED = origP;
    else delete process.env.NEXUS_V2_POSITION_SHADOW_ENABLED;

    if (origJ !== undefined) process.env.NEXUS_V2_JOURNAL_SHADOW_ENABLED = origJ;
    else delete process.env.NEXUS_V2_JOURNAL_SHADOW_ENABLED;

    if (origG !== undefined) process.env.NEXUS_V2_POSITION_VERSION_GATE_ENABLED = origG;
    else delete process.env.NEXUS_V2_POSITION_VERSION_GATE_ENABLED;
  }
});

test('Position Compare Mode (C4) - Requisito 25: detecta correspondência e divergências entre legado e V2', () => {
  const v2Base: any = {
    positionId: 'pos-comp-1',
    tradeId: 'trade-comp-1',
    walletId: 'wallet-comp-1',
    mint: 'mint-comp-1',
    tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    status: 'OPEN',
    positionVersion: 1n,
    tokenAmountAtomic: 5_000n,
    initialAmountAtomic: 5_000n,
    initialPrincipalLamports: 15_000_000n,
    confirmedProceedsLamports: 0n,
    openedAt: new Date(),
    updatedAt: new Date(),
    closedAt: null,
    reconciliationRequired: false,
    source: 'LIVE_EXECUTOR',
    provenance: null
  };

  // 1. Perfeita correspondência -> 0 mismatches
  const matches = compareLegacyAndV2Position(
    { mint: 'mint-comp-1', tokenAmount: 5000, partialTaken: false },
    v2Base
  );
  assert.strictEqual(matches.length, 0);

  // 2. Quantidade divergente -> CRITICAL mismatch TOKEN_AMOUNT
  const amountMismatch = compareLegacyAndV2Position(
    { mint: 'mint-comp-1', tokenAmount: 4000, partialTaken: false },
    v2Base
  );
  assert.strictEqual(amountMismatch.length, 1);
  assert.strictEqual(amountMismatch[0].field, 'TOKEN_AMOUNT');
  assert.strictEqual(amountMismatch[0].severity, 'CRITICAL');
  assert.strictEqual(amountMismatch[0].legacyValue, '4000');
  assert.strictEqual(amountMismatch[0].v2Value, '5000');

  // 3. Status divergente -> WARN mismatch STATUS
  const statusMismatch = compareLegacyAndV2Position(
    { mint: 'mint-comp-1', tokenAmount: 5000, partialTaken: true },
    v2Base // v2 is OPEN, legacy claims partialTaken (PARTIAL_CLOSED)
  );
  assert.strictEqual(statusMismatch.length, 1);
  assert.strictEqual(statusMismatch[0].field, 'STATUS');
  assert.strictEqual(statusMismatch[0].severity, 'WARN');

  // 4. Existe apenas em um dos lados -> CRITICAL mismatch EXISTS_IN_ONE_ONLY
  const missingInV2 = compareLegacyAndV2Position(
    { mint: 'mint-missing', tokenAmount: 1000 },
    null
  );
  assert.strictEqual(missingInV2.length, 1);
  assert.strictEqual(missingInV2[0].field, 'EXISTS_IN_ONE_ONLY');
});

test('Historical Replay (C4) - Requisito 28: Tesla (v1 entry -> v2 partial -> v3 final / closed)', async () => {
  const repo = new InMemoryPositionRepository();
  const summary = await reconstructIncidentPositionLifecycle('tesla', repo);

  assert.strictEqual(summary.incidentId, 'TESLA');
  assert.strictEqual(summary.initialVersion, 1n);
  assert.strictEqual(summary.finalVersion, 3n);
  assert.strictEqual(summary.isFullyClosed, true);
  assert.strictEqual(summary.finalAmountAtomic, 0n);
  assert.strictEqual(summary.position.status, 'CLOSED');

  assert.deepStrictEqual(summary.versionTransitions, [
    { from: 0n, to: 1n, mutationType: 'ENTRY_OPEN' },
    { from: 1n, to: 2n, mutationType: 'PARTIAL_FILL' },
    { from: 2n, to: 3n, mutationType: 'FINAL_FILL' }
  ]);
});

test('Historical Replay (C4) - Requisito 28: SSI (v1 entry -> v2 partial -> v3 final / closed)', async () => {
  const repo = new InMemoryPositionRepository();
  const summary = await reconstructIncidentPositionLifecycle('ssi', repo);

  assert.strictEqual(summary.incidentId, 'SSI');
  assert.strictEqual(summary.initialVersion, 1n);
  assert.strictEqual(summary.finalVersion, 3n);
  assert.strictEqual(summary.isFullyClosed, true);
  assert.strictEqual(summary.finalAmountAtomic, 0n);
  assert.strictEqual(summary.position.status, 'CLOSED');

  assert.deepStrictEqual(summary.versionTransitions, [
    { from: 0n, to: 1n, mutationType: 'ENTRY_OPEN' },
    { from: 1n, to: 2n, mutationType: 'PARTIAL_FILL' },
    { from: 2n, to: 3n, mutationType: 'FINAL_FILL' }
  ]);
});

test('Historical Replay (C4) - Requisito 28: Mr Beast (v1 entry -> v2 partial -> v3 final / closed)', async () => {
  const repo = new InMemoryPositionRepository();
  const summary = await reconstructIncidentPositionLifecycle('mr-beast', repo);

  assert.strictEqual(summary.incidentId, 'MR_BEAST');
  assert.strictEqual(summary.initialVersion, 1n);
  assert.strictEqual(summary.finalVersion, 3n);
  assert.strictEqual(summary.isFullyClosed, true);
  assert.strictEqual(summary.finalAmountAtomic, 0n);
  assert.strictEqual(summary.position.status, 'CLOSED');

  assert.deepStrictEqual(summary.versionTransitions, [
    { from: 0n, to: 1n, mutationType: 'ENTRY_OPEN' },
    { from: 1n, to: 2n, mutationType: 'PARTIAL_FILL' },
    { from: 2n, to: 3n, mutationType: 'FINAL_FILL' }
  ]);
});

test('Historical Replay (C4) - Requisito 28: SUPERPIG (falhas e UNKNOWN NÃO alteram versão; fill final incrementa uma vez)', async () => {
  const repo = new InMemoryPositionRepository();
  const summary = await reconstructIncidentPositionLifecycle('superpig', repo);

  assert.strictEqual(summary.incidentId, 'SUPERPIG');
  assert.strictEqual(summary.initialVersion, 1n);
  assert.strictEqual(summary.failedAttemptsCount, 4, '3 simulações falhas + 1 timeout UNKNOWN');
  assert.strictEqual(summary.finalVersion, 2n, 'Versão avança apenas de 1n para 2n após o único fill on-chain');
  assert.strictEqual(summary.isFullyClosed, true);
  assert.strictEqual(summary.finalAmountAtomic, 0n);
  assert.strictEqual(summary.position.status, 'CLOSED');

  assert.deepStrictEqual(summary.versionTransitions, [
    { from: 0n, to: 1n, mutationType: 'ENTRY_OPEN' },
    { from: 1n, to: 2n, mutationType: 'FINAL_FILL' }
  ]);
});
