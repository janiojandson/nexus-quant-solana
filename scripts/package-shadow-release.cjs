#!/usr/bin/env node
'use strict';
// Empacota SOMENTE arquivos allowlist do HEAD aprovado (verificação de release; não é o artefato de deploy RAILPACK).
// Uso: node scripts/package-shadow-release.cjs --repo <dir> --approved-head <sha40> --out <dir>
const { execFileSync } = require('node:child_process');
const { mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync } = require('node:fs');
const { createHash } = require('node:crypto');
const { join, dirname, resolve } = require('node:path');

function arg(name) {
  const i = process.argv.indexOf(name);
  if (i < 0 || i + 1 >= process.argv.length) { console.error(`MISSING_ARG: ${name}`); process.exit(2); }
  return process.argv[i + 1];
}

const repo = resolve(arg('--repo'));
const approvedHead = arg('--approved-head');
const out = resolve(arg('--out'));

if (!/^[0-9a-f]{40}$/.test(approvedHead)) {
  console.error('UNAPPROVED_HEAD: --approved-head must be a 40-char lowercase commit SHA');
  process.exit(1);
}
try { execFileSync('git', ['-C', repo, 'cat-file', '-e', `${approvedHead}^{commit}`], { stdio: 'ignore' }); }
catch { console.error('UNAPPROVED_HEAD: not a commit in this repository'); process.exit(1); }

let tracked;
try {
  tracked = execFileSync('git', ['-C', repo, 'ls-tree', '-r', '--name-only', approvedHead], { encoding: 'utf8' })
    .split(/\r?\n/).filter(Boolean);
} catch (e) { console.error(`REPO_READ_FAILED: ${e.message}`); process.exit(1); }

const deny = [
  /(^|\/)\.env/,                             // segredos: .env, .env.production, src/.env.local
  /(^|\/)(node_modules|dist|coverage)(\/|$)/, // artefatos de build (dirs, casamento por segmento)
  /\.(test|testFixture|spec)\./,              // arquivos de teste/fixture/spec (*.test.ts, *.testFixture.ts)
  /(^|\/)(test|tests|__tests__)(\/|$)/,       // diretórios de teste
  /(^|\/)(src\/scripts|scripts)\/audit[^/]*\.[^/]+$/, // scripts de auditoria (só em scripts/ e src/scripts/)
  /(^|\/)(deploy\/legacy|legacy)(\/|$)/,      // artefatos legados de deploy
  /(^|\/)\.superpowers(\/|$)/                 // tooling
];
const allow = tracked.filter(p => !p.startsWith('.git') && !deny.some(re => re.test(p))).sort();

if (!allow.includes('package-lock.json')) {
  console.error('REQUIRED_FILE_MISSING: package-lock.json not present at approved HEAD');
  process.exit(1);
}

if (existsSync(out)) {
  console.error('DESTINATION_EXISTS: output directory already exists; refusing to overwrite');
  process.exit(1);
}

const sourceDir = join(out, 'source');
for (const p of allow) {
  let content;
  try { content = execFileSync('git', ['-C', repo, 'show', `${approvedHead}:${p}`], { maxBuffer: 64 * 1024 * 1024 }); }
  catch { console.error(`FILE_READ_FAILED: ${p}`); process.exit(1); }
  const dest = join(sourceDir, p);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, content);
}

const tarPath = join(out, 'source.tar');
const listPath = join(out, '.filelist.tmp');
writeFileSync(listPath, allow.join('\n') + '\n');
try { execFileSync('tar', ['-cf', tarPath, '-C', sourceDir, '-T', listPath], { stdio: 'pipe' }); }
catch (e) { console.error(`TAR_FAILED: ${e.message}`); process.exit(1); }
finally { try { unlinkSync(listPath); } catch {} }

const archiveSha256 = createHash('sha256').update(readFileSync(tarPath)).digest('hex');
const manifest = { commit: approvedHead, archiveSha256, files: allow.map(p => ({ path: p })) };
writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`PACKAGED ${allow.length} files -> ${out}`);
