#!/usr/bin/env node
/** ENV inventory: dump all env keys from ecosystem.config.cjs and check usage in src/. */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const eco = (await import(pathToFileURL(path.join(ROOT, 'ecosystem.config.cjs')).href)).default;
const apps = eco.apps;

const allKeys = new Map();
for (const app of apps) {
  const env = app.env || {};
  for (const [k, v] of Object.entries(env)) {
    if (!allKeys.has(k)) allKeys.set(k, { values: new Map(), processes: new Set() });
    const entry = allKeys.get(k);
    entry.processes.add(app.name);
    const valKey = String(v);
    entry.values.set(valKey, [...(entry.values.get(valKey) || []), app.name]);
  }
}

function readDirRec(dir, files = []) {
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, f.name);
    if (f.isDirectory()) {
      if (f.name === 'node_modules' || f.name === '.git' || f.name === 'data' || f.name === 'archive') continue;
      readDirRec(p, files);
    } else if (/\.(ts|mjs|js|cjs)$/i.test(f.name)) {
      files.push(p);
    }
  }
  return files;
}

const srcFiles = readDirRec(path.join(ROOT, 'src'));
const scriptsFiles = fs.existsSync(path.join(ROOT, 'scripts')) ? readDirRec(path.join(ROOT, 'scripts')) : [];
const scriptsTmpFiles = readDirRec(path.join(ROOT, 'scripts-tmp'));

const corpus = [...srcFiles, ...scriptsFiles, ...scriptsTmpFiles].map((f) => ({
  path: path.relative(ROOT, f).replace(/\\/g, '/'),
  text: fs.readFileSync(f, 'utf8'),
}));

const result = [];
for (const [key, info] of allKeys) {
  const filesUsing = corpus.filter((c) => c.text.includes(key)).map((c) => c.path);
  const filesUsingSrc = filesUsing.filter((p) => p.startsWith('src/'));
  const filesUsingNonSrc = filesUsing.filter((p) => !p.startsWith('src/'));
  const distinctValues = info.values.size;
  let status;
  if (filesUsing.length === 0) status = 'ORPHAN';
  else if (distinctValues > 1) status = 'MULTI_VALUE';
  else if (info.processes.size > 1) status = 'MULTI_PROCESS';
  else status = 'OK';
  result.push({
    key,
    status,
    processes: [...info.processes],
    distinctValues,
    valueSample: [...info.values.keys()][0]?.slice(0, 60),
    filesUsingSrcCount: filesUsingSrc.length,
    filesUsingNonSrcCount: filesUsingNonSrc.length,
    filesSrcSample: filesUsingSrc.slice(0, 3),
  });
}

result.sort((a, b) => {
  const order = { ORPHAN: 0, MULTI_VALUE: 1, MULTI_PROCESS: 2, OK: 3 };
  return order[a.status] - order[b.status] || a.key.localeCompare(b.key);
});

const stats = {
  total: result.length,
  orphans: result.filter((r) => r.status === 'ORPHAN').length,
  multiValue: result.filter((r) => r.status === 'MULTI_VALUE').length,
  multiProcess: result.filter((r) => r.status === 'MULTI_PROCESS').length,
  ok: result.filter((r) => r.status === 'OK').length,
};

console.log('# ENV inventory stats:', JSON.stringify(stats, null, 2));

const outPath = path.join(ROOT, 'docs/strategy/refactor/_env-inventory-raw.json');
fs.writeFileSync(outPath, JSON.stringify({ stats, env: result }, null, 2));
console.log('# wrote', outPath);

console.log('\n## ORPHANS (env in ecosystem, never read in code)');
for (const r of result.filter((x) => x.status === 'ORPHAN')) {
  console.log(`  ${r.key.padEnd(48)} value=${r.valueSample}  processes=${r.processes.join(',')}`);
}

console.log('\n## MULTI_VALUE (same key, different value across processes)');
for (const r of result.filter((x) => x.status === 'MULTI_VALUE')) {
  const valuesByVal = [];
  const orig = allKeys.get(r.key).values;
  for (const [v, procs] of orig) valuesByVal.push(`${v}@${procs.join(',')}`);
  console.log(`  ${r.key.padEnd(48)} ${valuesByVal.join(' | ')}`);
}
