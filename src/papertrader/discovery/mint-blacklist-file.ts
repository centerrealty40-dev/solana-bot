/**
 * Manual mint blacklist — one base58 mint per line, `#` line comments.
 * Reloads when file mtime changes (same idea as live mint whitelist).
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Lane, SnapshotCandidateRow } from '../types.js';
import { fireMintListChangeTelegramBefore } from '../../live/mint-list-change-telegram.js';

let cachedAbsPath = '';
let cachedMtimeMs = 0;
let cachedSet = new Set<string>();

export function resolveMintBlacklistPath(raw: string): string {
  const t = raw.trim();
  if (!t) return path.resolve(process.cwd(), 'data/live/live-oscar-mint-blacklist.txt');
  return path.isAbsolute(t) ? t : path.resolve(process.cwd(), t);
}

function parseBody(body: string): Set<string> {
  const out = new Set<string>();
  for (const line of body.split(/\r?\n/)) {
    const cut = line.split('#')[0]?.trim();
    if (cut) out.add(cut);
  }
  return out;
}

/** Cleared in tests if needed. */
export function clearMintBlacklistCacheForTests(): void {
  cachedAbsPath = '';
  cachedMtimeMs = 0;
  cachedSet = new Set();
}

export function loadMintBlacklistSet(absPath: string): Set<string> {
  const st = fs.statSync(absPath);
  if (cachedAbsPath === absPath && cachedMtimeMs === st.mtimeMs) return cachedSet;
  const body = fs.readFileSync(absPath, 'utf8');
  cachedAbsPath = absPath;
  cachedMtimeMs = st.mtimeMs;
  cachedSet = parseBody(body);
  return cachedSet;
}

export function isMintBlacklisted(relOrAbsPath: string, mint: string): boolean {
  const abs = resolveMintBlacklistPath(relOrAbsPath);
  const set = loadMintBlacklistSet(abs);
  return set.has(mint.trim());
}

export function filterSnapshotTaggedByMintBlacklist(
  cfg: { mintBlacklistEnabled: boolean; mintBlacklistPath: string },
  snapshotTagged: Array<{ row: SnapshotCandidateRow; lane: Lane }>,
): Array<{ row: SnapshotCandidateRow; lane: Lane }> {
  if (!cfg.mintBlacklistEnabled || !cfg.mintBlacklistPath?.trim()) return snapshotTagged;
  const p = cfg.mintBlacklistPath.trim();
  return snapshotTagged.filter((x) => !isMintBlacklisted(p, x.row.mint));
}

/** Append mint to manual blacklist (idempotent). Telegram before write when live-oscar bot token configured. */
export function appendMintToBlacklistFile(
  relOrAbsPath: string,
  mint: string,
  reason = 'manual',
  opts?: { symbol?: string; skipListChangeTelegram?: boolean },
): boolean {
  const key = mint.trim();
  if (!key) return false;
  const abs = resolveMintBlacklistPath(relOrAbsPath);
  if (isMintBlacklisted(relOrAbsPath, key)) return false;

  if (!opts?.skipListChangeTelegram) {
    fireMintListChangeTelegramBefore({
      kind: 'blacklist',
      mint: key,
      symbol: opts?.symbol,
      reason,
      targetPath: abs,
    });
  }

  const dir = path.dirname(abs);
  if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true });
  const prefix = fs.existsSync(abs) && fs.statSync(abs).size > 0 ? '\n' : '';
  const stamp = new Date().toISOString().slice(0, 10);
  fs.appendFileSync(abs, `${prefix}${key}  # auto: ${reason} ${stamp}\n`, 'utf8');
  if (cachedAbsPath === abs) cachedMtimeMs = 0;
  return true;
}
