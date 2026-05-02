#!/usr/bin/env node
/**
 * RELEASE_OPERATING_MODEL.md — инвариант I5: каждый относительный путь из INDEX.md существует в дереве.
 * Опционально — чистое git-дерево (инвариант I6) для интегратора перед push в v2.
 *
 * Usage:
 *   node scripts/check-release-hygiene.mjs
 *   node scripts/check-release-hygiene.mjs --git-clean
 *   RELEASE_HYGIENE_GIT_CLEAN=1 node scripts/check-release-hygiene.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const indexPath = path.join(root, 'docs', 'strategy', 'specs', 'INDEX.md');
const versionPath = path.join(root, 'docs', 'strategy', 'release', 'VERSION');

const wantGitClean =
  process.argv.includes('--git-clean') || process.env.RELEASE_HYGIENE_GIT_CLEAN === '1';

function fail(msg) {
  console.error(`[check-release-hygiene] FAIL: ${msg}`);
  process.exit(1);
}

function ok(msg) {
  console.log(`[check-release-hygiene] OK: ${msg}`);
}

// --- VERSION ---
if (!fs.existsSync(versionPath)) fail(`missing ${path.relative(root, versionPath)}`);
const ver = fs.readFileSync(versionPath, 'utf8').trim();
if (!/^\d+\.\d+\.\d+$/.test(ver)) {
  fail(`${path.relative(root, versionPath)} must be a single semver line MAJOR.MINOR.PATCH, got: ${JSON.stringify(ver)}`);
}
ok(`product VERSION ${ver}`);

// --- INDEX links ---
if (!fs.existsSync(indexPath)) fail(`missing ${path.relative(root, indexPath)}`);
const indexText = fs.readFileSync(indexPath, 'utf8');
const linkRe = /\]\((\.\.?\/[^)#\s]+)/g;
const targets = new Set();
let m;
while ((m = linkRe.exec(indexText)) !== null) {
  let rel = m[1];
  if (rel.includes('://')) continue;
  targets.add(rel);
}

const indexDir = path.dirname(indexPath);
const missing = [];
for (const rel of targets) {
  const abs = path.resolve(indexDir, rel);
  if (!abs.startsWith(root)) {
    missing.push(`${rel} (escapes repo root)`);
    continue;
  }
  if (!fs.existsSync(abs)) missing.push(rel);
}

if (missing.length) {
  console.error('[check-release-hygiene] Broken paths from INDEX.md (I5):');
  for (const x of missing) console.error(`  - ${x}`);
  fail('fix INDEX.md links or add missing files');
}
ok(`${targets.size} relative link targets from INDEX.md exist`);

// --- Optional: clean git working tree (I6) ---
if (wantGitClean) {
  let out;
  try {
    out = execSync('git status --porcelain', { cwd: root, encoding: 'utf8' });
  } catch {
    fail('git status failed (not a git repo?)');
  }
  const lines = out
    .split('\n')
    .map((l) => l.trimEnd())
    .filter(Boolean);
  if (lines.length) {
    console.error('[check-release-hygiene] Uncommitted / untracked (I6):');
    for (const l of lines) console.error(`  ${l}`);
    fail('commit, stash, or remove changes before integration push');
  }
  ok('git working tree clean');
}

console.log('[check-release-hygiene] all checks passed');
