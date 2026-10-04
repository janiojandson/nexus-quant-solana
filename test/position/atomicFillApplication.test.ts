import test from 'node:test';
import assert from 'node:assert';
import {
  InMemoryPositionRepository
} from '../../src/position/repository.js';
import {
  StalePositionVersionError
} from '../../src/position/types.js';

test('Atomic Fill (C2) - Requisito 13: Partial Example Test obrigatório', async () => {
  const repo = new InMemoryPositionRepository();

  // 1. Position: version 1, balance 1.000.000
  const pos = await repo.createPosition({
    positionId: 'pos-partial-req13',
    tradeId: 'trade-req13',
    walletId: 'wallet-req13',
    mint: 'mint-req13',
    initialAmountAtomic: 1_000_000n,
    initialPrincipalLamports: 15_000_000n
  });
  assert.strictEqual(pos.positionVersion, 1n);
  assert.strictEqual(pos.tokenAmountAtomic, 1_000_000n);
  assert.strictEqual(pos.status, 'OPEN');

  // 2. Partial Fill: 400.000 debitados -> version 2, balance 600.000
  const fill1 = await repo.applyFill({
    positionId: 'pos-partial-req13',
    expectedVersion: 1n,
    fillId: 'fill-part-1',
    signature: 'sig-part-1',
    fillAmountAtomic: 400_000n,
    proceedsLamports: 6_000_000n,
    isFinal: false
  });
  assert.strictEqual(fill1.alreadyApplied, false);
  assert.strictEqual(fill1.position.positionVersion, 2n);
  assert.strictEqual(fill1.position.tokenAmountAtomic, 600_000n);
  assert.strictEqual(fill1.position.status, 'PARTIAL_CLOSED');

  // 3. Reprocessar mesmo Fill: version continua 2, balance continua 600.000
  const fill1Reprocess = await repo.applyFill({
    positionId: 'pos-partial-req13',
    expectedVersion: 2n, // Even if caller supplies 2n or 1n
    fillId: 'fill-part-1',
    signature: 'sig-part-1',
    fillAmountAtomic: 400_000n,
    proceedsLamports: 6_000_000n,
    isFinal: false
  });
  assert.strictEqual(fill1Reprocess.alreadyApplied, true);
  assert.strictEqual(fill1Reprocess.position.positionVersion, 2n);
  assert.strictEqual(fill1Reprocess.position.tokenAmountAtomic, 600_000n);

  // 4. Segundo fill novo: 600.000 -> version 3, balance 0, status CLOSED
  const fill2 = await repo.applyFill({
    positionId: 'pos-partial-req13',
    expectedVersion: 2n,
    fillId: 'fill-part-2',
    signature: 'sig-part-2',
    fillAmountAtomic: 600_000n,
    proceedsLamports: 9_000_000n,
    isFinal: true
  });
  assert.strictEqual(fill2.alreadyApplied, false);
  assert.strictEqual(fill2.position.positionVersion, 3n);
  assert.strictEqual(fill2.position.tokenAmountAtomic, 0n);
  assert.strictEqual(fill2.position.status, 'CLOSED');
  assert.strictEqual(fill2.position.confirmedProceedsLamports, 15_000_000n);
});

test('Atomic Fill (C2) - Requisito 14: Concurrent Fill Test (OCC CAS)', async () => {
  const repo = new InMemoryPositionRepository();

  // Create position at version 7n
  await repo.createPosition({
    positionId: 'pos-occ-v7',
    tradeId: 'trade-occ-v7',
    walletId: 'wallet-occ-v7',
    mint: 'mint-occ-v7',
    initialAmountAtomic: 10_000n,
    initialPrincipalLamports: 15_000_000n,
    initialVersion: 7n
  });

  // Worker A and Worker B both see version 7n and try to apply different fills
  const workerAPromise = repo.applyFill({
    positionId: 'pos-occ-v7',
    expectedVersion: 7n,
    fillId: 'fill-worker-a',
    signature: 'sig-worker-a',
    fillAmountAtomic: 3_000n,
    proceedsLamports: 4_500_000n
  });

  // Worker A wins
  const resultA = await workerAPromise;
  assert.strictEqual(resultA.position.positionVersion, 8n);
  assert.strictEqual(resultA.position.tokenAmountAtomic, 7_000n);

  // Worker B attempts CAS with expectedVersion = 7n
  await assert.rejects(
    async () => {
      await repo.applyFill({
        positionId: 'pos-occ-v7',
        expectedVersion: 7n, // Stale!
        fillId: 'fill-worker-b',
        signature: 'sig-worker-b',
        fillAmountAtomic: 2_000n,
        proceedsLamports: 3_000_000n
      });
    },
    (err: any) => {
      assert(err instanceof StalePositionVersionError);
      assert.strictEqual(err.expectedVersion, 7n);
      assert.strictEqual(err.actualVersion, 8n);
      return true;
    }
  );

  // Verify that balance was NOT corrupted and version did not collide
  const finalPos = await repo.getPosition('pos-occ-v7');
  assert.strictEqual(finalPos?.positionVersion, 8n);
  assert.strictEqual(finalPos?.tokenAmountAtomic, 7_000n);
});

test('Atomic Fill (C2) - Requisito 20: External Balance Divergence Adjustment', async () => {
  const repo = new InMemoryPositionRepository();

  await repo.createPosition({
    positionId: 'pos-recon-adj',
    tradeId: 'trade-recon-adj',
    walletId: 'wallet-recon-adj',
    mint: 'mint-recon-adj',
    initialAmountAtomic: 100n,
    initialPrincipalLamports: 10_000_000n
  });

  // DB says 100 tokens, Chain reconciliation says 80 tokens
  const recon = await repo.reconcileExternalBalance({
    positionId: 'pos-recon-adj',
    expectedVersion: 1n,
    observedChainAmountAtomic: 80n,
    evidence: 'SOLANA_SPL_ACCOUNT_DELTA_20_UNITS_MISSING'
  });

  assert.strictEqual(recon.position.positionVersion, 2n);
  assert.strictEqual(recon.position.tokenAmountAtomic, 80n);
  assert.strictEqual(recon.mutation.mutationType, 'RECONCILIATION_ADJUSTMENT');
  assert.strictEqual(recon.mutation.fromVersion, 1n);
  assert.strictEqual(recon.mutation.toVersion, 2n);
  assert.strictEqual(recon.mutation.tokenAmountBefore, 100n);
  assert.strictEqual(recon.mutation.tokenAmountAfter, 80n);
  assert.strictEqual(recon.mutation.deltaAtomic, -20n);
});
