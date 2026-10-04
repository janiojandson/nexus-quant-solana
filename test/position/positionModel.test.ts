import test from 'node:test';
import assert from 'node:assert';
import {
  InMemoryPositionRepository
} from '../../src/position/repository.js';
import {
  takePositionSnapshot,
  StalePositionVersionError,
  ActivePositionConflictError
} from '../../src/position/types.js';

test('Position Model (C1): criação com versão inicial 1n e snapshot imutável', async () => {
  const repo = new InMemoryPositionRepository();
  const pos = await repo.createPosition({
    positionId: 'pos-test-1',
    tradeId: 'trade-test-1',
    walletId: 'wallet-test-1',
    mint: 'mint-sol-test',
    initialAmountAtomic: 1_000_000n,
    initialPrincipalLamports: 15_000_000n // 0.015 SOL
  });

  assert.strictEqual(pos.positionVersion, 1n);
  assert.strictEqual(pos.tokenAmountAtomic, 1_000_000n);
  assert.strictEqual(pos.status, 'OPEN');

  const snapshot = takePositionSnapshot(pos);
  assert.strictEqual(snapshot.positionId, 'pos-test-1');
  assert.strictEqual(snapshot.positionVersion, 1n);
  assert.strictEqual(snapshot.tokenAmountAtomic, 1_000_000n);
  assert.strictEqual(typeof snapshot.capturedAtWallMs, 'number');
  assert.strictEqual(typeof snapshot.capturedAtMonoNs, 'bigint');

  // Verify immutability
  assert.strictEqual(Object.isFrozen(snapshot), true);
  assert.throws(() => {
    'use strict';
    (snapshot as any).positionVersion = 2n;
  }, TypeError);
});

test('Position Model (C1): CAS update incrementa versão e rejeita versão velha com StalePositionVersionError', async () => {
  const repo = new InMemoryPositionRepository();
  await repo.createPosition({
    positionId: 'pos-cas-1',
    tradeId: 'trade-cas-1',
    walletId: 'wallet-cas-1',
    mint: 'mint-cas-1',
    initialAmountAtomic: 10_000n,
    initialPrincipalLamports: 15_000_000n
  });

  // CAS with correct expectedVersion = 1n
  const res1 = await repo.updatePositionCAS({
    positionId: 'pos-cas-1',
    expectedVersion: 1n,
    newAmountAtomic: 8_000n,
    mutationType: 'PARTIAL_FILL'
  });
  assert.strictEqual(res1.position.positionVersion, 2n);
  assert.strictEqual(res1.position.tokenAmountAtomic, 8_000n);
  assert.strictEqual(res1.mutation.fromVersion, 1n);
  assert.strictEqual(res1.mutation.toVersion, 2n);
  assert.strictEqual(res1.mutation.deltaAtomic, -2_000n);

  // Stale CAS attempt with expectedVersion = 1n when current is 2n
  await assert.rejects(
    async () => {
      await repo.updatePositionCAS({
        positionId: 'pos-cas-1',
        expectedVersion: 1n,
        newAmountAtomic: 5_000n,
        mutationType: 'PARTIAL_FILL'
      });
    },
    (err: any) => {
      assert(err instanceof StalePositionVersionError);
      assert.strictEqual(err.expectedVersion, 1n);
      assert.strictEqual(err.actualVersion, 2n);
      return true;
    }
  );
});

test('Position Model (C1): restrição de posição ativa impede duas posições abertas no mesmo wallet + mint', async () => {
  const repo = new InMemoryPositionRepository();
  await repo.createPosition({
    positionId: 'pos-dup-1',
    tradeId: 'trade-dup-1',
    walletId: 'wallet-dup',
    mint: 'mint-dup',
    initialAmountAtomic: 50_000n,
    initialPrincipalLamports: 15_000_000n
  });

  await assert.rejects(
    async () => {
      await repo.createPosition({
        positionId: 'pos-dup-2',
        tradeId: 'trade-dup-2',
        walletId: 'wallet-dup',
        mint: 'mint-dup',
        initialAmountAtomic: 20_000n,
        initialPrincipalLamports: 15_000_000n
      });
    },
    (err: any) => {
      assert(err instanceof ActivePositionConflictError);
      assert.strictEqual(err.activePositionId, 'pos-dup-1');
      return true;
    }
  );
});

test('Position Model (C1): BigInt fencing e valores acima de Number.MAX_SAFE_INTEGER', async () => {
  const repo = new InMemoryPositionRepository();
  const giantAmount = 9_007_199_254_740_995n; // > MAX_SAFE_INTEGER
  const giantVersion = 9_007_199_254_740_992n;

  const pos = await repo.createPosition({
    positionId: 'pos-giant-1',
    tradeId: 'trade-giant-1',
    walletId: 'wallet-giant-1',
    mint: 'mint-giant-1',
    initialAmountAtomic: giantAmount,
    initialPrincipalLamports: 100_000_000_000n,
    initialVersion: giantVersion
  });

  assert.strictEqual(pos.positionVersion, giantVersion);
  assert.strictEqual(pos.tokenAmountAtomic, giantAmount);

  const res = await repo.updatePositionCAS({
    positionId: 'pos-giant-1',
    expectedVersion: giantVersion,
    newAmountAtomic: giantAmount - 100n,
    mutationType: 'PARTIAL_FILL'
  });

  assert.strictEqual(res.position.positionVersion, giantVersion + 1n);
  assert.strictEqual(res.position.tokenAmountAtomic, giantAmount - 100n);
  assert.notStrictEqual(res.position.positionVersion, giantVersion);
});
