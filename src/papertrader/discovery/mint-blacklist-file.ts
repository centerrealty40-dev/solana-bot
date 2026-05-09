/**
 * Manual mint blacklist — one base58 mint per line, `#` line comments.
 * Reloads when file mtime changes (same idea as live mint whitelist).
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Lane, SnapshotCandidateRow } from '../types.js';

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
