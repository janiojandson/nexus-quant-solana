import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'path';
import * as fs from 'fs';

const SPECS_DIR = path.join(__dirname, '../../docs/specs');
const REQUIRED_DOCS = [
  'NEXUS_V2_0_SPEC.md',
  'NEXUS_LATENCY_BUDGET.md',
  'NEXUS_FINANCIAL_CONTRACT.md',
  'NEXUS_FAILURE_MATRIX.md',
  'NEXUS_INCIDENT_FIXTURES_PLAN.md',
  'NEXUS_V2_0_READINESS_REPORT.md'
];

test('Nexus V2.0 Specification Documents Validation', async (t) => {
  await t.test('1. todos os 6 documentos de especificacao V2.0 existem e sao substanciais (> 1KB)', () => {
    for (const doc of REQUIRED_DOCS) {
      const docPath = path.join(SPECS_DIR, doc);
      assert.ok(fs.existsSync(docPath), `Missing spec document: ${doc}`);
      const stats = fs.statSync(docPath);
      assert.ok(stats.size > 1000, `Spec document ${doc} is too small (${stats.size} bytes)`);
    }
  });

  await t.test('2. NEXUS_V2_0_SPEC separa explicitamente IMPLEMENTED, PROPOSED e NAO IMPLEMENTADO', () => {
    const content = fs.readFileSync(path.join(SPECS_DIR, 'NEXUS_V2_0_SPEC.md'), 'utf8');
    assert.ok(content.includes('IMPLEMENTED'), 'Missing IMPLEMENTED tag');
    assert.ok(content.includes('PROPOSED'), 'Missing PROPOSED tag');
    assert.ok(content.includes('NÃO IMPLEMENTADO') || content.includes('NAO IMPLEMENTADO'), 'Missing NAO IMPLEMENTADO tag');
    assert.ok(content.includes('TelemetrySpan'), 'Missing TelemetrySpan documentation');
    assert.ok(content.includes('Universal Redaction'), 'Missing Universal Redaction documentation');
    assert.ok(content.includes('Clock Domains'), 'Missing Clock Domains documentation');
  });

  await t.test('3. NEXUS_LATENCY_BUDGET separa MEASURED NOW, NOT YET MEASURED e COARSE HISTORICAL ONLY', () => {
    const content = fs.readFileSync(path.join(SPECS_DIR, 'NEXUS_LATENCY_BUDGET.md'), 'utf8');
    assert.ok(content.includes('MEASURED NOW'), 'Missing MEASURED NOW tag');
    assert.ok(content.includes('NOT YET MEASURED'), 'Missing NOT YET MEASURED tag');
    assert.ok(content.includes('COARSE HISTORICAL ONLY'), 'Missing COARSE HISTORICAL ONLY tag');
    assert.ok(content.includes('JUPITER_QUEUE_WAIT_MS'), 'Missing JUPITER_QUEUE_WAIT_MS');
    assert.ok(content.includes('JUPITER_QUOTE_HTTP_MS'), 'Missing JUPITER_QUOTE_HTTP_MS');
  });

  await t.test('4. NEXUS_FINANCIAL_CONTRACT separa CONTRACT DEFINED de LEDGER NOT YET IMPLEMENTED', () => {
    const content = fs.readFileSync(path.join(SPECS_DIR, 'NEXUS_FINANCIAL_CONTRACT.md'), 'utf8');
    assert.ok(content.includes('CONTRACT DEFINED'), 'Missing CONTRACT DEFINED tag');
    assert.ok(content.includes('LEDGER NOT YET IMPLEMENTED'), 'Missing LEDGER NOT YET IMPLEMENTED tag');
    assert.ok(content.includes('fillVsSignalQuotePct'), 'Missing fillVsSignalQuotePct formula');
    assert.ok(content.includes('rentMovement'), 'Missing rentMovement documentation');
  });

  await t.test('5. NEXUS_FAILURE_MATRIX define as 7 categorias formais', () => {
    const content = fs.readFileSync(path.join(SPECS_DIR, 'NEXUS_FAILURE_MATRIX.md'), 'utf8');
    const categories = [
      'DETECTION_FAILURE',
      'EXECUTION_DELAY',
      'EXECUTION_FAILURE',
      'PRICE_GAP',
      'INSUFFICIENT_DEPTH',
      'ACCOUNTING_FAILURE',
      'UNKNOWN'
    ];
    for (const cat of categories) {
      assert.ok(content.includes(cat), `Missing failure category: ${cat}`);
    }
  });

  await t.test('6. NEXUS_INCIDENT_FIXTURES_PLAN detalha os 4 incidentes e lockfile', () => {
    const content = fs.readFileSync(path.join(SPECS_DIR, 'NEXUS_INCIDENT_FIXTURES_PLAN.md'), 'utf8');
    assert.ok(content.includes('Tesla'), 'Missing Tesla documentation');
    assert.ok(content.includes('SSI'), 'Missing SSI documentation');
    assert.ok(content.includes('Mr Beast'), 'Missing Mr Beast documentation');
    assert.ok(content.includes('SUPERPIG'), 'Missing SUPERPIG documentation');
    assert.ok(content.includes('fixtures.lock.json'), 'Missing fixtures.lock.json reference');
    assert.ok(content.includes('5,872'), 'Missing total 5872 observations reference');
  });

  await t.test('7. NEXUS_V2_0_READINESS_REPORT contem inventario de metricas e tags explicitas', () => {
    const content = fs.readFileSync(path.join(SPECS_DIR, 'NEXUS_V2_0_READINESS_REPORT.md'), 'utf8');
    const tags = ['LIVE_MEASURED', 'HISTORICAL_RECONSTRUCTED', 'MOCK', 'ESTIMATED', 'UNKNOWN'];
    for (const tag of tags) {
      assert.ok(content.includes(tag), `Missing tag: ${tag}`);
    }
    assert.ok(content.includes('JUPITER_QUEUE_WAIT_MS'), 'Missing JUPITER_QUEUE_WAIT_MS');
    assert.ok(content.includes('SOLANA_RPC'), 'Missing SOLANA_RPC');
    assert.ok(content.includes('approxEventToObservationMs'), 'Missing approxEventToObservationMs');
  });

  // V2.1 Specification Documents Validation
  await t.test('8. todos os 5 documentos de especificacao V2.1A existem e sao substanciais (> 1KB)', () => {
    const v21Docs = [
      'NEXUS_V2_1_JOURNAL_SPEC.md',
      'NEXUS_V2_1_STATE_MACHINE.md',
      'NEXUS_V2_1_RECONCILIATION.md',
      'NEXUS_V2_1_ACCOUNTING.md',
      'NEXUS_V2_1_READINESS.md'
    ];
    for (const doc of v21Docs) {
      const docPath = path.join(SPECS_DIR, doc);
      assert.ok(fs.existsSync(docPath), `Missing V2.1 spec document: ${doc}`);
      const stats = fs.statSync(docPath);
      assert.ok(stats.size > 1000, `V2.1 spec document ${doc} is too small (${stats.size} bytes)`);
    }
  });

  await t.test('9. NEXUS_V2_1_JOURNAL_SPEC separa IMPLEMENTED, PROPOSED e NAO IMPLEMENTADO', () => {
    const content = fs.readFileSync(path.join(SPECS_DIR, 'NEXUS_V2_1_JOURNAL_SPEC.md'), 'utf8');
    assert.ok(content.includes('IMPLEMENTED'), 'Missing IMPLEMENTED tag in V2.1 spec');
    assert.ok(content.includes('PROPOSED'), 'Missing PROPOSED tag in V2.1 spec');
    assert.ok(content.includes('NÃO IMPLEMENTADO') || content.includes('NAO IMPLEMENTADO'), 'Missing NAO IMPLEMENTADO tag in V2.1 spec');
    assert.ok(content.includes('claim_epoch'), 'Missing claim_epoch documentation');
    assert.ok(content.includes('SKIP LOCKED'), 'Missing SKIP LOCKED documentation');
  });

  await t.test('10. NEXUS_V2_1_RECONCILIATION documenta regra UNKNOWN !== FAILED_DEFINITIVE', () => {
    const content = fs.readFileSync(path.join(SPECS_DIR, 'NEXUS_V2_1_RECONCILIATION.md'), 'utf8');
    assert.ok(content.includes('reconciliationDebt') || content.includes('reconciliation_debt'), 'Missing reconciliationDebt');
    assert.ok(content.includes('UNKNOWN !== FAILED_DEFINITIVE'), 'Missing UNKNOWN !== FAILED_DEFINITIVE rule');
    assert.ok(content.includes('CAN_RETRY'), 'Missing CAN_RETRY verdict');
    assert.ok(content.includes('MUST_RECONCILE'), 'Missing MUST_RECONCILE verdict');
  });
});
