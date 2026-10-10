import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
const root = process.cwd();
const script = resolve(root, 'scripts/package-shadow-release.cjs');
const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const fixture = (omitLock = false) => {
  const dir = mkdtempSync(join(tmpdir(), 'shadow-package-fixture-'));
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'nexus-pump-sentinel', scripts: { build: 'tsc', start: 'node dist/index.js' } }),
    'package-lock.json': '{"lockfileVersion":3}', 'tsconfig.json': '{}', 'src/index.ts': 'export const version = 1;',
    'public/index.html': '<html>sentinel</html>', 'src/schema.sql': 'SELECT 1;',
    'src/config/env.ts': 'export const VERSION = 1;',
    'src/audit/contractGates.ts': 'export const gate = 1;',
    'src/audit/auditLog.ts': 'export const log = 1;',
    'railway.json': JSON.stringify({ build: { builder: 'RAILPACK' }, deploy: {
      startCommand: 'node dist/index.js', region: 'us-west2', numReplicas: 1,
      multiRegionConfig: { 'us-west2': { numReplicas: 1 } } } }),
    'railpack.json': JSON.stringify({ steps: { install: { commands: ['npm ci --include=dev'] },
      build: { commands: ['npm run build', 'npm prune --omit=dev'] } }, deploy: { startCommand: 'node dist/index.js' } }),
    '.railwayignore': '**/.env*\n', '.railpackignore': '**/.env*\n',
    '.env.production': 'SYNTHETIC_NOT_A_SECRET', 'src/.env.local': 'SYNTHETIC',
    'src/check.test.ts': 'throw 1', 'src/demo.testFixture.ts': 'throw 1',
    'src/scripts/audit.ts': 'throw 1', 'scripts/audit.cjs': 'throw 1',
    'deploy/legacy/Dockerfile': 'FROM old', '.superpowers/review.md': 'private notes',
    'node_modules/synthetic/index.js': 'bad', 'dist/index.js': 'bad', 'coverage/a.txt': 'bad'
  };
  if (omitLock) delete files['package-lock.json'];
  for (const [file, data] of Object.entries(files)) {
    mkdirSync(join(dir, file, '..'), { recursive: true }); writeFileSync(join(dir, file), data);
  }
  git(dir, ['init', '-q']);
  git(dir, ['add', '.']);
  git(dir, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    '-c', 'commit.gpgsign=false', 'commit', '-qm', 'synthetic packaging fixture']);
  return { dir, sha: git(dir, ['rev-parse', 'HEAD']) };
};
test('release source selects locked Railpack and retains us-west2 single replica without root Docker detection', () => {
  assert.equal(existsSync(join(root, 'Dockerfile')), false);
  assert.equal(existsSync(join(root, 'deploy/legacy/Dockerfile')), true);
  const railway = JSON.parse(readFileSync(join(root, 'railway.json'), 'utf8'));
  assert.equal(railway.build.builder, 'RAILPACK');
  assert.equal(railway.deploy.region, 'us-west2');
  assert.equal(railway.deploy.numReplicas, 1);
  assert.equal(railway.deploy.startCommand, 'node dist/index.js');
  assert.deepEqual(railway.deploy.multiRegionConfig, { 'us-west2': { numReplicas: 1 } });
  const railpack = JSON.parse(readFileSync(join(root, 'railpack.json'), 'utf8'));
  assert.deepEqual(railpack.steps.install.commands, ['npm ci --include=dev']);
  assert.deepEqual(railpack.steps.build.commands, ['npm run build', 'npm prune --omit=dev']);
  assert.equal(railpack.deploy.startCommand, 'node dist/index.js');
  const railwayignore = readFileSync(join(root, '.railwayignore'), 'utf8');
  const railpackignore = readFileSync(join(root, '.railpackignore'), 'utf8');
  assert.match(railwayignore, /\*\*\/\.env\*/);
  assert.match(railwayignore, /node_modules/);
  assert.match(railpackignore, /\*\*\/\.env\*/);
  assert.match(railpackignore, /node_modules/);
  const dockerfile = readFileSync(join(root, 'deploy/legacy/Dockerfile'), 'utf8');
  assert.match(dockerfile, /FROM node/);
});
test('package command generates HEAD-only allowlisted files and tar with verifiable hashes', () => {
  const f = fixture(); const out = join(f.dir, 'bundle');
  writeFileSync(join(f.dir, 'src/index.ts'), 'dirty workstation version');
  writeFileSync(join(f.dir, 'src/untracked.ts'), 'not approved');
  const run = spawnSync(process.execPath, [script, '--repo', f.dir, '--approved-head', f.sha, '--out', out], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
  assert.equal(manifest.commit, f.sha);
  assert.equal(readFileSync(join(out, 'source/src/index.ts'), 'utf8'), 'export const version = 1;');
  const names = manifest.files.map((v: {path: string}) => v.path);
  assert.ok(names.includes('public/index.html'));
  assert.ok(names.includes('package-lock.json'));
  assert.ok(names.includes('src/schema.sql'));
  // Legitimate source modules (config + audit source) must be RETAINED (regression guard).
  assert.ok(names.includes('src/config/env.ts'));
  assert.ok(names.includes('src/audit/contractGates.ts'));
  assert.ok(names.includes('src/audit/auditLog.ts'));
  // Secrets, test files/fixtures, audit scripts, artifacts, legacy and tooling must be EXCLUDED.
  const excluded = ['.env.production', 'src/.env.local', 'src/check.test.ts', 'src/demo.testFixture.ts',
    'src/scripts/audit.ts', 'scripts/audit.cjs', 'deploy/legacy/Dockerfile', '.superpowers/review.md'];
  assert.equal(excluded.some((v: string) => names.includes(v)), false);
  assert.equal(names.some((v: string) => /(^|\/)(node_modules|dist|coverage)(\/|$)/.test(v)), false);
  const tarNames = execFileSync('tar', ['-tf', join(out, 'source.tar')], { encoding: 'utf8' }).trim().split(/\r?\n/).filter(v=>!v.endsWith('/')).sort();
  assert.deepEqual(tarNames, names.slice().sort());
  assert.match(manifest.archiveSha256, /^[a-f0-9]{64}$/);
  assert.equal(manifest.files.length, 13); // 8 não-src + 5 src (index, schema, env, contractGates, auditLog)
});
test('packaging denies unapproved HEAD, missing lockfile and existing destination without overwriting', () => {
  const f = fixture();
  for (const sha of ['0'.repeat(40), 'HEAD']) {
    const run = spawnSync(process.execPath, [script, '--repo', f.dir, '--approved-head', sha, '--out', join(f.dir, 'denied')], { encoding: 'utf8' });
    assert.notEqual(run.status, 0);
    assert.equal(existsSync(join(f.dir, 'denied')), false);
  }
  const missing = fixture(true);
  const denied = spawnSync(process.execPath, [script, '--repo', missing.dir, '--approved-head', missing.sha, '--out', join(missing.dir, 'denied')], { encoding: 'utf8' });
  assert.notEqual(denied.status, 0);
  assert.match(denied.stderr, /REQUIRED_FILE_MISSING/);
  const out = join(f.dir, 'existing'); mkdirSync(out); writeFileSync(join(out, 'keep'), 'preserve');
  const run = spawnSync(process.execPath, [script, '--repo', f.dir, '--approved-head', f.sha, '--out', out], { encoding: 'utf8' });
  assert.notEqual(run.status, 0);
  assert.equal(readFileSync(join(out, 'keep'), 'utf8'), 'preserve');
});

