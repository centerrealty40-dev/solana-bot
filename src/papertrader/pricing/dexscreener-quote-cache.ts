/**
 * Cross-process DexScreener `/latest/dex/tokens/{mint}` quote cache (TypeScript).
 * Shares `data/dexscreener-quote-cache.json` with scripts-tmp/dexscreener-quote-cache.mjs on Oscar VPS.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { DexScreenerMarketSnapshot } from './discovery-market-quote.js';
import { pickBestSolanaPairForMint } from './dexscreener-pair-pick.js';

const SOL_MINT = 'So11111111111111111111111111111111111111112';

interface CacheEntry {
  miss?: boolean;
  priceUsd?: number | null;
  marketCapUsd?: number | null;
  liquidityUsd?: number | null;
  volume5mUsd?: number | null;
  volume1hUsd?: number | null;
  pairAddress?: string | null;
  baseMint?: string;
  quoteMint?: string;
  fetchedAtMs: number;
}

const inProcess = new Map<string, { at: number; val: DexScreenerMarketSnapshot | null }>();

export function isDexQuoteCacheEnabled(): boolean {
  const flag = String(process.env.DEX_QUOTE_CACHE_ENABLED ?? '1').trim();
  return flag !== '0';
}

export function dexQuoteCacheTtlMs(): number {
  const raw = process.env.DEX_QUOTE_CACHE_TTL_MS?.trim();
  if (raw) {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) return Math.min(60_000, Math.max(12_000, n));
  }
  return 20_000;
}

function quoteCachePath(): string {
  const custom = process.env.DEX_QUOTE_CACHE_PATH?.trim();
  if (custom) return custom;
  return path.join(process.cwd(), 'data', 'dexscreener-quote-cache.json');
}

function gateStatePath(): string {
  const custom = process.env.DEXSCREENER_GLOBAL_GATE_PATH?.trim();
  if (custom) return custom;
  return path.join(process.cwd(), 'data', 'dexscreener-api-gate.json');
}

function cacheLockPath(): string {
  return `${quoteCachePath()}.lock`;
}

function gateLockPath(): string {
  return `${gateStatePath()}.lock`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function positive(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function clearStaleLock(lock: string, maxAgeMs = 30_000): void {
  try {
    const st = fs.statSync(lock);
    if (Date.now() - st.mtimeMs > maxAgeMs) fs.unlinkSync(lock);
  } catch {
    /* no lock */
  }
}

async function withFileLock(lock: string, fn: () => Promise<void>): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    clearStaleLock(lock);
    try {
      const fd = fs.openSync(lock, 'wx');
      try {
        await fn();
        return;
      } finally {
        fs.closeSync(fd);
        try {
          fs.unlinkSync(lock);
        } catch {
          /* ignore */
        }
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code === 'EEXIST') {
        await sleep(5 + Math.floor(Math.random() * 15));
        continue;
      }
      throw e;
    }
  }
  await fn();
}

function readCacheFile(): Record<string, CacheEntry> {
  try {
    const raw = fs.readFileSync(quoteCachePath(), 'utf8');
    const j = JSON.parse(raw) as { entries?: Record<string, CacheEntry> };
    return j?.entries && typeof j.entries === 'object' ? j.entries : {};
  } catch {
    return {};
  }
}

function writeCacheFile(entries: Record<string, CacheEntry>): void {
  const p = quoteCachePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const ttl = dexQuoteCacheTtlMs();
  const cutoff = Date.now() - ttl * 3;
  const pruned: Record<string, CacheEntry> = {};
  for (const [mint, entry] of Object.entries(entries)) {
    if (typeof entry?.fetchedAtMs === 'number' && entry.fetchedAtMs >= cutoff) {
      pruned[mint] = entry;
    }
  }
  const tmp = `${p}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify({ entries: pruned, updatedAt: Date.now() }), 'utf8');
  fs.renameSync(tmp, p);
}

function getCachedDexQuote(
  mint: string,
  nowMs: number,
  ttlMs: number,
): { hit: boolean; entry?: CacheEntry } {
  if (!mint || !isDexQuoteCacheEnabled()) return { hit: false };
  const entry = readCacheFile()[mint];
  if (!entry || typeof entry.fetchedAtMs !== 'number') return { hit: false };
  if (nowMs - entry.fetchedAtMs > ttlMs) return { hit: false };
  return { hit: true, entry };
}

async function putCachedDexQuotes(updates: Record<string, CacheEntry>, nowMs: number): Promise<void> {
  if (!isDexQuoteCacheEnabled() || !updates) return;
  try {
    await withFileLock(cacheLockPath(), async () => {
      const entries = readCacheFile();
      for (const [mint, entry] of Object.entries(updates)) {
        if (!mint || !entry) continue;
        entries[mint] = { ...entry, fetchedAtMs: entry.fetchedAtMs ?? nowMs };
      }
      writeCacheFile(entries);
    });
  } catch {
    /* best-effort */
  }
}

function gateEnabled(): boolean {
  const flag = String(process.env.DEXSCREENER_GLOBAL_RATE_LIMIT ?? '1').trim();
  return flag !== '0';
}

function gateMaxRpm(): number {
  const raw = process.env.DEXSCREENER_GLOBAL_MAX_RPM?.trim();
  if (raw) {
    const n = Number.parseFloat(raw);
    if (Number.isFinite(n) && n > 0) return Math.min(120, n);
  }
  return 42;
}

function readGateState(): { nextAllowedMs: number } {
  try {
    const raw = fs.readFileSync(gateStatePath(), 'utf8');
    const j = JSON.parse(raw) as { nextAllowedMs?: number };
    const next = j?.nextAllowedMs;
    return { nextAllowedMs: typeof next === 'number' && Number.isFinite(next) ? next : 0 };
  } catch {
    return { nextAllowedMs: 0 };
  }
}

function writeGateState(nextAllowedMs: number): void {
  const p = gateStatePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify({ nextAllowedMs, updatedAt: Date.now() }), 'utf8');
  fs.renameSync(tmp, p);
}

async function acquireDexScreenerSlot(): Promise<void> {
  if (!gateEnabled()) return;
  const minGapMs = Math.ceil(60_000 / gateMaxRpm());
  let waitMs = 0;
  await withFileLock(gateLockPath(), async () => {
    const now = Date.now();
    const state = readGateState();
    const grantAt = Math.max(now, state.nextAllowedMs);
    waitMs = Math.max(0, grantAt - now);
    writeGateState(grantAt + minGapMs);
  });
  if (waitMs > 0) await sleep(waitMs);
}

function pickBestSolanaPair(
  pairs: unknown[],
  mint: string,
  preferredDex?: string,
): Record<string, unknown> | null {
  return pickBestSolanaPairForMint(pairs, mint, { preferredDex });
}

function parsePairToCacheEntry(pair: Record<string, unknown> | null, mint: string, nowMs: number): CacheEntry {
  if (!pair) return { miss: true, fetchedAtMs: nowMs };
  const volume = pair.volume as { m5?: number; h1?: number } | undefined;
  const baseToken = pair.baseToken as { address?: string } | undefined;
  const quoteToken = pair.quoteToken as { address?: string } | undefined;
  const liquidity = pair.liquidity as { usd?: number } | undefined;
  return {
    miss: false,
    priceUsd: positive(pair.priceUsd),
    marketCapUsd: positive((pair as { marketCap?: number }).marketCap ?? (pair as { fdv?: number }).fdv),
    liquidityUsd: positive(liquidity?.usd),
    volume5mUsd: positive(volume?.m5),
    volume1hUsd: positive(volume?.h1),
    pairAddress: (pair.pairAddress as string | undefined) ?? null,
    baseMint: baseToken?.address ?? mint,
    quoteMint: quoteToken?.address ?? SOL_MINT,
    fetchedAtMs: nowMs,
  };
}

function cacheEntryToSnapshot(entry: CacheEntry | undefined): DexScreenerMarketSnapshot | null {
  if (!entry || entry.miss) return null;
  return {
    priceUsd: entry.priceUsd ?? null,
    marketCapUsd: entry.marketCapUsd ?? null,
    liquidityUsd: entry.liquidityUsd ?? null,
    volume5mUsd: entry.volume5mUsd ?? null,
    volume1hUsd: entry.volume1hUsd ?? null,
    fetchedAtMs: entry.fetchedAtMs,
  };
}

function toInt(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : null;
}

/** Full DexScreener pair row for PG upsert (pending-leg refresh, enrich). */
export interface DexScreenerPairDetails {
  priceUsd: number | null;
  marketCapUsd: number | null;
  liquidityUsd: number | null;
  volume5mUsd: number | null;
  volume1hUsd: number | null;
  /** Present on live Dex parse; often null when rebuilt from file cache. */
  volume6hUsd: number | null;
  volume24hUsd: number | null;
  pairAddress: string;
  baseMint: string;
  quoteMint: string;
  dexId: string | null;
  buys5m: number | null;
  sells5m: number | null;
  /** Pair creation time from DexScreener. Only present on a live (uncached) parse. */
  pairCreatedAtMs: number | null;
  /** DexScreener `priceChange.m5`, percent. Only present on a live parse. */
  priceChangeM5Pct: number | null;
  priceChangeH1Pct: number | null;
  priceChangeH6Pct: number | null;
  priceChangeH24Pct: number | null;
  fetchedAtMs: number;
}

function signedPct(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function parsePairToDetails(
  pair: Record<string, unknown> | null,
  mint: string,
  nowMs: number,
): DexScreenerPairDetails | null {
  if (!pair) return null;
  const entry = parsePairToCacheEntry(pair, mint, nowMs);
  if (entry.miss || !entry.pairAddress) return null;
  const txns = pair.txns as { m5?: { buys?: number; sells?: number } } | undefined;
  const volume = pair.volume as { m5?: number; h1?: number; h6?: number; h24?: number } | undefined;
  const priceChange = pair.priceChange as {
    m5?: number;
    h1?: number;
    h6?: number;
    h24?: number;
  } | undefined;
  const createdAt = Number((pair as { pairCreatedAt?: number }).pairCreatedAt);
  const changeM5 = Number(priceChange?.m5);
  const vol6 = Number(volume?.h6);
  const vol24 = Number(volume?.h24);
  return {
    priceUsd: entry.priceUsd ?? null,
    marketCapUsd: entry.marketCapUsd ?? null,
    liquidityUsd: entry.liquidityUsd ?? null,
    volume5mUsd: entry.volume5mUsd ?? null,
    volume1hUsd: entry.volume1hUsd ?? null,
    volume6hUsd: Number.isFinite(vol6) && vol6 > 0 ? vol6 : null,
    volume24hUsd: Number.isFinite(vol24) && vol24 > 0 ? vol24 : null,
    pairAddress: entry.pairAddress,
    baseMint: entry.baseMint ?? mint,
    quoteMint: entry.quoteMint ?? SOL_MINT,
    dexId: (pair.dexId as string | undefined) ?? null,
    buys5m: toInt(txns?.m5?.buys),
    sells5m: toInt(txns?.m5?.sells),
    pairCreatedAtMs: Number.isFinite(createdAt) && createdAt > 0 ? Math.trunc(createdAt) : null,
    priceChangeM5Pct: Number.isFinite(changeM5) ? changeM5 : null,
    priceChangeH1Pct: signedPct(priceChange?.h1),
    priceChangeH6Pct: signedPct(priceChange?.h6),
    priceChangeH24Pct: signedPct(priceChange?.h24),
    fetchedAtMs: nowMs,
  };
}

export async function fetchDexScreenerPairDetails(
  mint: string,
  opts?: {
    fetchImpl?: typeof import('undici').fetch;
    cacheTtlMs?: number;
    nowMs?: number;
    preferredDex?: string;
    /** When true, always HTTP-fetch (still respects global gate + updates shared cache). */
    bypassCache?: boolean;
  },
): Promise<DexScreenerPairDetails | null> {
  if (!mint) return null;
  const nowMs = opts?.nowMs ?? Date.now();
  const ttlMs = opts?.cacheTtlMs ?? dexQuoteCacheTtlMs();
  const bypass = opts?.bypassCache === true;
  const doFetch = opts?.fetchImpl ?? (await import('undici')).fetch;

  if (!bypass) {
    const mem = inProcess.get(mint);
    if (mem && nowMs - mem.at < ttlMs) {
      const cached = readCacheFile()[mint];
      if (cached && !cached.miss && cached.pairAddress) {
        return parsePairToDetails(
          {
            priceUsd: cached.priceUsd,
            marketCap: cached.marketCapUsd,
            fdv: cached.marketCapUsd,
            liquidity: { usd: cached.liquidityUsd },
            volume: { m5: cached.volume5mUsd, h1: cached.volume1hUsd },
            pairAddress: cached.pairAddress,
            baseToken: { address: cached.baseMint },
            quoteToken: { address: cached.quoteMint },
          },
          mint,
          cached.fetchedAtMs,
        );
      }
    }
    if (isDexQuoteCacheEnabled()) {
      const cached = getCachedDexQuote(mint, nowMs, ttlMs);
      if (cached.hit && cached.entry && !cached.entry.miss && cached.entry.pairAddress) {
        return parsePairToDetails(
          {
            priceUsd: cached.entry.priceUsd,
            marketCap: cached.entry.marketCapUsd,
            fdv: cached.entry.marketCapUsd,
            liquidity: { usd: cached.entry.liquidityUsd },
            volume: { m5: cached.entry.volume5mUsd, h1: cached.entry.volume1hUsd },
            pairAddress: cached.entry.pairAddress,
            baseToken: { address: cached.entry.baseMint },
            quoteToken: { address: cached.entry.quoteMint },
          },
          mint,
          cached.entry.fetchedAtMs,
        );
      }
    }
  }

  await acquireDexScreenerSlot();

  let details: DexScreenerPairDetails | null = null;
  let cacheEntry: CacheEntry = { miss: true, fetchedAtMs: nowMs };
  try {
    const res = await doFetch(
      `https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(mint)}`,
      { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8_000) },
    );
    if (res.ok) {
      const j = (await res.json()) as { pairs?: unknown[] };
      const best = pickBestSolanaPair(j.pairs ?? [], mint, opts?.preferredDex);
      cacheEntry = parsePairToCacheEntry(best, mint, nowMs);
      details = parsePairToDetails(best, mint, nowMs);
    }
  } catch {
    /* null */
  }

  if (isDexQuoteCacheEnabled()) {
    await putCachedDexQuotes({ [mint]: cacheEntry }, nowMs);
  }
  const snap = cacheEntryToSnapshot(cacheEntry);
  inProcess.set(mint, { at: nowMs, val: snap });
  return details;
}

/** Test-only — clears in-process L1 cache. */
export function __resetDexQuoteCacheForTests(): void {
  inProcess.clear();
}

export async function fetchDexScreenerQuoteViaCache(
  mint: string,
  opts?: {
    fetchImpl?: typeof import('undici').fetch;
    cacheTtlMs?: number;
    nowMs?: number;
  },
): Promise<DexScreenerMarketSnapshot | null> {
  if (!mint) return null;
  const nowMs = opts?.nowMs ?? Date.now();
  const ttlMs = opts?.cacheTtlMs ?? dexQuoteCacheTtlMs();
  const doFetch = opts?.fetchImpl ?? (await import('undici')).fetch;

  const mem = inProcess.get(mint);
  if (mem && nowMs - mem.at < ttlMs) return mem.val;

  if (isDexQuoteCacheEnabled()) {
    const cached = getCachedDexQuote(mint, nowMs, ttlMs);
    if (cached.hit) {
      const snap = cacheEntryToSnapshot(cached.entry);
      inProcess.set(mint, { at: nowMs, val: snap });
      return snap;
    }
  }

  await acquireDexScreenerSlot();

  if (isDexQuoteCacheEnabled()) {
    const cached = getCachedDexQuote(mint, nowMs, ttlMs);
    if (cached.hit) {
      const snap = cacheEntryToSnapshot(cached.entry);
      inProcess.set(mint, { at: nowMs, val: snap });
      return snap;
    }
  }

  let snap: DexScreenerMarketSnapshot | null = null;
  let cacheEntry: CacheEntry = { miss: true, fetchedAtMs: nowMs };
  try {
    const res = await doFetch(
      `https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(mint)}`,
      { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8_000) },
    );
    if (res.ok) {
      const j = (await res.json()) as { pairs?: unknown[] };
      const best = pickBestSolanaPair(j.pairs ?? [], mint);
      cacheEntry = parsePairToCacheEntry(best, mint, nowMs);
      snap = cacheEntryToSnapshot(cacheEntry);
    }
  } catch {
    /* null snap */
  }

  if (isDexQuoteCacheEnabled()) {
    await putCachedDexQuotes({ [mint]: cacheEntry }, nowMs);
  }
  inProcess.set(mint, { at: nowMs, val: snap });
  return snap;
}
