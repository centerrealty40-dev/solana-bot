/**
 * Cross-process DexScreener `/latest/dex/tokens/{mint}` quote cache (TypeScript).
 * Shares `data/dexscreener-quote-cache.json` with scripts-tmp/dexscreener-quote-cache.mjs on Oscar VPS.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fetch } from 'undici';
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
  /** DexScreener dexId (pumpswap / meteora / …). Used to honor allowedDexIds on cache hit. */
  dexId?: string | null;
  fetchedAtMs: number;
}

const inProcess = new Map<
  string,
  { at: number; val: DexScreenerMarketSnapshot | null; details?: DexScreenerPairDetails }
>();

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

/** Cap runaway gate queues (overlapping wakes can push hours ahead). */
function gateMaxBacklogMs(): number {
  const raw = process.env.DEXSCREENER_GLOBAL_MAX_BACKLOG_MS?.trim();
  if (raw) {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n >= 0) return Math.min(300_000, n);
  }
  return 30_000;
}

function gate429BackoffBaseMs(): number {
  const raw = process.env.DEXSCREENER_429_BACKOFF_BASE_MS?.trim();
  if (raw) {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 5_000;
}

function gate429BackoffMaxMs(): number {
  const raw = process.env.DEXSCREENER_429_BACKOFF_MAX_MS?.trim();
  if (raw) {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n >= 1_000) return Math.min(120_000, n);
  }
  return 120_000;
}

function retryAfterMs(value: string | null | undefined, nowMs: number): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1_000;
  const dateMs = Date.parse(trimmed);
  if (!Number.isFinite(dateMs) || dateMs <= nowMs) return null;
  return dateMs - nowMs;
}

export function nextDexScreenerCooldownAt(args: {
  nowMs: number;
  retryAfter?: string | null;
  consecutive429: number;
}): { cooldownUntilMs: number; consecutive429: number; cooldownMs: number } {
  const consecutive429 = Math.max(1, Math.trunc(args.consecutive429) + 1);
  const maxMs = Math.max(1_000, gate429BackoffMaxMs());
  const baseMs = Math.min(maxMs, Math.max(1_000, gate429BackoffBaseMs()));
  const retryMs = retryAfterMs(args.retryAfter, args.nowMs);
  const exponentialMs = baseMs * 2 ** Math.min(consecutive429 - 1, 30);
  const cooldownMs = Math.min(maxMs, Math.max(1_000, retryMs ?? exponentialMs));
  return {
    cooldownUntilMs: args.nowMs + cooldownMs,
    consecutive429,
    cooldownMs,
  };
}

/**
 * 1.11.796 — compute next grant; clamp stale/runaway `nextAllowedMs` so buy-path
 * Dex slots cannot sleep for tens of minutes behind a flooded gate file.
 */
export function nextDexScreenerGrantAt(args: {
  nowMs: number;
  nextAllowedMs: number;
  minGapMs: number;
  maxBacklogMs: number;
}): { grantAt: number; waitMs: number; nextAllowedMs: number; clamped: boolean } {
  const now = args.nowMs;
  const maxBacklog = Math.max(0, args.maxBacklogMs);
  const minGap = Math.max(1, args.minGapMs);
  let base = args.nextAllowedMs;
  let clamped = false;
  if (base - now > maxBacklog) {
    base = now;
    clamped = true;
  }
  const grantAt = Math.max(now, base);
  return {
    grantAt,
    waitMs: Math.max(0, grantAt - now),
    nextAllowedMs: grantAt + minGap,
    clamped,
  };
}

type DexScreenerGateState = {
  nextAllowedMs: number;
  cooldownUntilMs: number;
  consecutive429: number;
  total429: number;
  last429AtMs: number;
};

function readGateState(): DexScreenerGateState {
  try {
    const raw = fs.readFileSync(gateStatePath(), 'utf8');
    const j = JSON.parse(raw) as Partial<DexScreenerGateState>;
    return {
      nextAllowedMs: typeof j?.nextAllowedMs === 'number' && Number.isFinite(j.nextAllowedMs) ? j.nextAllowedMs : 0,
      cooldownUntilMs:
        typeof j?.cooldownUntilMs === 'number' && Number.isFinite(j.cooldownUntilMs) ? j.cooldownUntilMs : 0,
      consecutive429:
        typeof j?.consecutive429 === 'number' && Number.isFinite(j.consecutive429)
          ? Math.max(0, Math.trunc(j.consecutive429))
          : 0,
      total429:
        typeof j?.total429 === 'number' && Number.isFinite(j.total429) ? Math.max(0, Math.trunc(j.total429)) : 0,
      last429AtMs:
        typeof j?.last429AtMs === 'number' && Number.isFinite(j.last429AtMs) ? j.last429AtMs : 0,
    };
  } catch {
    return { nextAllowedMs: 0, cooldownUntilMs: 0, consecutive429: 0, total429: 0, last429AtMs: 0 };
  }
}

function writeGateState(state: DexScreenerGateState): void {
  const p = gateStatePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify({ ...state, updatedAt: Date.now() }), 'utf8');
  fs.renameSync(tmp, p);
}

async function acquireDexScreenerSlot(): Promise<void> {
  if (!gateEnabled()) return;
  const minGapMs = Math.ceil(60_000 / gateMaxRpm());
  let waitMs = 0;
  await withFileLock(gateLockPath(), async () => {
    const now = Date.now();
    const state = readGateState();
    const maxCooldownMs = Math.max(1_000, gate429BackoffMaxMs());
    const cooldownUntilMs =
      state.cooldownUntilMs > now + maxCooldownMs ? now + maxCooldownMs : Math.max(now, state.cooldownUntilMs);
    const grant = nextDexScreenerGrantAt({
      nowMs: now,
      nextAllowedMs: state.nextAllowedMs,
      minGapMs,
      maxBacklogMs: gateMaxBacklogMs(),
    });
    const grantAt = Math.max(grant.grantAt, cooldownUntilMs);
    waitMs = Math.max(0, grantAt - now);
    writeGateState({
      ...state,
      nextAllowedMs: grantAt + minGapMs,
      cooldownUntilMs,
    });
  });
  if (waitMs > 0) await sleep(waitMs);
}

async function dexScreenerCooldownActive(): Promise<boolean> {
  if (!gateEnabled()) return false;
  let active = false;
  await withFileLock(gateLockPath(), async () => {
    const now = Date.now();
    const state = readGateState();
    const maxCooldownMs = Math.max(1_000, gate429BackoffMaxMs());
    const cooldownUntilMs =
      state.cooldownUntilMs > now + maxCooldownMs ? now + maxCooldownMs : Math.max(now, state.cooldownUntilMs);
    active = cooldownUntilMs > now;
  });
  return active;
}

async function recordDexScreenerResponse(res: {
  status: number;
  ok: boolean;
  headers?: { get(name: string): string | null };
}): Promise<boolean> {
  const nowMs = Date.now();
  const is429 = res.status === 429;
  if (!is429 && !res.ok) return false;
  const retryAfter = res.headers?.get('retry-after');
  await withFileLock(gateLockPath(), async () => {
    const state = readGateState();
    if (is429) {
      const next = nextDexScreenerCooldownAt({
        nowMs,
        retryAfter,
        consecutive429: state.consecutive429,
      });
      writeGateState({
        ...state,
        cooldownUntilMs: Math.max(state.cooldownUntilMs, next.cooldownUntilMs),
        consecutive429: next.consecutive429,
        total429: state.total429 + 1,
        last429AtMs: nowMs,
      });
    } else {
      writeGateState({ ...state, cooldownUntilMs: 0, consecutive429: 0 });
    }
  });
  return is429;
}

function pickBestSolanaPair(
  pairs: unknown[],
  mint: string,
  preferredDex?: string,
  allowedDexIds?: string[],
): Record<string, unknown> | null {
  return pickBestSolanaPairForMint(pairs, mint, { preferredDex, allowedDexIds });
}

function dexIdAllowed(dexId: string | null | undefined, allowedDexIds?: string[]): boolean {
  const allowed = (allowedDexIds ?? []).map((d) => d.trim().toLowerCase()).filter(Boolean);
  if (allowed.length === 0) return true;
  const dex = String(dexId ?? '').trim().toLowerCase();
  return Boolean(dex) && allowed.includes(dex);
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
    dexId: (pair.dexId as string | undefined) ?? null,
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

function cacheEntryToDetails(
  entry: CacheEntry,
  mint: string,
): DexScreenerPairDetails | null {
  if (entry.miss || !entry.pairAddress) return null;
  return parsePairToDetails(
    {
      priceUsd: entry.priceUsd,
      marketCap: entry.marketCapUsd,
      liquidity: { usd: entry.liquidityUsd },
      volume: { m5: entry.volume5mUsd, h1: entry.volume1hUsd },
      pairAddress: entry.pairAddress,
      baseToken: { address: entry.baseMint ?? mint },
      quoteToken: { address: entry.quoteMint ?? SOL_MINT },
      dexId: entry.dexId,
    },
    mint,
    entry.fetchedAtMs,
  );
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
  /** DexScreener `priceChange.h1`, percent. Only present on a live parse. */
  priceChangeH1Pct: number | null;
  fetchedAtMs: number;
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
  const priceChange = pair.priceChange as { m5?: number; h1?: number } | undefined;
  const createdAt = Number((pair as { pairCreatedAt?: number }).pairCreatedAt);
  const changeM5 = Number(priceChange?.m5);
  const changeH1 = Number(priceChange?.h1);
  return {
    priceUsd: entry.priceUsd ?? null,
    marketCapUsd: entry.marketCapUsd ?? null,
    liquidityUsd: entry.liquidityUsd ?? null,
    volume5mUsd: entry.volume5mUsd ?? null,
    volume1hUsd: entry.volume1hUsd ?? null,
    pairAddress: entry.pairAddress,
    baseMint: entry.baseMint ?? mint,
    quoteMint: entry.quoteMint ?? SOL_MINT,
    dexId: (pair.dexId as string | undefined) ?? null,
    buys5m: toInt(txns?.m5?.buys),
    sells5m: toInt(txns?.m5?.sells),
    pairCreatedAtMs: Number.isFinite(createdAt) && createdAt > 0 ? Math.trunc(createdAt) : null,
    priceChangeM5Pct: Number.isFinite(changeM5) ? changeM5 : null,
    priceChangeH1Pct: Number.isFinite(changeH1) ? changeH1 : null,
    fetchedAtMs: nowMs,
  };
}

function parsePairCreatedAtMs(
  pair: Record<string, unknown> | null,
  mint: string,
  nowMs: number,
): number | null {
  return parsePairToDetails(pair, mint, nowMs)?.pairCreatedAtMs ?? null;
}

export async function fetchDexScreenerPairDetails(
  mint: string,
  opts?: {
    fetchImpl?: typeof fetch;
    cacheTtlMs?: number;
    nowMs?: number;
    preferredDex?: string;
    /** Restrict pair pick to these DexScreener dexIds (mild-dip allow-list). */
    allowedDexIds?: string[];
    /** When true, always HTTP-fetch (still respects global gate + updates shared cache). */
    bypassCache?: boolean;
    /**
     * When true, skip the shared DexScreener RPM queue. Active 429 cooldowns
     * still fail closed without issuing an HTTP request.
     * Use only for tightly self-rate-limited callers (open-bag mark refresh).
     */
    bypassGate?: boolean;
  },
): Promise<DexScreenerPairDetails | null> {
  if (!mint) return null;
  const nowMs = opts?.nowMs ?? Date.now();
  const ttlMs = opts?.cacheTtlMs ?? dexQuoteCacheTtlMs();
  const bypass = opts?.bypassCache === true;
  const allowedDexIds = opts?.allowedDexIds;
  const doFetch = opts?.fetchImpl ?? fetch;

  const detailsFromCacheEntry = (cached: CacheEntry): DexScreenerPairDetails | null => {
    if (cached.miss || !cached.pairAddress) return null;
    if (!dexIdAllowed(cached.dexId, allowedDexIds)) return null;
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
        dexId: cached.dexId,
      },
      mint,
      cached.fetchedAtMs,
    );
  };

  if (!bypass) {
    const mem = inProcess.get(mint);
    if (mem && nowMs - mem.at < ttlMs) {
      const cached = readCacheFile()[mint];
      if (cached) {
        const fromMem = detailsFromCacheEntry(cached);
        if (fromMem) return fromMem;
        // Cache hit but wrong/missing dex vs allow-list → fall through to HTTP.
      }
    }
    if (isDexQuoteCacheEnabled()) {
      const cached = getCachedDexQuote(mint, nowMs, ttlMs);
      if (cached.hit && cached.entry) {
        const fromDisk = detailsFromCacheEntry(cached.entry);
        if (fromDisk) return fromDisk;
      }
    }
  }

  if (opts?.bypassGate === true && (await dexScreenerCooldownActive())) {
    inProcess.set(mint, { at: nowMs, val: null });
    return null;
  }

  if (opts?.bypassGate !== true) {
    await acquireDexScreenerSlot();
  }

  let details: DexScreenerPairDetails | null = null;
  let cacheEntry: CacheEntry = { miss: true, fetchedAtMs: nowMs };
  let rateLimited429 = false;
  try {
    const res = await doFetch(
      `https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(mint)}`,
      { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8_000) },
    );
    rateLimited429 = await recordDexScreenerResponse(res);
    if (res.ok) {
      const j = (await res.json()) as { pairs?: unknown[] };
      const best = pickBestSolanaPair(j.pairs ?? [], mint, opts?.preferredDex, allowedDexIds);
      cacheEntry = parsePairToCacheEntry(best, mint, nowMs);
      details = parsePairToDetails(best, mint, nowMs);
    }
  } catch {
    /* null */
  }

  if (!rateLimited429 && isDexQuoteCacheEnabled()) {
    await putCachedDexQuotes({ [mint]: cacheEntry }, nowMs);
  }
  const snap = cacheEntryToSnapshot(cacheEntry);
  inProcess.set(mint, { at: nowMs, val: snap, details: details ?? undefined });
  return details;
}

/** DexScreener accepts up to 30 comma-separated addresses per request. */
export const DEXSCREENER_BATCH_MAX = 30;
// Bound fallback requests so structural backfill cannot monopolize the gate.
const DEXSCREENER_FOLLOW_UP_MAX = 8;

export type DexScreenerBatchPrefetchResult = {
  requests: number;
  requestedMints: string[];
  resolvedMints: string[];
  missedMints: string[];
  errorMints: string[];
  rateLimited429: number;
  cooldownSkipped: number;
  uncoveredMints: string[];
  retriedMints: string[];
  pairCreatedAtMs: Map<string, number | null>;
  detailsByMint: Map<string, DexScreenerPairDetails>;
};

/**
 * 1.11.820 — warm the shared cache for a list of mints with one HTTP call per
 * 30 addresses and one gate slot per call.
 *
 * The per-mint `fetchDexScreenerPairDetails` stays as-is; callers that already
 * hold a list (discovery enrich, open-position mark refresh) prefetch first and
 * then read cache. Before this, scanning 60 mints cost 60 requests and 60 gate
 * slots against a 120 RPM budget shared with every other consumer, which is how
 * `structural_fetch_null` became the top entry blocker.
 *
 * Returns the number of HTTP requests actually issued.
 */
export async function prefetchDexScreenerPairDetailsMany(
  mints: readonly string[],
  opts?: {
    fetchImpl?: typeof fetch;
    cacheTtlMs?: number;
    nowMs?: number;
    allowedDexIds?: string[];
    bypassGate?: boolean;
  },
): Promise<number> {
  return (await prefetchDexScreenerPairDetailsManyWithMetadata(mints, opts)).requests;
}

/**
 * Batch quote warm-up with pair-age metadata.  This is additive to the
 * historical numeric-returning helper so existing callers remain unchanged.
 */
export async function prefetchDexScreenerPairDetailsManyWithMetadata(
  mints: readonly string[],
  opts?: {
    fetchImpl?: typeof fetch;
    cacheTtlMs?: number;
    nowMs?: number;
    allowedDexIds?: string[];
    bypassGate?: boolean;
  },
): Promise<DexScreenerBatchPrefetchResult> {
  const nowMs = opts?.nowMs ?? Date.now();
  const ttlMs = opts?.cacheTtlMs ?? dexQuoteCacheTtlMs();
  const wanted: string[] = [];
  const resolvedMints: string[] = [];
  const missedMints: string[] = [];
  let rateLimited429 = 0;
  let cooldownSkipped = 0;
  const uncoveredMints: string[] = [];
  const retriedMints: string[] = [];
  const pairCreatedAtMs = new Map<string, number | null>();
  const detailsByMint = new Map<string, DexScreenerPairDetails>();
  const seen = new Set<string>();
  for (const m of mints) {
    if (!m || seen.has(m)) continue;
    seen.add(m);
    const mem = inProcess.get(m);
    if (mem && nowMs - mem.at < ttlMs) {
      if (mem.details) {
        detailsByMint.set(m, mem.details);
        pairCreatedAtMs.set(m, mem.details.pairCreatedAtMs);
        resolvedMints.push(m);
        continue;
      }
    }
    if (isDexQuoteCacheEnabled()) {
      const cached = getCachedDexQuote(m, nowMs, ttlMs);
      if (
        cached.hit &&
        cached.entry &&
        !cached.entry.miss &&
        dexIdAllowed(cached.entry.dexId, opts?.allowedDexIds)
      ) {
        const details = cacheEntryToDetails(cached.entry, m);
        if (details) {
          detailsByMint.set(m, details);
          pairCreatedAtMs.set(m, details.pairCreatedAtMs);
          resolvedMints.push(m);
          continue;
        }
      }
    }
    wanted.push(m);
  }
  if (wanted.length === 0) {
    return {
      requests: 0,
      requestedMints: [],
      resolvedMints,
      missedMints,
      errorMints: [],
      rateLimited429,
      cooldownSkipped,
      uncoveredMints,
      retriedMints,
      pairCreatedAtMs,
      detailsByMint,
    };
  }

  const doFetch = opts?.fetchImpl ?? fetch;
  let calls = 0;
  const errorMints: string[] = [];
  for (let i = 0; i < wanted.length; i += DEXSCREENER_BATCH_MAX) {
    const chunk = wanted.slice(i, i + DEXSCREENER_BATCH_MAX);
    if (opts?.bypassGate === true) {
      if (await dexScreenerCooldownActive()) {
        cooldownSkipped += 1;
        errorMints.push(...chunk);
        continue;
      }
    } else {
      await acquireDexScreenerSlot();
    }
    calls += 1;
    const entries: Record<string, CacheEntry> = {};
    for (const m of chunk) entries[m] = { miss: true, fetchedAtMs: nowMs };
    let requestError = false;
    try {
      const res = await doFetch(
        `https://api.dexscreener.com/latest/dex/tokens/${chunk.map(encodeURIComponent).join(',')}`,
        { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(12_000) },
      );
      const is429 = await recordDexScreenerResponse(res);
      if (is429) rateLimited429 += 1;
      if (res.ok) {
        const j = (await res.json()) as { pairs?: unknown[] };
        const pairs = Array.isArray(j.pairs) ? j.pairs : [];
        const chunkUncovered: string[] = [];
        for (const m of chunk) {
          const best = pickBestSolanaPair(pairs, m, undefined, opts?.allowedDexIds);
          entries[m] = parsePairToCacheEntry(best, m, nowMs);
          const details = parsePairToDetails(best, m, nowMs);
          if (details) detailsByMint.set(m, details);
          const createdAt = parsePairCreatedAtMs(best, m, nowMs);
          pairCreatedAtMs.set(m, createdAt);
          if (!entries[m]!.miss) resolvedMints.push(m);
          else chunkUncovered.push(m);
        }
        if (pairs.length >= DEXSCREENER_BATCH_MAX && chunkUncovered.length > 0) {
          uncoveredMints.push(...chunkUncovered);
          for (const [index, mint] of chunkUncovered.entries()) {
            if (index >= DEXSCREENER_FOLLOW_UP_MAX) {
              missedMints.push(mint);
              continue;
            }
            retriedMints.push(mint);
            if (opts?.bypassGate === true && (await dexScreenerCooldownActive())) {
              cooldownSkipped += 1;
              missedMints.push(mint);
              continue;
            }
            const details = await fetchDexScreenerPairDetails(mint, {
              fetchImpl: doFetch,
              cacheTtlMs: ttlMs,
              nowMs,
              allowedDexIds: opts?.allowedDexIds,
              bypassCache: true,
              bypassGate: opts?.bypassGate,
            });
            calls += 1;
            if (details) {
              detailsByMint.set(mint, details);
              pairCreatedAtMs.set(mint, details.pairCreatedAtMs);
              entries[mint] = parsePairToCacheEntry(
                {
                  priceUsd: details.priceUsd,
                  marketCap: details.marketCapUsd,
                  liquidity: { usd: details.liquidityUsd },
                  volume: { m5: details.volume5mUsd, h1: details.volume1hUsd },
                  pairAddress: details.pairAddress,
                  baseToken: { address: details.baseMint },
                  quoteToken: { address: details.quoteMint },
                  dexId: details.dexId,
                },
                mint,
                nowMs,
              );
              resolvedMints.push(mint);
            } else {
              entries[mint] = { miss: true, fetchedAtMs: nowMs };
              missedMints.push(mint);
            }
          }
        } else {
          missedMints.push(...chunkUncovered);
        }
      } else {
        requestError = true;
      }
    } catch {
      requestError = true;
    }
    if (requestError) {
      errorMints.push(...chunk);
      continue;
    }
    if (isDexQuoteCacheEnabled()) await putCachedDexQuotes(entries, nowMs);
    for (const m of chunk) {
      inProcess.set(m, {
        at: nowMs,
        val: cacheEntryToSnapshot(entries[m]!),
        details: detailsByMint.get(m),
      });
    }
  }
  return {
    requests: calls,
    requestedMints: wanted,
    resolvedMints,
    missedMints,
    errorMints,
    rateLimited429,
    cooldownSkipped,
    uncoveredMints,
    retriedMints,
    pairCreatedAtMs,
    detailsByMint,
  };
}

/**
 * Fetch pair-creation timestamps for up to one chunk per call.
 *
 * This deliberately does not populate or read the quote cache: the cache
 * schema predates pair age and this is a journal-only measurement backfill.
 */
export async function fetchDexScreenerPairCreatedAtMany(
  mints: readonly string[],
  opts?: {
    fetchImpl?: typeof fetch;
    nowMs?: number;
    allowedDexIds?: string[];
    bypassGate?: boolean;
  },
): Promise<Map<string, number | null>> {
  const nowMs = opts?.nowMs ?? Date.now();
  const wanted = [...new Set(mints.filter(Boolean))];
  const result = new Map<string, number | null>(wanted.map((mint) => [mint, null]));
  if (wanted.length === 0) return result;
  const doFetch = opts?.fetchImpl ?? fetch;
  for (let i = 0; i < wanted.length; i += DEXSCREENER_BATCH_MAX) {
    const chunk = wanted.slice(i, i + DEXSCREENER_BATCH_MAX);
    if (opts?.bypassGate === true) {
      if (await dexScreenerCooldownActive()) continue;
    } else {
      await acquireDexScreenerSlot();
    }
    try {
      const res = await doFetch(
        `https://api.dexscreener.com/latest/dex/tokens/${chunk.map(encodeURIComponent).join(',')}`,
        { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(12_000) },
      );
      await recordDexScreenerResponse(res);
      if (!res.ok) continue;
      const j = (await res.json()) as { pairs?: unknown[] };
      const pairs = Array.isArray(j.pairs) ? j.pairs : [];
      for (const mint of chunk) {
        const best = pickBestSolanaPair(pairs, mint, undefined, opts?.allowedDexIds);
        result.set(mint, parsePairCreatedAtMs(best, mint, nowMs));
      }
    } catch {
      /* leave the chunk as nulls; callers remain fail-soft */
    }
  }
  return result;
}

/** Test-only — clears in-process L1 cache. */
export function __resetDexQuoteCacheForTests(): void {
  inProcess.clear();
}

export async function fetchDexScreenerQuoteViaCache(
  mint: string,
  opts?: {
    fetchImpl?: typeof fetch;
    cacheTtlMs?: number;
    nowMs?: number;
  },
): Promise<DexScreenerMarketSnapshot | null> {
  if (!mint) return null;
  const nowMs = opts?.nowMs ?? Date.now();
  const ttlMs = opts?.cacheTtlMs ?? dexQuoteCacheTtlMs();
  const doFetch = opts?.fetchImpl ?? fetch;

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
  let rateLimited429 = false;
  try {
    const res = await doFetch(
      `https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(mint)}`,
      { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8_000) },
    );
    rateLimited429 = await recordDexScreenerResponse(res);
    if (res.ok) {
      const j = (await res.json()) as { pairs?: unknown[] };
      const best = pickBestSolanaPair(j.pairs ?? [], mint);
      cacheEntry = parsePairToCacheEntry(best, mint, nowMs);
      snap = cacheEntryToSnapshot(cacheEntry);
    }
  } catch {
    /* null snap */
  }

  if (!rateLimited429 && isDexQuoteCacheEnabled()) {
    await putCachedDexQuotes({ [mint]: cacheEntry }, nowMs);
  }
  inProcess.set(mint, { at: nowMs, val: snap });
  return snap;
}
