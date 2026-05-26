#!/usr/bin/env node
/**
 * Regenerates docs/platform/PRODUCT_REGISTRY.md from products.yaml.
 *
 * Usage:
 *   node docs/platform/generate-registry.mjs
 *
 * Exits non-zero if products.yaml is invalid (missing required fields,
 * duplicate keys, conflicting prefixes/schemas).
 *
 * Zero runtime dependencies. Uses a tiny YAML subset parser tailored to
 * products.yaml — we control the input format, no need for a full parser.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const YAML_PATH = resolve(__dirname, 'products.yaml');
const REG_PATH = resolve(__dirname, 'PRODUCT_REGISTRY.md');
const VERSION_PATH = resolve(__dirname, 'VERSION');

// ---- minimal YAML subset parser ------------------------------------------
// Supports: scalars, quoted strings, lists, nested maps, null, comments,
// block scalars (|). Indentation is 2 spaces. No anchors/aliases/flow style.
// This is intentionally small; products.yaml is hand-controlled.

function parseYaml(src) {
  const lines = src.split(/\r?\n/);
  let i = 0;

  function peekIndent() {
    while (i < lines.length) {
      const line = lines[i];
      if (line.trim() === '' || line.trimStart().startsWith('#')) {
        i++;
        continue;
      }
      return line.length - line.trimStart().length;
    }
    return -1;
  }

  function parseValueScalar(raw) {
    const t = raw.trim();
    if (t === '' || t === '~' || t === 'null') return null;
    if (t === 'true') return true;
    if (t === 'false') return false;
    if (/^-?\d+$/.test(t)) return Number(t);
    if (/^-?\d+\.\d+$/.test(t)) return Number(t);
    if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
      return t.slice(1, -1);
    }
    return t;
  }

  function parseBlockScalar(baseIndent) {
    // we just consumed a `|` line; collect subsequent more-indented lines
    const out = [];
    while (i < lines.length) {
      const line = lines[i];
      if (line.trim() === '') { out.push(''); i++; continue; }
      const ind = line.length - line.trimStart().length;
      if (ind <= baseIndent) break;
      out.push(line.slice(baseIndent + 2));
      i++;
    }
    return out.join('\n').replace(/\s+$/, '');
  }

  function parseMap(baseIndent) {
    const obj = {};
    while (i < lines.length) {
      const line = lines[i];
      if (line.trim() === '' || line.trimStart().startsWith('#')) { i++; continue; }
      const ind = line.length - line.trimStart().length;
      if (ind < baseIndent) break;
      if (ind > baseIndent) throw new Error(`unexpected indent at line ${i + 1}: ${line}`);
      const content = line.slice(ind);
      if (content.startsWith('- ')) break; // list item, caller handles
      const colon = content.indexOf(':');
      if (colon < 0) throw new Error(`expected ':' at line ${i + 1}: ${line}`);
      const key = content.slice(0, colon).trim();
      const after = content.slice(colon + 1);
      i++;
      if (after.trim() === '') {
        // either nested map or list
        const nextInd = peekIndent();
        if (nextInd > baseIndent) {
          const nextLine = lines[i] ?? '';
          if (nextLine.slice(nextInd).startsWith('- ')) {
            obj[key] = parseList(nextInd);
          } else {
            obj[key] = parseMap(nextInd);
          }
        } else {
          obj[key] = null;
        }
      } else if (after.trim() === '|') {
        obj[key] = parseBlockScalar(baseIndent);
      } else {
        obj[key] = parseValueScalar(after);
      }
    }
    return obj;
  }

  function parseList(baseIndent) {
    const out = [];
    while (i < lines.length) {
      const line = lines[i];
      if (line.trim() === '' || line.trimStart().startsWith('#')) { i++; continue; }
      const ind = line.length - line.trimStart().length;
      if (ind < baseIndent) break;
      if (ind > baseIndent) throw new Error(`unexpected indent at line ${i + 1}: ${line}`);
      const content = line.slice(ind);
      if (!content.startsWith('- ')) break;
      const after = content.slice(2);
      if (after.trim() === '') {
        i++;
        out.push(parseMap(baseIndent + 2));
      } else if (after.includes(':') && !after.startsWith('"') && !after.startsWith("'")) {
        // first key of a map item, inline with `-`
        // rewrite this line as if `-` was on its own and the rest at +2
        lines[i] = ' '.repeat(baseIndent + 2) + after;
        out.push(parseMap(baseIndent + 2));
      } else {
        out.push(parseValueScalar(after));
        i++;
      }
    }
    return out;
  }

  // top-level: a map at indent 0
  return parseMap(0);
}

// ---- validation ----------------------------------------------------------

function validate(spec) {
  const errors = [];
  if (!spec.platform_version) errors.push('missing platform_version');
  if (!Array.isArray(spec.products)) errors.push('products must be a list');
  const seen = { product_key: new Set(), db_schema: new Set(), env_prefix: new Set(), systemd_prefix: new Set(), site_route: new Set() };
  for (const p of spec.products || []) {
    const required = ['product_key', 'product_name', 'owner', 'status', 'db_schema', 'env_prefix', 'systemd_prefix', 'site_routes'];
    for (const f of required) {
      if (p[f] === undefined || p[f] === null || p[f] === '') errors.push(`product '${p.product_key || '?'}': missing ${f}`);
    }
    if (p.product_key && seen.product_key.has(p.product_key)) errors.push(`duplicate product_key: ${p.product_key}`);
    seen.product_key.add(p.product_key);
    if (p.db_schema && seen.db_schema.has(p.db_schema)) errors.push(`duplicate db_schema: ${p.db_schema}`);
    seen.db_schema.add(p.db_schema);
    if (p.systemd_prefix && seen.systemd_prefix.has(p.systemd_prefix)) errors.push(`duplicate systemd_prefix: ${p.systemd_prefix}`);
    seen.systemd_prefix.add(p.systemd_prefix);
    for (const ep of p.env_prefix || []) {
      if (!/^[A-Z][A-Z0-9_]*_$/.test(ep)) errors.push(`product '${p.product_key}': env_prefix '${ep}' must be UPPER_SNAKE ending with '_'`);
      if (seen.env_prefix.has(ep)) errors.push(`duplicate env_prefix: ${ep}`);
      seen.env_prefix.add(ep);
    }
    for (const r of p.site_routes || []) {
      if (typeof r !== 'string' || !r.startsWith('/')) errors.push(`product '${p.product_key}': site_route '${r}' must start with '/'`);
      if (seen.site_route.has(r)) errors.push(`duplicate site_route: ${r}`);
      seen.site_route.add(r);
    }
    if (!/^[a-z][a-z0-9-]*-$/.test(p.systemd_prefix || '')) errors.push(`product '${p.product_key}': systemd_prefix must be kebab-case ending with '-'`);
  }
  return errors;
}

// ---- markdown generation -------------------------------------------------

function fmtList(v) {
  if (!v) return '';
  if (Array.isArray(v)) return v.map((x) => `\`${x}\``).join(', ');
  return `\`${v}\``;
}

function generateRegistryMd(spec, version) {
  const rows = spec.products.map((p) => {
    return `| \`${p.product_key}\` | ${p.product_name} | ${p.owner} | ${p.status} | \`${p.db_schema}\` | ${fmtList(p.env_prefix)} | \`${p.systemd_prefix}\` | ${fmtList(p.site_routes)} | ${(p.shared_dependencies || []).join(', ')} | ${(p.notes || '').replace(/\n/g, ' ').trim()} |`;
  });
  return `# Product Registry

> **GENERATED FILE — DO NOT EDIT BY HAND.**
> Source of truth: \`docs/platform/products.yaml\`.
> Regenerate: \`node docs/platform/generate-registry.mjs\`.
> Platform version: ${version}

Single source of truth for product ownership and isolation boundaries.

## Rules

- Every product must have unique values for:
  - \`db_schema\`
  - \`env_prefix\` (each prefix string globally unique)
  - \`systemd_prefix\`
  - \`site_routes\` (each route globally unique)
- Shared components are listed explicitly in \`shared_dependencies\`.
- Any change to \`products.yaml\` is a platform-level change and must be:
  1. Reviewed against \`BOUNDARIES.md\` and \`DB_TOPOLOGY.md\`.
  2. Accompanied by a \`PLATFORM_CHANGELOG.md\` entry and \`VERSION\` bump.
  3. Followed by regenerating this file.

## Registry

| product_key | product_name | owner | status | db_schema | env_prefix | systemd_prefix | site_routes | shared_dependencies | notes |
|---|---|---|---|---|---|---|---|---|---|
${rows.join('\n')}

## New Product Checklist

1. Add product entry in \`products.yaml\` with all required fields.
2. Run \`node docs/platform/generate-registry.mjs\` to update this file.
3. Bump \`VERSION\` (MINOR for new product).
4. Append entry to \`PLATFORM_CHANGELOG.md\` with rollback note.
5. Create dedicated DB schema and role per \`DB_TOPOLOGY.md\`.
6. Reserve env prefix and systemd prefix.
7. Register site route(s) in the frontend (or note "not yet built").
8. Add per-product \`PRODUCT_SCOPE.md\` in the product's repo dir
   (see \`whale-edge/PRODUCT_SCOPE.md\` for the canonical template).
9. Add a \`health\` block in \`products.yaml\` so platform health checker
   can monitor freshness (or leave \`null\` for planned products).
`;
}

// ---- main ----------------------------------------------------------------

const yamlSrc = readFileSync(YAML_PATH, 'utf-8');
let spec;
try {
  spec = parseYaml(yamlSrc);
} catch (e) {
  console.error(`YAML parse error in ${YAML_PATH}: ${e.message}`);
  process.exit(2);
}

const errors = validate(spec);
if (errors.length) {
  console.error(`Validation failed for ${YAML_PATH}:`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(2);
}

const version = readFileSync(VERSION_PATH, 'utf-8').trim();
if (spec.platform_version !== version) {
  console.error(`platform_version in products.yaml (${spec.platform_version}) does not match VERSION (${version}).`);
  process.exit(2);
}

const md = generateRegistryMd(spec, version);
writeFileSync(REG_PATH, md);
console.log(`Wrote ${REG_PATH} (platform v${version}, ${spec.products.length} products).`);
