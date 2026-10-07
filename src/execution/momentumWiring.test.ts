import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { observeEntryMomentum, DEFAULT_ENTRY_MOMENTUM_CONFIG } from './entryMomentumGate.js';

test('actual DEX preflight rejects stagnant samples and journals MOMENTUM_GATE', async () => {
  const source = ts.createSourceFile('index.ts', readFileSync(join(__dirname, '../index.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
  let block: ts.IfStatement | undefined;
  function visit(n: ts.Node) { if (ts.isIfStatement(n) && n.expression.getText(source) === 'ENTRY_MOMENTUM_GATE_ENABLED') block = n; ts.forEachChild(n, visit); }
  visit(source);
  assert.ok(block);
  const js = ts.transpileModule(`async function run(){let momentumTelemetry;for(const candidate of [1]){${block.getText(source)}return 'BUY';}return 'REJECT';}run;`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const decisions: any[] = [];
  const run = vm.runInNewContext(js, {
    console: { log() {}, warn() {} }, ENTRY_MOMENTUM_GATE_ENABLED: true,
    ENTRY_MOMENTUM_SAMPLES: 4, ENTRY_MOMENTUM_INTERVAL_MS: 0, ENTRY_MOMENTUM_MIN_RISE_PCT: 0.4,
    ENTRY_MOMENTUM_MAX_RISE_PCT: 4, ENTRY_MOMENTUM_MAX_PULLBACK_PCT: 0.3,
    observeEntryMomentum, scanner: { fetchCurrentTokenPriceUsd: async () => 1 },
    topCandidate: { mint: 'mint', symbol: 'STALE', liquidityUsd: 30000 },
    audit: { score: 95 }, SCAN_INTERVAL_MS: 30000, currentTraceId: 'trace',
    antiSpamMemory: { recordVeto() {} }, journal: { logDecision: (d: any) => decisions.push(d) },
    latestState: {}, gates: [], buySellRatio: 2
  });
  assert.equal(await run(), 'REJECT');
  assert.equal(decisions[0].decision, 'ENTRY_REJECTED');
  assert.equal(decisions[0].metadata.phase, 'MOMENTUM_GATE');
  assert.match(decisions[0].rejectionReason, /STALE_SOURCE/);
});
