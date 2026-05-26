#!/usr/bin/env node
/**
 * Pre-commit: staged TS files must not import modules that exist only as untracked local files.
 * Fixes the mcap-snapshot class of bugs (local typecheck green, push breaks CI/prod).
 */
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import { collectRelativeImportSpecs, resolveImportFile } from './import-graph-lib.mjs';

function fail(msg) {
  console.error(`[check-staged-imports] FAIL: ${msg}`);
  process.exit(1);
}

function ok(msg) {
  console.log(`[check-staged-imports] OK: ${msg}`);
}

let staged;
try {
  staged = execSync('git diff --cached --name-only --diff-filter=ACMR', { encoding: 'utf8' })
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
} catch {
  ok('not a git repo, skip');
  process.exit(0);
}

if (staged.length === 0) {
  ok('nothing staged');
  process.exit(0);
}

const tracked = new Set(
  execSync('git ls-files', { encoding: 'utf8' })
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean),
);
const stagedSet = new Set(staged);

const tsStaged = staged.filter((f) => /\.(ts|tsx|mts|cts)$/.test(f) && !/\.d\.ts$/.test(f));
const violations = [];

for (const file of tsStaged) {
  if (!fs.existsSync(file)) continue;
  const text = fs.readFileSync(file, 'utf8');
  for (const spec of collectRelativeImportSpecs(text)) {
    const target = resolveImportFile(file, spec);
    if (target == null) {
      violations.push(`${file} imports ${spec} but target file is missing`);
      continue;
    }
    const allowed = tracked.has(target) || stagedSet.has(target);
    if (!allowed) {
      violations.push(
        `${file} imports ${spec} -> ${target}; file exists locally but is not staged (git add ${target})`,
      );
    }
  }
}

if (violations.length) {
  console.error('[check-staged-imports] Staged commit would break CI/prod:');
  for (const v of violations) console.error(`  - ${v}`);
  fail('stage imported files together with consumers, or commit imports only after dependency is tracked');
}

ok(`checked ${tsStaged.length} staged TS file(s)`);
