#!/usr/bin/env node
/**
 * Fail if any relative import in tracked TS sources does not resolve to a git-tracked file.
 * CI + pre-push gate (catches orphan imports after partial commits).
 */
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import {
  collectRelativeImportSpecs,
  listTypeScriptSources,
  resolveImportFile,
} from './import-graph-lib.mjs';

function fail(msg) {
  console.error(`[check-import-graph] FAIL: ${msg}`);
  process.exit(1);
}

function ok(msg) {
  console.log(`[check-import-graph] OK: ${msg}`);
}

const tracked = new Set(
  execSync('git ls-files', { encoding: 'utf8' })
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean),
);

const onlyTracked = process.argv.includes('--tracked-only');
const scopeRe = /^(src|tests)\/.+\.(ts|tsx|mts|cts)$/;
const sources = onlyTracked
  ? [...tracked].filter((f) => scopeRe.test(f) && !/\.d\.ts$/.test(f))
  : listTypeScriptSources();

const broken = [];

for (const file of sources) {
  if (!fs.existsSync(file)) continue;
  const text = fs.readFileSync(file, 'utf8');
  for (const spec of collectRelativeImportSpecs(text)) {
    const target = resolveImportFile(file, spec);
    if (target == null) {
      broken.push(`${file} -> ${spec} (missing on disk)`);
      continue;
    }
    if (!tracked.has(target)) {
      broken.push(`${file} -> ${spec} (resolves to ${target}, not git-tracked)`);
    }
  }
}

if (broken.length) {
  console.error('[check-import-graph] Broken relative imports:');
  for (const line of broken.slice(0, 40)) console.error(`  - ${line}`);
  if (broken.length > 40) console.error(`  ... and ${broken.length - 40} more`);
  fail('every relative import must resolve to a git-tracked file (git add missing modules)');
}

ok(`checked ${sources.length} source files, import graph intact`);
