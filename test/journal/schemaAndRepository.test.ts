import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import {
  InMemoryExitJournalRepository,
  EconomicConflictError,
  AppendOnlyViolationError
} from '../../src/journal/repository';
import {
  computeEconomicDedupeKey
} from '../../src/journal/types';
import { V21_EXIT_JOURNAL_DDL } from '../../src/database/v21JournalSchema';

test('Nexus V2.1A — Schema, Migrations & Repository Interfaces (C1)', async (t) => {
  await t.test('1. Migration file exists and matches DDL', () => {
    const migrationPath = path.join(__dirname, '../../migrations/001_v2_1_durable_exit_journal.sql');
    assert.ok(fs.existsSync(migrationPath), 'Migration file 001 missing');
    const content = fs.readFileSync(migrationPath, 'utf8');
    assert.ok(content.includes('CREATE TABLE IF NOT EXISTS exit_intents'));
    assert.ok(content.includes('CREATE TABLE IF NOT EXISTS execution_attempts'));
    assert.ok(content.includes('CREATE TABLE IF NOT EXISTS intent_severity_events'));
    assert.ok(content.includes('CREATE TABLE IF NOT EXISTS fill_ledger'));
    assert.ok(content.includes('CREATE TABLE IF NOT EXISTS execution_reconciliation_events'));
    assert.ok(content.includes('uq_fill_onchain_identity'));
    assert.ok(content.includes('prevent_fill_ledger_mutations'));

    // Check TypeScript DDL matches
    assert.ok(V21_EXIT_JOURNAL_DDL.includes('exit_intents'));
    assert.ok(V21_EXIT_JOURNAL_DDL.includes('fill_ledger'));
  });

  await t.test('2. computeEconomicDedupeKey is deterministic and excludes reason/severity', () => {
    const key1 = computeEconomicDedupeKey({
      walletId: 'PhantomWallet111111111111111111111111111',
      mint: '3A75w27ssueStCEEp6KGxKJ3EtP57P9FxT6YxHmDnt7a',
      positionVersion: 1,
      requestedAmountAtomic: '5000000000',
      amountPolicy: 'FULL_REMAINDER'
    });

    const key2 = computeEconomicDedupeKey({
      walletId: 'PhantomWallet111111111111111111111111111',
      mint: '3A75w27ssueStCEEp6KGxKJ3EtP57P9FxT6YxHmDnt7a',
      positionVersion: 1,
      requestedAmountAtomic: '5000000000',
      amountPolicy: 'FULL_REMAINDER'
    });

    assert.strictEqual(key1, key2, 'Same economic parameters must produce identical key');
    assert.strictEqual(key1.length, 64, 'Key must be 64-char hex SHA-256');

    // Key with null position version handles gracefully
    const key3 = computeEconomicDedupeKey({
      walletId: 'PhantomWallet111111111111111111111111111',
      mint: '3A75w27ssueStCEEp6KGxKJ3EtP57P9FxT6YxHmDnt7a',
      positionVersion: null,
      requestedAmountAtomic: '5000000000',
      amountPolicy: 'FULL_REMAINDER'
    });
    assert.notStrictEqual(key1, key3, 'Different position version produces different key');
  });

  await t.test('3. createOrGetIntent returns created: true on first call, created: false on duplicate', async () => {
    const repo = new InMemoryExitJournalRepository();
    const input = {
      tradeId: 'trade_tesla_1' as any,
      positionId: 'pos_tesla_1' as any,
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

    const res1 = await repo.createOrGetIntent(input);
    assert.strictEqual(res1.created, true);
    assert.strictEqual(res1.intent.status, 'CREATED');
    assert.strictEqual(res1.intent.claimEpoch, 0n);
    assert.strictEqual(res1.intent.claimedBy, null);

    // Call again with exact same economic parameters, even if reason differs
    const res2 = await repo.createOrGetIntent({ ...input, reason: 'PANIC' });
    assert.strictEqual(res2.created, false);
    assert.strictEqual(res2.intent.id, res1.intent.id, 'Must return identical intent instance');
  });

  await t.test('4. createOrGetIntent throws EconomicConflictError if economic parameters conflict for same key', async () => {
    const repo = new InMemoryExitJournalRepository();
    const input1 = {
      tradeId: 'trade_1' as any,
      positionId: 'pos_1' as any,
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

    await repo.createOrGetIntent(input1);

    // Artificially simulate dedupe key collision with conflicting amount
    // In normal execution different amounts generate different keys, but if key matches with conflicting economic terms:
    const dedupeKey = computeEconomicDedupeKey(input1);
    (repo as any).intentsByDedupeKey.set(dedupeKey, 'fake_intent_id');
    (repo as any).intents.set('fake_intent_id', {
      ...input1,
      id: 'fake_intent_id',
      requestedAmountAtomic: '9999999999' // Conflicting amount!
    });

    await assert.rejects(
      () => repo.createOrGetIntent(input1),
      EconomicConflictError
    );
  });

  await t.test('5. updateIntentSeverity preserves initialSeverity and appends to audit trail', async () => {
    const repo = new InMemoryExitJournalRepository();
    const { intent } = await repo.createOrGetIntent({
      tradeId: 'trade_1' as any,
      positionId: 'pos_1' as any,
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

    assert.strictEqual(intent.initialSeverity, 'NORMAL');
    assert.strictEqual(intent.currentSeverity, 'NORMAL');
    assert.strictEqual(intent.severityAuditTrail.length, 0);

    // Escalate to HIGH
    const ev1 = await repo.updateIntentSeverity(intent.id, 'HIGH', 'LIQUIDITY_DRAIN', 'obs_123');
    assert.strictEqual(intent.initialSeverity, 'NORMAL', 'initialSeverity must be immutable');
    assert.strictEqual(intent.currentSeverity, 'HIGH');
    assert.strictEqual(intent.reason, 'LIQUIDITY_DRAIN');
    assert.strictEqual(intent.severityAuditTrail.length, 1);
    assert.strictEqual(ev1.fromSeverity, 'NORMAL');
    assert.strictEqual(ev1.toSeverity, 'HIGH');

    // Escalate to EMERGENCY (PANIC)
    const ev2 = await repo.updateIntentSeverity(intent.id, 'EMERGENCY', 'PANIC');
    assert.strictEqual(intent.initialSeverity, 'NORMAL');
    assert.strictEqual(intent.currentSeverity, 'EMERGENCY');
    assert.strictEqual(intent.reason, 'PANIC');
    assert.strictEqual(intent.severityAuditTrail.length, 2);
    assert.strictEqual(ev2.fromSeverity, 'HIGH');
    assert.strictEqual(ev2.toSeverity, 'EMERGENCY');
  });

  await t.test('6. prepareAttempt persists attempt and updates intent to PREPARED', async () => {
    const repo = new InMemoryExitJournalRepository();
    const { intent } = await repo.createOrGetIntent({
      tradeId: 'trade_1' as any,
      positionId: 'pos_1' as any,
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

    assert.strictEqual(intent.status, 'CREATED');

    const attempt = await repo.prepareAttempt({
      attemptId: 'att_1' as any,
      intentId: intent.id,
      provider: 'JUPITER_V2',
      requestedAmountAtomic: '4375826130',
      expectedOutAtomic: '15000000',
      minimumOutAtomic: '14800000',
      initialState: 'ORDER_READY'
    });

    assert.strictEqual(attempt.attemptId, 'att_1');
    assert.strictEqual(attempt.state, 'ORDER_READY');
    assert.strictEqual(intent.status, 'PREPARED');

    const fetchedAttempt = await repo.getAttemptById('att_1');
    assert.deepStrictEqual(fetchedAttempt, attempt);

    const attemptsForIntent = await repo.getAttemptsForIntent(intent.id);
    assert.strictEqual(attemptsForIntent.length, 1);
    assert.strictEqual(attemptsForIntent[0].attemptId, 'att_1');
  });
});
