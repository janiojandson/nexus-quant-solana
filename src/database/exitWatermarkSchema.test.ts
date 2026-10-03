import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DECISION_JOURNAL_DDL } from './schemaSql.js';

const fileSchema = readFileSync(
  join(process.cwd(), 'src', 'database', 'schema_decision_journal.sql'),
  'utf8'
);

for (const column of [
  'observable_peak_sol_value',
  'executable_peak_sol_value',
  'last_jupiter_executable_sol_value',
  'last_healthy_exit_route_at'
]) {
  test(`watermark schema persists ${column} in embedded and file DDL`, () => {
    assert.match(DECISION_JOURNAL_DDL, new RegExp(column));
    assert.match(fileSchema, new RegExp(column));
  });
}
