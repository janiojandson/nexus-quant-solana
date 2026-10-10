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
