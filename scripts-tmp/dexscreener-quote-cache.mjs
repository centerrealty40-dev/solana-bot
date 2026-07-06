/**
 * Cross-process DexScreener `/latest/dex/tokens/{mint}` quote cache.
 * One shared file on Oscar VPS — live-oscar, collectors, enrich scripts read first;
 * HTTP only on miss, coordinated via dexscreener-api-gate slot scheduler.
 *
 * Lera (separate VPS) does not share this file — see docs note in .env.example.
 *
 * Env:
 * - `DEX_QUOTE_CACHE_ENABLED=0` — disable (direct HTTP + gate only).
 * - `DEX_QUOTE_CACHE_TTL_MS` — entry TTL (default 20000, clamp 12s–60s).
 * - `DEX_QUOTE_CACHE_PATH` — cache file (default `data/dexscreener-quote-cache.json`).
 */
import fs from 'node:fs';
import path from 'node:path';
import { acquireDexScreenerSlot } from './dexscreener-api-gate.mjs';

const SOL_MINT = 'So11111111111111111111111111111111111111112';

export function quoteCacheEnabled() {
  const flag = String(process.env.DEX_QUOTE_CACHE_ENABLED ?? '1').trim();
  return flag !== '0';
}

export function quoteCacheTtlMs() {
  const raw = process.env.DEX_QUOTE_CACHE_TTL_MS?.trim();
  if (raw) {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) return Math.min(60_000, Math.max(12_000, n));
  }
  return 20_000;
}

export function quoteCachePath() {
  const custom = process.env.DEX_QUOTE_CACHE_PATH?.trim();
  if (custom) return custom;
  return path.join(process.cwd(), 'data', 'dexscreener-quote-cache.json');
}

function lockPath() {
  return `${quoteCachePath()}.lock`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function positive(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function clearStaleLock(maxAgeMs = 30_000) {
  try {
    const st = fs.statSync(lockPath());
    if (Date.now() - st.mtimeMs > maxAgeMs) fs.unlinkSync(lockPath());
  } catch {
    /* no lock */
  }
}

async function withFileLock(fn) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    clearStaleLock();
    try {
      const fd = fs.openSync(lockPath(), 'wx');
      try {
        return await fn();
      } finally {
        fs.closeSync(fd);
        try {
          fs.unlinkSync(lockPath());
        } catch {
          /* ignore */
        }
      }
    } catch (e) {
      if (e?.code === 'EEXIST') {
        await sleep(5 + Math.floor(Math.random() * 15));
        continue;
      }
      throw e;
    }
  }
  return fn();
}

function readCacheFile() {
  try {
    const raw = fs.readFileSync(quoteCachePath(), 'utf8');
    const j = JSON.parse(raw);
    return j?.entries && typeof j.entries === 'object' ? j.entries : {};
  } catch {
    return {};
  }
}

function writeCacheFile(entries) {
  const p = quoteCachePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const ttl = quoteCacheTtlMs();
  const cutoff = Date.now() - ttl * 3;
  const pruned = {};
  for (const [mint, entry] of Object.entries(entries)) {
    const at = entry?.fetchedAtMs;
    if (typeof at === 'number' && at >= cutoff) pruned[mint] = entry;
  }
  const tmp = `${p}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(
    tmp,
    JSON.stringify({ entries: pruned, updatedAt: Date.now() }),
    'utf8',
  );
  fs.renameSync(tmp, p);
}

/** @returns {{ hit: boolean, entry?: object | null }} */
export function getCachedDexQuote(mint, nowMs = Date.now(), ttlMs = quoteCacheTtlMs()) {
  if (!mint || !quoteCacheEnabled()) return { hit: false };
  const entries = readCacheFile();
  const entry = entries[mint];
  if (!entry || typeof entry.fetchedAtMs !== 'number') return { hit: false };
  if (nowMs - entry.fetchedAtMs > ttlMs) return { hit: false };
  return { hit: true, entry };
}

export async function putCachedDexQuotes(updates, nowMs = Date.now()) {
  if (!quoteCacheEnabled() || !updates || typeof updates !== 'object') return;
  try {
    await withFileLock(async () => {
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

function pickBestSolanaPair(pairs, mint) {
  if (!Array.isArray(pairs) || pairs.length === 0) return null;
  const relevant = pairs.filter((p) => {
    if (p?.chainId && p.chainId !== 'solana') return false;
    const base = p?.baseToken?.address ?? '';
    const quote = p?.quoteToken?.address ?? '';
    return base === mint || quote === mint;
  });
  const pool = relevant.length > 0 ? relevant : pairs;
  let best = null;
  let bestLiq = -1;
  for (const p of pool) {
    const liq = Number(p?.liquidity?.usd ?? 0);
    if (liq > bestLiq) {
      bestLiq = liq;
      best = p;
    }
  }
  return best;
}

export function parseDexPairToCacheEntry(pair, mint, nowMs = Date.now()) {
  if (!pair) {
    return { miss: true, fetchedAtMs: nowMs };
  }
  const volume = pair.volume ?? {};
  return {
    miss: false,
    priceUsd: positive(pair.priceUsd),
    marketCapUsd: positive(pair.marketCap ?? pair.fdv),
    liquidityUsd: positive(pair.liquidity?.usd),
    volume5mUsd: positive(volume.m5),
    volume1hUsd: positive(volume.h1),
    pairAddress: pair.pairAddress ?? null,
    baseMint: pair.baseToken?.address ?? mint,
    quoteMint: pair.quoteToken?.address ?? SOL_MINT,
    fetchedAtMs: nowMs,
  };
}

export function pairsResponseToCacheUpdates(pairs, mints, nowMs = Date.now()) {
  const updates = {};
  const mintSet = new Set(mints);
  const byMint = new Map();
  for (const p of pairs ?? []) {
    const base = p?.baseToken?.address;
    const quote = p?.quoteToken?.address;
    for (const m of [base, quote]) {
      if (!m || !mintSet.has(m)) continue;
      const prev = byMint.get(m);
      const liq = Number(p?.liquidity?.usd ?? 0);
      if (!prev || liq > prev.liq) byMint.set(m, { pair: p, liq });
    }
  }
  for (const mint of mints) {
    const hit = byMint.get(mint);
    updates[mint] = parseDexPairToCacheEntry(hit?.pair ?? null, mint, nowMs);
  }
  return updates;
}

/** Build collector snapshot row from cached entry (no HTTP). */
export function snapshotToCollectorRow(mint, entry, bucketTs, sourceTag) {
  if (!entry || entry.miss) return null;
  return {
    ts: bucketTs,
    source: sourceTag,
    pair_address: entry.pairAddress ?? `dex-cache:${mint}`,
    base_mint: entry.baseMint ?? mint,
    quote_mint: entry.quoteMint ?? SOL_MINT,
    price_usd: entry.priceUsd,
    liquidity_usd: entry.liquidityUsd,
    volume_5m: entry.volume5mUsd,
    volume_1h: entry.volume1hUsd,
    buys_5m: null,
    sells_5m: null,
    fdv_usd: entry.marketCapUsd,
    market_cap_usd: entry.marketCapUsd,
    launch_ts: null,
    _dexQuoteCache: true,
  };
}

function cacheEntryToSnapshot(entry) {
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

const inProcess = new Map();

/** Test-only. */
export function __resetDexQuoteInProcessCacheForTests() {
  inProcess.clear();
}

/**
 * Fetch Dex token quote: L1 in-process → L2 file cache → gate + HTTP.
 * @param {string} mint
 * @param {{ fetchImpl?: typeof fetch, cacheTtlMs?: number, nowMs?: number }} [opts]
 */
export async function fetchDexQuoteViaCache(mint, opts = {}) {
  if (!mint) return null;
  const nowMs = opts.nowMs ?? Date.now();
  const ttlMs = opts.cacheTtlMs ?? quoteCacheTtlMs();
  const doFetch = opts.fetchImpl ?? globalThis.fetch;

  const mem = inProcess.get(mint);
  if (mem && nowMs - mem.at < ttlMs) return mem.val;

  if (quoteCacheEnabled()) {
    const cached = getCachedDexQuote(mint, nowMs, ttlMs);
    if (cached.hit) {
      const snap = cacheEntryToSnapshot(cached.entry);
      inProcess.set(mint, { at: nowMs, val: snap });
      return snap;
    }
  }

  await acquireDexScreenerSlot();

  if (quoteCacheEnabled()) {
    const cached = getCachedDexQuote(mint, nowMs, ttlMs);
    if (cached.hit) {
      const snap = cacheEntryToSnapshot(cached.entry);
      inProcess.set(mint, { at: nowMs, val: snap });
      return snap;
    }
  }

  let snap = null;
  let cacheEntry = { miss: true, fetchedAtMs: nowMs };
  try {
    const res = await doFetch(
      `https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(mint)}`,
      { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8_000) },
    );
    if (res.ok) {
      const j = await res.json();
      const best = pickBestSolanaPair(j?.pairs ?? [], mint);
      cacheEntry = parseDexPairToCacheEntry(best, mint, nowMs);
      snap = cacheEntryToSnapshot(cacheEntry);
    }
  } catch {
    /* null snap */
  }

  if (quoteCacheEnabled()) {
    await putCachedDexQuotes({ [mint]: cacheEntry }, nowMs);
  }
  inProcess.set(mint, { at: nowMs, val: snap });
  return snap;
}

/**
 * Batch fetch for multiple mints (chunks of 10). Returns Map mint → snapshot|null.
 * @param {string[]} mints
 * @param {{ fetchImpl?: typeof fetch, cacheTtlMs?: number, nowMs?: number }} [opts]
 */
export async function fetchDexQuotesBatchViaCache(mints, opts = {}) {
  const out = new Map();
  const unique = [...new Set((mints ?? []).filter(Boolean))];
  const nowMs = opts.nowMs ?? Date.now();
  const ttlMs = opts.cacheTtlMs ?? quoteCacheTtlMs();
  const misses = [];

  for (const mint of unique) {
    const mem = inProcess.get(mint);
    if (mem && nowMs - mem.at < ttlMs) {
      out.set(mint, mem.val);
      continue;
    }
    if (quoteCacheEnabled()) {
      const cached = getCachedDexQuote(mint, nowMs, ttlMs);
      if (cached.hit) {
        const snap = cacheEntryToSnapshot(cached.entry);
        inProcess.set(mint, { at: nowMs, val: snap });
        out.set(mint, snap);
        continue;
      }
    }
    misses.push(mint);
  }

  if (misses.length === 0) return out;

  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  const CHUNK = 10;

  for (let i = 0; i < misses.length; i += CHUNK) {
    const chunk = misses.slice(i, i + CHUNK);
    await acquireDexScreenerSlot();

    const stillMiss = [];
    for (const mint of chunk) {
      if (quoteCacheEnabled()) {
        const cached = getCachedDexQuote(mint, nowMs, ttlMs);
        if (cached.hit) {
          const snap = cacheEntryToSnapshot(cached.entry);
          inProcess.set(mint, { at: nowMs, val: snap });
          out.set(mint, snap);
          continue;
        }
      }
      stillMiss.push(mint);
    }
    if (stillMiss.length === 0) continue;

    let updates = {};
    try {
      const url = `https://api.dexscreener.com/latest/dex/tokens/${stillMiss.map((m) => encodeURIComponent(m)).join(',')}`;
      const res = await doFetch(url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(12_000),
      });
      if (res.ok) {
        const j = await res.json();
        updates = pairsResponseToCacheUpdates(j?.pairs ?? [], stillMiss, nowMs);
      } else {
        for (const mint of stillMiss) {
          updates[mint] = { miss: true, fetchedAtMs: nowMs };
        }
      }
    } catch {
      for (const mint of stillMiss) {
        updates[mint] = { miss: true, fetchedAtMs: nowMs };
      }
    }

    if (quoteCacheEnabled()) await putCachedDexQuotes(updates, nowMs);

    for (const mint of stillMiss) {
      const entry = updates[mint] ?? { miss: true, fetchedAtMs: nowMs };
      const snap = cacheEntryToSnapshot(entry);
      inProcess.set(mint, { at: nowMs, val: snap });
      out.set(mint, snap);
    }
  }

  return out;
}
