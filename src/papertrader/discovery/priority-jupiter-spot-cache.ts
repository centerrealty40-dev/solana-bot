/**
 * Shared Jupiter spot cache: fast watcher writes, Live Oscar discovery reads.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

import { scaleMcapWithPrice } from '../pricing/mcap-snapshot.js';
import type { SnapshotCandidateRow } from '../types.js';

export type PriorityJupiterSpotEntry = {
  mint: string;
  priceUsd: number;
  mcapUsd: number | null;
  tsMs: number;
  source: 'jupiter_v3' | 'jupiter_quote';
};

export type PriorityJupiterSpotCache = {
  updatedAt: string;
  entries: Record<string, PriorityJupiterSpotEntry>;
};

export type PriorityJupiterSpotMintHeartbeat = {
  updatedAt: string;
  mints: string[];
};

export function priorityJupiterSpotCachePath(): string {
  const p = process.env.PRIORITY_JUPITER_SPOT_CACHE_PATH?.trim();
  if (p) return path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
  return path.resolve(process.cwd(), 'data/live/priority-jupiter-spot-cache.json');
}

export function priorityJupiterSpotMintHeartbeatPath(): string {
  const p = process.env.PRIORITY_JUPITER_SPOT_MINTS_PATH?.trim();
  if (p) return path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
  return path.resolve(process.cwd(), 'data/live/priority-jupiter-spot-mints.json');
}

export function priorityJupiterSpotCacheMaxAgeMs(): number {
  const n = Number(process.env.PRIORITY_JUPITER_SPOT_CACHE_MAX_AGE_MS ?? 25_000);
  return Number.isFinite(n) && n >= 5000 ? Math.floor(n) : 25_000;
}

export async function readPriorityJupiterSpotCache(): Promise<PriorityJupiterSpotCache> {
  const file = priorityJupiterSpotCachePath();
  try {
    const raw = await fs.readFile(file, 'utf8');
    const j = JSON.parse(raw) as PriorityJupiterSpotCache;
    if (j && typeof j === 'object' && j.entries && typeof j.entries === 'object') return j;
  } catch {
    /* empty */
  }
  return { updatedAt: new Date(0).toISOString(), entries: {} };
}

export async function writePriorityJupiterSpotCache(cache: PriorityJupiterSpotCache): Promise<void> {
  const file = priorityJupiterSpotCachePath();
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(cache), 'utf8');
  await fs.rename(tmp, file);
}

export async function writePriorityJupiterSpotMintHeartbeat(mints: Iterable<string>): Promise<void> {
  const file = priorityJupiterSpotMintHeartbeatPath();
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true });
  const uniq = [...new Set([...mints].map((m) => String(m ?? '').trim()).filter((m) => m.length >= 32))];
  const payload: PriorityJupiterSpotMintHeartbeat = {
    updatedAt: new Date().toISOString(),
    mints: uniq,
  };
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(payload), 'utf8');
  await fs.rename(tmp, file);
}

export async function readPriorityJupiterSpotMintHeartbeat(): Promise<string[]> {
  const file = priorityJupiterSpotMintHeartbeatPath();
  try {
    const raw = await fs.readFile(file, 'utf8');
    const j = JSON.parse(raw) as PriorityJupiterSpotMintHeartbeat;
    if (!j?.mints || !Array.isArray(j.mints)) return [];
    return j.mints.map((m) => String(m).trim()).filter((m) => m.length >= 32);
  } catch {
    return [];
  }
}

/** Apply fresher Jupiter spot to in-memory discovery rows (no PG write). */
export function applyPriorityJupiterSpotEntryToRow(
  row: SnapshotCandidateRow,
  entry: PriorityJupiterSpotEntry,
  maxAgeMs = priorityJupiterSpotCacheMaxAgeMs(),
): boolean {
  if (Date.now() - entry.tsMs > maxAgeMs) return false;
  const oldPx = Number(row.price_usd);
  const newPx = entry.priceUsd;
  if (!(newPx > 0)) return false;
  if (oldPx > 0 && Math.abs(newPx - oldPx) / oldPx < 0.0001) return false;

  row.price_usd = newPx;
  const scaled =
    oldPx > 0 && row.market_cap_usd != null && row.market_cap_usd > 0
      ? scaleMcapWithPrice(oldPx, newPx, row.market_cap_usd)
      : entry.mcapUsd;
  if (scaled != null && scaled > 0) row.market_cap_usd = scaled;
  return true;
}
