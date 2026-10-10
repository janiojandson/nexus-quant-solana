import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = ts.createSourceFile('index.ts',
  readFileSync('src/index.ts', 'utf8'),
  ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const exit = source.statements.find(node => ts.isFunctionDeclaration(node) &&
  node.name?.text === 'executeExitOrderUnlocked') as ts.FunctionDeclaration | undefined;
const monitor = source.statements.find(node => ts.isFunctionDeclaration(node) &&
  node.name?.text === 'runUltraFastExitMonitor') as ts.FunctionDeclaration | undefined;
const boot = source.statements.find(node => ts.isFunctionDeclaration(node) &&
  node.name?.text === 'main') as ts.FunctionDeclaration | undefined;
const handoff = source.statements.find(node => ts.isFunctionDeclaration(node) &&
  node.name?.text === 'handleSentinelGraduationDip') as ts.FunctionDeclaration | undefined;

function callAt(node: ts.Node, name: string): number {
  const found: number[] = [];
  const visit = (part: ts.Node) => {
    if (ts.isCallExpression(part) && part.expression.getText(source) === name) found.push(part.getStart(source));
    ts.forEachChild(part, visit);
  };
  visit(node);
  assert.ok(found.length, `missing ${name}`);
  return Math.min(...found);
}

test('runtime LIVE verifies schema before transport and awaits immutable fill before local effects', () => {
  assert.ok(exit?.body);
  assert.ok(callAt(exit, 'positionLedger.assertLiveExitReady') < callAt(exit, 'jupiterEngine.executeSwap'));
  assert.ok(callAt(exit, 'validateConfirmedLiveExitEvidence') <
    callAt(exit, 'positionLedger.appendConfirmedLiveFill'));
  assert.ok(callAt(exit, 'positionLedger.appendConfirmedLiveFill') <
    callAt(exit, 'positionEngine.commitPartialExit'));
  assert.ok(callAt(exit, 'positionLedger.appendConfirmedLiveFill') <
    callAt(exit, 'wallet.closeTokenAccount'));
  assert.ok(callAt(exit, 'positionLedger.appendConfirmedLiveFill') <
    callAt(exit, 'positionEngine.removePosition'));
  assert.equal(exit.getText(source).includes('journal.logOutcome('), false);
  assert.match(exit.getText(source), /LIVE confirmed exit needs reconciliation/);
});

test('runtime SHADOW exits cannot enter signed LIVE transport and monitor uses physical proof', () => {
  assert.ok(exit?.body && monitor?.body);
  const body = exit.getText(source);
  assert.ok(body.indexOf("pos.accountingMode === 'SHADOW'") < body.indexOf('getExecutionSigner()'));
  assert.match(monitor.getText(source), /physicalSnapshot\.code === 'INSUFFICIENT_PHYSICAL_SOL'/);
  assert.equal(monitor.getText(source).includes('20_000'), false);
});

test('SHADOW exit decisions use conservative net quote before the ladder', () => {
  assert.ok(monitor?.body);
  assert.ok(callAt(monitor, 'shadowLiquidableValue') <
    callAt(monitor, 'positionEngine.evaluateExitBySol'));
  assert.match(monitor.getText(source), /liquidable\.netLamports\s*\/\s*1e9/);
});

test('boot only manages positions in active accounting mode and polling excludes opposite mode', () => {
  assert.ok(boot?.body);
  const body = boot.getText(source);
  assert.match(body, /if \(!IS_DRY_RUN\)\s*await rehydratePositionsFromWalletOnBoot\(\)/);
  assert.match(body, /adaptiveExitPoller\.tick\(positionEngine\.getAllPositions\(\)\.filter\(/);
  assert.match(body, /accountingMode === \(IS_DRY_RUN \? 'SHADOW' : 'LIVE'\)/);
});

test('handoff performs fenced durable recovery before rejecting new entry at capacity', () => {
  assert.ok(handoff?.body);
  const body = handoff.getText(source);
  assert.ok(body.indexOf('positionLedger.recover(') >= 0);
  assert.ok(body.indexOf('positionLedger.recover(') < body.indexOf('ENTRY_CAPACITY_UNAVAILABLE'));
  assert.ok(body.indexOf('positionLedger.recover(') < body.indexOf('buildEquitySizingPolicy('));
});

test('wallet custody refresh cannot reconcile real SPL balance into SHADOW token amount', () => {
  const cycle = source.statements.find(node => ts.isFunctionDeclaration(node) &&
    node.name?.text === 'executeAutonomousCycle') as ts.FunctionDeclaration | undefined;
  assert.ok(cycle?.body);
  const body = cycle.getText(source);
  assert.ok(body.indexOf("tracked.accountingMode === 'SHADOW'") >= 0);
  assert.ok(body.indexOf("tracked.accountingMode === 'SHADOW'") < body.indexOf('tracked.tokenAmount = atomicAmount'));
});

test('runtime treats quote HOLD as ordinary retry while persistence failures lock reconciliation', () => {
  assert.ok(monitor?.body);
  const body = monitor.getText(source);
  const commit = body.indexOf('await commitShadowExitFromQuote(');
  const hold = body.indexOf("shadowOutcome.kind === 'HOLD'");
  const lock = body.indexOf('uncertainExitMints.add(pos.mint)', commit);
  assert.ok(commit >= 0 && hold > commit && lock > hold);
  assert.match(body.slice(commit, lock), /SHADOW_QUOTE_HOLD/);
  assert.match(body.slice(lock), /SHADOW ledger commit uncertain/);
});
