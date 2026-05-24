/**
 * Cross-process dedupe: Jupiter fast-path alerts vs PG minute-bar watchers.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

export type MarketFastAlertKind = 'spike' | 'dips';

export type MarketFastAlertDedupeEntry = {
  ms: number;
  kind: MarketFastAlertKind;
  pct: number;
};

export type MarketFastAlertDedupeFile = {
  updatedAt: string;
  byMint: Record<string, MarketFastAlertDedupeEntry>;
};

export function marketFastAlertDedupePath(): string {
  const p = process.env.MARKET_FAST_ALERT_DEDUPE_PATH?.trim();
  if (p) return path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
  return path.resolve(process.cwd(), 'data/live/market-fast-alert-dedupe.json');
}

export function marketFastAlertDedupeWindowMs(): number {
  const n = Number(process.env.MARKET_FAST_ALERT_DEDUPE_MS ?? 300_000);
  return Number.isFinite(n) && n >= 30_000 ? Math.floor(n) : 300_000;
}

async function readDedupeFile(): Promise<MarketFastAlertDedupeFile> {
  const file = marketFastAlertDedupePath();
  try {
    const raw = await fs.readFile(file, 'utf8');
    const j = JSON.parse(raw) as MarketFastAlertDedupeFile;
    if (j && typeof j === 'object' && j.byMint && typeof j.byMint === 'object') return j;
  } catch {
    /* empty */
  }
  return { updatedAt: new Date(0).toISOString(), byMint: {} };
}

export async function recordMarketFastAlert(
  mint: string,
  kind: MarketFastAlertKind,
  pct: number,
): Promise<void> {
  const key = mint.trim();
  if (key.length < 32) return;
  const file = marketFastAlertDedupePath();
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true });
  const cur = await readDedupeFile();
  cur.updatedAt = new Date().toISOString();
  cur.byMint[key] = { ms: Date.now(), kind, pct };
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(cur), 'utf8');
  await fs.rename(tmp, file);
}

export async function wasMarketFastAlertRecent(
  mint: string,
  kind: MarketFastAlertKind,
  withinMs = marketFastAlertDedupeWindowMs(),
): Promise<boolean> {
  const key = mint.trim();
  if (key.length < 32) return false;
  const cur = await readDedupeFile();
  const hit = cur.byMint[key];
  if (!hit) return false;
  if (hit.kind !== kind) return false;
  return Date.now() - hit.ms < withinMs;
}
