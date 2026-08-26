/**
 * Extra mild-dip discovery sources (opt-in via MILD_DIP_DISCOVER_SOURCES).
 *
 * - leaders: sidecar file written by leader-observer (no Dex fan-out here)
 * - pg_volume: fresh PumpSwap snapshot top-vol (soft-fail; no shared drizzle import)
 * - gecko: GeckoTerminal trending pools (free; cached; capped)
 *
 * These must never throw into the scan loop. Caps keep Dex enrich budget intact.
 */
import fs from 'node:fs';
import path from 'node:path';
import postgres from 'postgres';
import { fetch } from 'undici';
import { mildDipPairAgeRegistry } from './pair-age-registry.js';

export type LeaderSeedHit = {
  mint: string;
  lastSeenAtMs: number;
  leader?: string;
  signature?: string;
  /** 1.11.760+ observer fill (quote-leg or Dex). */
  fillPriceUsd?: number;
  sizeUsd?: number;
  blockTime?: number;
  /** True when leader added to an existing bag. */
  isAdd?: boolean;
  class?: string;
  /**
   * 1.11.775 — Dex snapshot at observer time. Bot buys from this on leader
   * wake instead of re-fetching DexScreener (miss EjD5…: formula ok, silent null).
   */
  priceUsd?: number;
  pc5m?: number;
  pc1h?: number;
  vol5m?: number;
  liq?: number;
  mcap?: number;
  ageHours?: number;
  turnover5mLiq?: number;
  dexId?: string;
};

export type LeaderSeedFile = {
  updatedAtMs?: number;
  hits?: LeaderSeedHit[];
};

let pgCache: { fetchedAtMs: number; mints: string[] } | null = null;
let geckoCache: { fetchedAtMs: number; mints: string[] } | null = null;
let pgWarned = false;

/** Test helper. */
export function resetDiscoverExtraCachesForTests(): void {
  pgCache = null;
  geckoCache = null;
  pgWarned = false;
}

export function parseLeaderSeedMints(
  payload: LeaderSeedFile | null | undefined,
  nowMs: number,
  opts?: { maxAgeMs?: number; max?: number },
): string[] {
  const maxAgeMs = Math.max(0, opts?.maxAgeMs ?? 2 * 3_600_000);
  const max = Math.max(0, Math.floor(opts?.max ?? 40));
  const hits = Array.isArray(payload?.hits) ? payload!.hits! : [];
  const rows = hits
    .filter(
      (h) =>
        h &&
        typeof h.mint === 'string' &&
        h.mint.length >= 32 &&
        typeof h.lastSeenAtMs === 'number' &&
        Number.isFinite(h.lastSeenAtMs) &&
        nowMs - h.lastSeenAtMs <= maxAgeMs,
    )
    .sort((a, b) => b.lastSeenAtMs - a.lastSeenAtMs);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const h of rows) {
    if (seen.has(h.mint)) continue;
    seen.add(h.mint);
    out.push(h.mint);
    if (out.length >= max) break;
  }
  return out;
}

export function readLeaderSeedMints(
  filePath: string | undefined,
  nowMs: number,
  opts?: { maxAgeMs?: number; max?: number },
): string[] {
  if (!filePath) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as LeaderSeedFile;
    return parseLeaderSeedMints(raw, nowMs, opts);
  } catch {
    return [];
  }
}

/** Rich seed hits for leader-align defer/scale-in (preserves fill/isAdd). */
export function parseLeaderSeedHits(
  payload: LeaderSeedFile | null | undefined,
  nowMs: number,
  opts?: { maxAgeMs?: number; max?: number; dedupeBy?: 'mint' | 'mint_leader' },
): LeaderSeedHit[] {
  const maxAgeMs = Math.max(0, opts?.maxAgeMs ?? 2 * 3_600_000);
  const max = Math.max(0, Math.floor(opts?.max ?? 40));
  const dedupeBy = opts?.dedupeBy ?? 'mint';
  const hits = Array.isArray(payload?.hits) ? payload!.hits! : [];
  const rows = hits
    .filter(
      (h) =>
        h &&
        typeof h.mint === 'string' &&
        h.mint.length >= 32 &&
        typeof h.lastSeenAtMs === 'number' &&
        Number.isFinite(h.lastSeenAtMs) &&
        nowMs - h.lastSeenAtMs <= maxAgeMs,
    )
    .sort((a, b) => b.lastSeenAtMs - a.lastSeenAtMs);
  const out: LeaderSeedHit[] = [];
  const seen = new Set<string>();
  for (const h of rows) {
    const key = dedupeBy === 'mint_leader' ? `${h.mint}:${h.leader ?? ''}` : h.mint;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...h });
    if (out.length >= max) break;
  }
  return out;
}

export function readLeaderSeedHits(
  filePath: string | undefined,
  nowMs: number,
  opts?: { maxAgeMs?: number; max?: number; dedupeBy?: 'mint' | 'mint_leader' },
): LeaderSeedHit[] {
  if (!filePath) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as LeaderSeedFile;
    return parseLeaderSeedHits(raw, nowMs, opts);
  } catch {
    return [];
  }
}

export function leaderSeedHitByMint(
  hits: LeaderSeedHit[],
  mint: string,
): LeaderSeedHit | null {
  for (const h of hits) {
    if (h.mint === mint) return h;
  }
  return null;
}

/**
 * True when a leader buy on this mint is fresh enough to count as the same dip
 * (±leaderCoBuyAlignMaxMs co-buy window from the 48h solo-vs-co analysis).
 */
export function isLeaderFreshCoBuy(args: {
  nowMs: number;
  maxAgeMs: number;
  trigger: 'stream' | 'leader' | 'scan';
  seedHit?: LeaderSeedHit | null;
  leaderSeenAtMs?: number | null;
}): boolean {
  if (args.trigger === 'leader') return true;
  if (!(args.maxAgeMs > 0)) return false;
  const max = args.maxAgeMs;
  if (args.seedHit && args.nowMs - args.seedHit.lastSeenAtMs <= max) return true;
  if (
    args.leaderSeenAtMs != null &&
    args.nowMs - args.leaderSeenAtMs <= max
  ) {
    return true;
  }
  return false;
}

/**
 * Merge one leader buy into the sidecar seed file (atomic). Used by observer;
 * also exported for tests / TS callers.
 */
export function upsertLeaderSeedMint(
  filePath: string,
  hit: LeaderSeedHit,
  opts?: { max?: number; maxAgeMs?: number; nowMs?: number },
): void {
  const nowMs = opts?.nowMs ?? Date.now();
  if (hit.ageHours != null) {
    mildDipPairAgeRegistry.notePairAgeHours(hit.mint, hit.ageHours, hit.lastSeenAtMs);
  }
  const max = Math.max(1, Math.floor(opts?.max ?? 40));
  const maxAgeMs = Math.max(0, opts?.maxAgeMs ?? 2 * 3_600_000);
  let hits: LeaderSeedHit[] = [];
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as LeaderSeedFile;
    if (Array.isArray(raw.hits)) hits = raw.hits;
  } catch {
    hits = [];
  }
  const byMint = new Map<string, LeaderSeedHit>();
  for (const h of hits) {
    if (!h?.mint || h.mint.length < 32 || typeof h.lastSeenAtMs !== 'number') continue;
    if (nowMs - h.lastSeenAtMs > maxAgeMs) continue;
    byMint.set(h.mint, h);
  }
  const prev = byMint.get(hit.mint);
  const mergedHit: LeaderSeedHit = {
    mint: hit.mint,
    lastSeenAtMs: Math.max(prev?.lastSeenAtMs ?? 0, hit.lastSeenAtMs),
    leader: hit.leader ?? prev?.leader,
    signature: hit.signature ?? prev?.signature,
  };
  if (hit.fillPriceUsd != null && hit.fillPriceUsd > 0) {
    mergedHit.fillPriceUsd = hit.fillPriceUsd;
  } else if (prev?.fillPriceUsd != null && prev.fillPriceUsd > 0) {
    mergedHit.fillPriceUsd = prev.fillPriceUsd;
  }
  if (hit.sizeUsd != null && hit.sizeUsd > 0) mergedHit.sizeUsd = hit.sizeUsd;
  else if (prev?.sizeUsd != null && prev.sizeUsd > 0) mergedHit.sizeUsd = prev.sizeUsd;
  if (hit.blockTime != null) mergedHit.blockTime = hit.blockTime;
  else if (prev?.blockTime != null) mergedHit.blockTime = prev.blockTime;
  if (hit.isAdd != null) mergedHit.isAdd = hit.isAdd;
  else if (prev?.isAdd != null) mergedHit.isAdd = prev.isAdd;
  if (hit.class) mergedHit.class = hit.class;
  else if (prev?.class) mergedHit.class = prev.class;
  // Prefer fresher observer Dex snapshot on the new hit.
  for (const k of [
    'priceUsd',
    'pc5m',
    'pc1h',
    'vol5m',
    'liq',
    'mcap',
    'ageHours',
    'turnover5mLiq',
    'dexId',
  ] as const) {
    const v = hit[k] ?? prev?.[k];
    if (v != null) (mergedHit as LeaderSeedHit)[k] = v as never;
  }
  byMint.set(hit.mint, mergedHit);
  const merged = [...byMint.values()]
    .sort((a, b) => b.lastSeenAtMs - a.lastSeenAtMs)
    .slice(0, max);
  const dir = path.dirname(filePath);
  if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.tmp.${process.pid}.${nowMs}`;
  fs.writeFileSync(
    tmp,
    `${JSON.stringify({ updatedAtMs: nowMs, hits: merged })}\n`,
    'utf8',
  );
  fs.renameSync(tmp, filePath);
}

function databaseUrlFromEnv(): string {
  return (
    process.env.MILD_DIP_DATABASE_URL?.trim() ||
    process.env.SA_PG_DSN?.trim() ||
    process.env.DATABASE_URL?.trim() ||
    ''
  );
}

/**
 * Top PumpSwap base mints by latest vol5m, freshness-gated.
 * Soft-fails to [] when DSN missing / query errors / stale collectors.
 */
export async function discoverPgVolumeMints(opts?: {
  nowMs?: number;
  max?: number;
  cacheMs?: number;
  lookbackMin?: number;
  minVolume5mUsd?: number;
  minLiquidityUsd?: number;
  minMarketCapUsd?: number;
}): Promise<string[]> {
  const nowMs = opts?.nowMs ?? Date.now();
  const max = Math.max(0, Math.min(80, Math.floor(opts?.max ?? 30)));
  const cacheMs = Math.max(15_000, Math.floor(opts?.cacheMs ?? 60_000));
  if (max <= 0) return [];
  if (pgCache && nowMs - pgCache.fetchedAtMs < cacheMs) return pgCache.mints;

  const dsn = databaseUrlFromEnv();
  if (!dsn) {
    pgCache = { fetchedAtMs: nowMs, mints: [] };
    return [];
  }

  const lookbackMin = Math.max(2, Math.min(60, Math.floor(opts?.lookbackMin ?? 10)));
  const minVol = Math.max(0, opts?.minVolume5mUsd ?? 500);
  const minLiq = Math.max(0, opts?.minLiquidityUsd ?? 5_000);
  const minMcap = Math.max(0, opts?.minMarketCapUsd ?? 10_000);

  let sql: { end: (opts?: { timeout?: number }) => Promise<void> } | null = null;
  try {
    const client = postgres(dsn, {
      max: 1,
      idle_timeout: 5,
      connect_timeout: 8,
      prepare: false,
    });
    sql = client;
    const rows = (await client.unsafe(
      `
      WITH latest AS (
        SELECT DISTINCT ON (base_mint)
          base_mint::text AS mint,
          COALESCE(volume_5m, 0)::float AS volume_5m,
          COALESCE(liquidity_usd, 0)::float AS liquidity_usd,
          COALESCE(market_cap_usd, fdv_usd, 0)::float AS market_cap_usd
        FROM pumpswap_pair_snapshots
        WHERE ts >= now() - interval '${lookbackMin} minutes'
          AND COALESCE(price_usd, 0) > 0
          AND COALESCE(volume_5m, 0) >= ${minVol}
          AND COALESCE(liquidity_usd, 0) >= ${minLiq}
          AND COALESCE(market_cap_usd, fdv_usd, 0) >= ${minMcap}
        ORDER BY base_mint, ts DESC
      )
      SELECT mint
      FROM latest
      ORDER BY volume_5m DESC
      LIMIT ${max}
      `,
    )) as unknown as Array<{ mint?: string }>;

    const mints = (Array.isArray(rows) ? rows : [])
      .map((r) => String(r?.mint ?? '').trim())
      .filter((m) => m.length >= 32);
    pgCache = { fetchedAtMs: nowMs, mints };
    return mints;
  } catch (err) {
    if (!pgWarned) {
      pgWarned = true;
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[mild-dip] pg_volume discover unavailable: ${msg.slice(0, 160)}`);
    }
    pgCache = { fetchedAtMs: nowMs, mints: [] };
    return [];
  } finally {
    if (sql) {
      try {
        await sql.end({ timeout: 1 });
      } catch {
        /* ignore */
      }
    }
  }
}

function extractGeckoBaseMint(pool: Record<string, unknown>): string | null {
  const rel = pool.relationships as { base_token?: { data?: { id?: string } } } | undefined;
  const id = rel?.base_token?.data?.id;
  if (!id || typeof id !== 'string') return null;
  const parts = id.split('_');
  const mint = parts.length > 1 ? parts[parts.length - 1]! : id;
  return mint.length >= 32 ? mint : null;
}

/** GeckoTerminal Solana trending pools → base mints. Cached; soft-fail. */
export async function discoverGeckoTrendingMints(opts?: {
  nowMs?: number;
  max?: number;
  cacheMs?: number;
  pages?: number;
}): Promise<string[]> {
  const nowMs = opts?.nowMs ?? Date.now();
  const max = Math.max(0, Math.min(80, Math.floor(opts?.max ?? 25)));
  const cacheMs = Math.max(30_000, Math.floor(opts?.cacheMs ?? 120_000));
  const pages = Math.max(1, Math.min(2, Math.floor(opts?.pages ?? 1)));
  if (max <= 0) return [];
  if (geckoCache && nowMs - geckoCache.fetchedAtMs < cacheMs) return geckoCache.mints;

  const out: string[] = [];
  const seen = new Set<string>();
  try {
    for (let page = 1; page <= pages; page += 1) {
      const url = `https://api.geckoterminal.com/api/v2/networks/solana/trending_pools?page=${page}`;
      const res = await fetch(url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) break;
      const json = (await res.json()) as { data?: unknown[] };
      const pools = Array.isArray(json.data) ? json.data : [];
      for (const poolData of pools) {
        const pool = poolData as Record<string, unknown>;
        const mint = extractGeckoBaseMint(pool);
        if (!mint || seen.has(mint)) continue;
        seen.add(mint);
        out.push(mint);
        if (out.length >= max) break;
      }
      if (out.length >= max) break;
    }
  } catch {
    /* soft-fail */
  }

  geckoCache = { fetchedAtMs: nowMs, mints: out.slice(0, max) };
  return geckoCache.mints;
}
