/**
 * Live Oscar — permanent mint denylist (survives whitelist / git churn).
 *
 * - **Seed file** (tracked in repo): curated mints that must never trade again.
 * - **Local file** (gitignored on VPS): auto-appended when a mint is removed from the whitelist file.
 *
 * All SOL→token live/simulate pipeline intents consult the union of both sets.
 */
import fs from 'node:fs';
import path from 'node:path';

import { child } from '../core/logger.js';
import type { LiveOscarConfig } from './config.js';
import { fireMintListChangeTelegramBefore } from './mint-list-change-telegram.js';

const log = child('live-permanent-denylist');

function parseDenylistBody(body: string): Set<string> {
  const out = new Set<string>();
  for (const line of body.split(/\r?\n/)) {
    const cut = line.split('#')[0]?.trim();
    if (!cut) continue;
    out.add(cut);
  }
  return out;
}

export function resolveLivePermanentDenylistLocalPath(raw: string): string {
  const t = raw.trim();
  if (!t) return path.resolve(process.cwd(), 'data/live/live-oscar-permanent-denylist.txt');
  return path.isAbsolute(t) ? t : path.resolve(process.cwd(), t);
}

export function resolveLivePermanentDenylistSeedPath(raw: string): string {
  const t = raw.trim();
  if (!t) return path.resolve(process.cwd(), 'data/live/live-oscar-permanent-denylist.seed.txt');
  return path.isAbsolute(t) ? t : path.resolve(process.cwd(), t);
}

let cachedLocalAbs = '';
let cachedSeedAbs = '';
let cachedLocalMtime = NaN;
let cachedSeedMtime = NaN;
let cachedCombined = new Set<string>();

export function invalidateLivePermanentDenylistCache(): void {
  cachedLocalAbs = '';
  cachedSeedAbs = '';
  cachedLocalMtime = NaN;
  cachedSeedMtime = NaN;
  cachedCombined = new Set();
}

/** @internal Tests */
export function clearLivePermanentDenylistCacheForTests(): void {
  invalidateLivePermanentDenylistCache();
}

function loadFileSet(absPath: string): { set: Set<string>; mtimeMs: number } {
  if (!fs.existsSync(absPath)) return { set: new Set(), mtimeMs: NaN };
  const st = fs.statSync(absPath);
  const body = fs.readFileSync(absPath, 'utf8');
  return { set: parseDenylistBody(body), mtimeMs: st.mtimeMs };
}

export function loadPermanentDenylistCombined(cfg: {
  livePermanentDenylistLocalPath: string;
  livePermanentDenylistSeedPath: string;
}): Set<string> {
  const localAbs = resolveLivePermanentDenylistLocalPath(cfg.livePermanentDenylistLocalPath);
  const seedAbs = resolveLivePermanentDenylistSeedPath(cfg.livePermanentDenylistSeedPath);

  const loc = loadFileSet(localAbs);
  const sed = loadFileSet(seedAbs);

  if (
    cachedLocalAbs === localAbs &&
    cachedSeedAbs === seedAbs &&
    cachedLocalMtime === loc.mtimeMs &&
    cachedSeedMtime === sed.mtimeMs
  ) {
    return cachedCombined;
  }

  cachedCombined = new Set([...sed.set, ...loc.set]);
  cachedLocalAbs = localAbs;
  cachedSeedAbs = seedAbs;
  cachedLocalMtime = loc.mtimeMs;
  cachedSeedMtime = sed.mtimeMs;
  log.info(
    { localPath: localAbs, seedPath: seedAbs, count: cachedCombined.size },
    'live permanent denylist loaded',
  );
  return cachedCombined;
}

export function isMintPermanentlyDeniedLiveOscar(
  cfg: Pick<
    LiveOscarConfig,
    | 'livePermanentDenylistDisabled'
    | 'livePermanentDenylistLocalPath'
    | 'livePermanentDenylistSeedPath'
  >,
  mint: string,
): boolean {
  if (cfg.livePermanentDenylistDisabled) return false;
  const key = mint.trim();
  if (!key) return false;
  return loadPermanentDenylistCombined(cfg).has(key);
}

/**
 * Append mint to the **local** denylist (idempotent). Call after removing mint from whitelist file.
 * Returns true if a new line was written.
 */
export function appendMintToPermanentDenylistLocal(
  cfg: Pick<
    LiveOscarConfig,
    | 'livePermanentDenylistDisabled'
    | 'livePermanentDenylistLocalPath'
    | 'livePermanentDenylistSeedPath'
  >,
  mint: string,
  /** Short reason for the `# auto:` comment (e.g. `negative_trade`, `whitelist_consec_loss`). */
  reason = 'excluded from whitelist',
  opts?: { symbol?: string; skipListChangeTelegram?: boolean },
): boolean {
  if (cfg.livePermanentDenylistDisabled) return false;
  const key = mint.trim();
  if (!key) return false;

  const combined = loadPermanentDenylistCombined(cfg);
  if (combined.has(key)) return false;

  const abs = resolveLivePermanentDenylistLocalPath(cfg.livePermanentDenylistLocalPath);
  if (!opts?.skipListChangeTelegram) {
    fireMintListChangeTelegramBefore({
      kind: 'denylist',
      mint: key,
      symbol: opts?.symbol,
      reason,
      targetPath: abs,
    });
  }
  const dir = path.dirname(abs);
  if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true });

  const stamp = new Date().toISOString();
  const line = `${key}  # auto: ${reason} ${stamp}\n`;
  const prefix = fs.existsSync(abs) && fs.statSync(abs).size > 0 ? '\n' : '';
  fs.appendFileSync(abs, `${prefix}${line}`, 'utf8');
  invalidateLivePermanentDenylistCache();
  log.info({ path: abs, mint: key }, 'live permanent denylist append');
  return true;
}
