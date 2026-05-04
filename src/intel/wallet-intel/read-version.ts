import fs from 'node:fs';
import path from 'node:path';

/** Product semver from docs/strategy/release/VERSION (W6.11 §1.5). */
export function readProductRuleSetVersion(override?: string): string {
  if (override?.trim()) {
    return override.trim();
  }
  const p = path.resolve(process.cwd(), 'docs/strategy/release/VERSION');
  try {
    const v = fs.readFileSync(p, 'utf8').trim();
    return v || '0.0.0';
  } catch {
    return '0.0.0';
  }
}
