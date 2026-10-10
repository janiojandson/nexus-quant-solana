import assert from 'node:assert/strict';
import test from 'node:test';
import { DecisionLogger } from './decisionJournal.js';
import { runMaintenance } from './maintenanceJob.js';

function readOnlyPool(compatible = true) {
  const statements: string[] = [];
  const query = async (sql: string) => {
    statements.push(sql);
    if (!/^\s*SELECT\b/i.test(sql) || /\b(?:drop_old_partitions|create_next_partition)\s*\(/i.test(sql))
      throw new Error('NON_READONLY_SQL_REJECTED');
    return { rows: [{ columns_ready: compatible, score_ready: compatible,
      outcome_unique_ready: compatible, partition_ready: compatible }] };
  };
  return { statements, pool: { query, connect: async () => ({ query, release() {} }) } as any };
}

test('journal startup asserts compatibility without legacy DDL, function replacement or partition mutation', async () => {
  const fake = readOnlyPool();
  const logger = new DecisionLogger(fake.pool);
  try {
    await logger.initSchema();
    assert.ok(fake.statements.length > 0);
    assert.equal(fake.statements.every(sql => /^\s*SELECT\b/i.test(sql)), true);
    assert.deepEqual((logger as any).getSchemaReadiness?.(), { ready: true, reason: null });
  } finally { await logger.shutdown(); }
});

test('boot and repeated scheduled maintenance never invoke retained mutation functions or vacuum', async () => {
  const fake = readOnlyPool();
  await runMaintenance(fake.pool);
  await runMaintenance(fake.pool);
  assert.equal(fake.statements.every(sql => /^\s*SELECT\b/i.test(sql) &&
    !/\b(?:drop_old_partitions|create_next_partition)\s*\(/i.test(sql)), true);
  assert.equal(fake.statements.length, 2);
});

test('incompatible or unavailable journal schema rejects boot instead of reporting initialized', async () => {
  const fake = readOnlyPool(false);
  const logger = new DecisionLogger(fake.pool);
  try {
    await assert.rejects(logger.initSchema(), /JOURNAL_SCHEMA_INCOMPATIBLE/);
    assert.deepEqual((logger as any).getSchemaReadiness?.(),
      { ready: false, reason: 'JOURNAL_SCHEMA_INCOMPATIBLE' });
  } finally { await logger.shutdown(); }
  const unavailable = new DecisionLogger(null);
  try { await assert.rejects(unavailable.initSchema(), /JOURNAL_DATABASE_UNAVAILABLE/); }
  finally { await unavailable.shutdown(); }
});
