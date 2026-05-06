/**
 * Live Oscar — mint allowlist file (one base58 mint per line, `#` comments).
 * Reloads when mtime changes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { sendTagged } from '../core/telegram/sender.js';
import { child } from '../core/logger.js';

const log = child('live-mint-whitelist');

let cachedAbsPath = '';
let cachedMtimeMs = 0;
let cachedSet = new Set<string>();

const lastTelegramByMint = new Map<string, number>();

export function resolveLiveMintWhitelistPath(raw: string): string {
  const t = raw.trim();
  if (!t) return path.resolve(process.cwd(), 'data/live/live-oscar-mint-whitelist.txt');
  return path.isAbsolute(t) ? t : path.resolve(process.cwd(), t);
}

function parseWhitelistBody(body: string): Set<string> {
  const out = new Set<string>();
  for (const line of body.split(/\r?\n/)) {
    const cut = line.split('#')[0]?.trim();
    if (!cut) continue;
    out.add(cut);
  }
  return out;
}

/** Cleared in tests if needed. */
export function clearLiveMintWhitelistCache(): void {
  cachedAbsPath = '';
  cachedMtimeMs = 0;
  cachedSet = new Set();
}

export function loadLiveMintWhitelistSet(absPath: string): Set<string> {
  const st = fs.statSync(absPath);
  if (cachedAbsPath === absPath && cachedMtimeMs === st.mtimeMs) return cachedSet;
  const body = fs.readFileSync(absPath, 'utf8');
  cachedAbsPath = absPath;
  cachedMtimeMs = st.mtimeMs;
  cachedSet = parseWhitelistBody(body);
  log.info({ path: absPath, count: cachedSet.size }, 'live mint whitelist loaded');
  return cachedSet;
}

export function isMintOnLiveWhitelist(relOrAbsPath: string, mint: string): boolean {
  const abs = resolveLiveMintWhitelistPath(relOrAbsPath);
  const set = loadLiveMintWhitelistSet(abs);
  return set.has(mint.trim());
}

export function notifyLiveMintWhitelistSkip(symbol: string, mint: string, cooldownMs: number): void {
  const now = Date.now();
  const key = mint.trim();
  if (!key) return;
  if (cooldownMs > 0) {
    const last = lastTelegramByMint.get(key) ?? 0;
    if (now - last < cooldownMs) return;
    lastTelegramByMint.set(key, now);
  }
  const sym = symbol?.trim() || '?';
  void sendTagged(
    'ALERT',
    'live_whitelist_miss',
    `Кандидат прошёл гейты, но mint не в whitelist — покупка пропущена.\nsymbol: ${sym}\nmint: ${key}`,
  );
}
