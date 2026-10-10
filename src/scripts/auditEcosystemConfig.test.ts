import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

// Evaluate only configuration declarations: never import/boot the diagnostic script.
const source = ts.createSourceFile('auditEcosystem.ts',
  readFileSync(join(__dirname, 'auditEcosystem.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
function evaluate(name: string, env: Record<string, string>) {
  const statement = source.statements.find(node => ts.isVariableStatement(node) &&
    node.declarationList.declarations.some(item => item.name.getText(source) === name));
  assert.ok(statement, `missing ${name} configuration`);
  const js = ts.transpileModule(statement.getText(source), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText;
  return vm.runInNewContext(`${js}\n${name};`, { process: { env } });
}

test('ecosystem audit refuses absent DB/RPC configuration before any diagnostic network request', () => {
  assert.throws(() => evaluate('DB_URL', {}), /DATABASE_URL_REQUIRED/);
  assert.throws(() => evaluate('RPC_URL', {}), /HELIUS_RPC_URL_REQUIRED/);
});

test('ecosystem audit accepts explicitly supplied URLs and public DB alias without fallback', () => {
  assert.equal(evaluate('DB_URL', { DATABASE_URL: 'postgresql://fixture.invalid/test' }),
    'postgresql://fixture.invalid/test');
  assert.equal(evaluate('DB_URL', { DATABASE_PUBLIC_URL: 'postgresql://fixture.invalid/public' }),
    'postgresql://fixture.invalid/public');
  assert.equal(evaluate('RPC_URL', { HELIUS_RPC_URL: 'https://fixture.invalid/rpc' }),
    'https://fixture.invalid/rpc');
});
