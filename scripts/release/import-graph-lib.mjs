/**
 * Resolve relative TS imports to repo-relative POSIX paths (without extension).
 */
import fs from 'node:fs';
import path from 'node:path';

const IMPORT_FROM_RE =
  /(?:import|export)\s+(?:type\s+)?(?:\{[^}]*\}|\*\s+as\s+[\w$]+|[\w$]+)\s+from\s+['"](\.[^'"]+)['"]/g;
const IMPORT_SIDE_RE = /import\s+['"](\.[^'"]+)['"]/g;

export function repoRelativePosix(fromAbs, spec) {
  const resolved = path.resolve(path.dirname(fromAbs), spec);
  return path.relative(process.cwd(), resolved).split(path.sep).join('/');
}

export function collectRelativeImportSpecs(sourceText) {
  const specs = new Set();
  for (const line of sourceText.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('import') && !trimmed.startsWith('export')) continue;
    for (const re of [IMPORT_FROM_RE, IMPORT_SIDE_RE]) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(trimmed)) !== null) {
        if (m[1]) specs.add(m[1]);
      }
    }
  }
  return [...specs];
}

/** Map import spec → existing repo-relative file path, or null. */
export function resolveImportFile(fromRepoRel, spec) {
  const fromAbs = path.resolve(process.cwd(), fromRepoRel);
  let specPath = spec;
  if (specPath.endsWith('.js') || specPath.endsWith('.ts') || specPath.endsWith('.tsx') || specPath.endsWith('.mjs')) {
    specPath = specPath.replace(/\.(js|ts|tsx|mjs)$/, '');
  }
  const baseRepoRel = repoRelativePosix(fromAbs, specPath);
  const baseAbs = path.resolve(process.cwd(), baseRepoRel);

  const candidates = [
    `${baseAbs}.ts`,
    `${baseAbs}.tsx`,
    `${baseAbs}.mts`,
    `${baseAbs}.cts`,
    `${baseAbs}.mjs`,
    `${baseAbs}.js`,
    path.join(baseAbs, 'index.ts'),
    path.join(baseAbs, 'index.tsx'),
    path.join(baseAbs, 'index.mjs'),
  ];

  for (const abs of candidates) {
    if (!fs.existsSync(abs)) continue;
    const rel = path.relative(process.cwd(), abs).split(path.sep).join('/');
    return rel;
  }
  return null;
}

export function listTypeScriptSources(globRoots = ['src', 'tests']) {
  const out = [];
  for (const root of globRoots) {
    const absRoot = path.resolve(process.cwd(), root);
    if (!fs.existsSync(absRoot)) continue;
    walk(absRoot, out);
  }
  return out.sort();
}

function walk(dir, out) {
  for (const name of fs.readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const abs = path.join(dir, name);
    const st = fs.statSync(abs);
    if (st.isDirectory()) {
      walk(abs, out);
      continue;
    }
    if (/\.(ts|tsx|mts|cts)$/.test(name) && !/\.d\.ts$/.test(name)) {
      out.push(path.relative(process.cwd(), abs).split(path.sep).join('/'));
    }
  }
}
