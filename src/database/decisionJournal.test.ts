import test from 'node:test';
import assert from 'node:assert';
import { DecisionLogger } from './decisionJournal.js';
import { DECISION_JOURNAL_DDL } from './schemaSql.js';

test('DecisionLogger evaluateGate produz objeto correto', () => {
  const gatePass = DecisionLogger.evaluateGate('MINT_AUTHORITY', true, 0, 0, 'Revogado');
  assert.strictEqual(gatePass.gate, 'MINT_AUTHORITY');
  assert.strictEqual(gatePass.result, 'PASS');
  assert.strictEqual(gatePass.detail, 'Revogado');

  const gateFail = DecisionLogger.evaluateGate('BUY_DOMINANCE', false, 0.9, 1.2);
  assert.strictEqual(gateFail.gate, 'BUY_DOMINANCE');
  assert.strictEqual(gateFail.result, 'FAIL');
  assert.strictEqual(gateFail.value, 0.9);
  assert.strictEqual(gateFail.threshold, 1.2);
});

test('DecisionLogger bufferiza em RAM e rastreia contadores sem bloquear', async () => {
  // Pool nulo para testar modo em memória / seguro
  const logger = new DecisionLogger(null, {
    maxBufferSize: 5,
    flushIntervalMs: 60000
  });

  const stats0 = logger.getStats();
  assert.strictEqual(stats0.bufferSize, 0);
  assert.strictEqual(stats0.totalLogged, 0);

  logger.logDecision({
    traceId: 'test-trace-1',
    decision: 'ENTRY_APPROVED',
    token: { mint: 'TestMint11111111111111111111111111111111' },
    market: { sentinelRegime: 'NORMAL' },
    gateEvaluations: [
      DecisionLogger.evaluateGate('MINT_AUTHORITY', true)
    ]
  });

  logger.logOutcome({
    traceId: 'test-trace-1',
    mint: 'TestMint11111111111111111111111111111111',
    entryPriceUsd: 0.001,
    entrySizeSol: 0.05,
    entryTimestamp: new Date(),
    pnlSol: 0.01,
    pnlPct: 20
  });

  const stats1 = logger.getStats();
  assert.strictEqual(stats1.totalLogged, 2);
  assert.strictEqual(stats1.bufferSize, 2);

  await logger.shutdown();
});

test('Decision Journal aceita composite_score fracionário e migra SMALLINT legado', () => {
  assert.match(
    DECISION_JOURNAL_DDL,
    /composite_score\s+NUMERIC\(5,2\)\s+CHECK \(composite_score BETWEEN 0 AND 100\)/
  );
  assert.match(
    DECISION_JOURNAL_DDL,
    /ALTER COLUMN composite_score TYPE NUMERIC\(5,2\)/
  );
  assert.match(
    DECISION_JOURNAL_DDL,
    /data_type = 'smallint'/
  );
});
