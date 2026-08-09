/**
 * Persistent set of mints that watched leader wallets have bought at least once.
 * Live entry may require membership — not copy-trading, just "leaders touched this mint".
 */
import fs from 'node:fs';
import path from 'node:path';

type Store = {
  updatedAtMs: number;
  mints: Record<string, number>; // mint → firstSeenBuyMs
};

const DEFAULT_PATH = path.join('data', 'volgreen', 'leader-mints.json');
const MAX_MINTS = 50_000;

let filePath = DEFAULT_PATH;
let byMint = new Map<string, number>();
let dirty = false;

export function leaderMintAllowlistPath(): string {
  return filePath;
}

export function configureLeaderMintAllowlist(p: string): void {
  if (p?.trim()) filePath = p.trim();
}

export function loadLeaderMintAllowlist(p?: string): number {
  if (p?.trim()) filePath = p.trim();
  try {
    if (!fs.existsSync(filePath)) {
      byMint = new Map();
      return 0;
    }
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Store;
    const next = new Map<string, number>();
    for (const [mint, ts] of Object.entries(raw.mints ?? {})) {
      if (mint.length >= 32 && typeof ts === 'number') next.set(mint, ts);
    }
    byMint = next;
    dirty = false;
    return byMint.size;
  } catch {
    byMint = new Map();
    return 0;
  }
}

export function saveLeaderMintAllowlist(): void {
  if (!dirty) return;
  try {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    // Cap size — drop oldest firstSeen.
    if (byMint.size > MAX_MINTS) {
      const ordered = [...byMint.entries()].sort((a, b) => a[1] - b[1]);
      const drop = ordered.slice(0, byMint.size - MAX_MINTS);
      for (const [m] of drop) byMint.delete(m);
    }
    const mints: Record<string, number> = {};
    for (const [m, ts] of byMint) mints[m] = ts;
    const store: Store = { updatedAtMs: Date.now(), mints };
    fs.writeFileSync(filePath, JSON.stringify(store));
    dirty = false;
  } catch (err) {
    console.warn('[vol-green] save leader-mint allowlist failed', err);
  }
}

/** Record that a leader bought this mint (idempotent). */
export function markLeaderBought(mint: string, nowMs: number = Date.now()): boolean {
  if (!mint || mint.length < 32) return false;
  if (byMint.has(mint)) return false;
  byMint.set(mint, nowMs);
  dirty = true;
  return true;
}

export function hasLeaderBought(mint: string): boolean {
  return Boolean(mint && byMint.has(mint));
}

export function leaderBoughtCount(): number {
  return byMint.size;
}

export function requireLeaderBoughtEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = (
    env.MILD_DIP_REQUIRE_LEADER_BOUGHT ??
    env.VOL_GREEN_REQUIRE_LEADER_BOUGHT ??
    env.MILD_DIP_REQUIRE_LEADER_HIGHLIGHT ??
    env.VOL_GREEN_REQUIRE_LEADER_HIGHLIGHT ??
    '1'
  )
    .trim()
    .toLowerCase();
  // Explicit off
  if (raw === '0' || raw === 'false' || raw === 'no' || raw === 'off') return false;
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on' || raw === '';
}

/** Test helper. */
export function __resetLeaderMintAllowlistForTests(): void {
  byMint = new Map();
  dirty = false;
  filePath = DEFAULT_PATH;
}
