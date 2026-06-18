/**
 * Shyft DeFi API mcap/liquidity resolver (Stage 1.3, 1.11.469).
 *
 * Fetches a fresher market-cap / liquidity reading for a discovery candidate from the Shyft DeFi API
 * (`GET {base}/v0/pools/get_by_token?token=<mint>&dex=<dex>`, header `x-api-key`), with an in-memory
 * **TTL cache** (default ~12s) and **graceful fallback** — any network/parse failure (or a missing
 * field) resolves to `null` so the caller keeps the current PG / pump.fun mcap source.
 *
 * **Safety:** the resolver is only invoked when `SHYFT_DEFI_MCAP_ENABLED` is ON (default OFF). When OFF
 * the discovery mcap/liq source is byte-for-byte the current PG path. On the ON path a failed/empty
 * lookup falls back to PG (never blocks or throws into the discovery loop).
 *
 * NOTE: the exact DeFi response schema must be confirmed against the live API by the owner before
 * relying on the override; `parseShyftDefiPools` is intentionally defensive (probes common field
 * names) and returns `null` for anything it cannot read, which the caller treats as "use PG".
 */
import { fetch } from 'undici';

export interface ShyftDefiMcapResult {
  mcapUsd: number | null;
  liqUsd: number | null;
}

interface CacheEntry extends ShyftDefiMcapResult {
  fetchedAtMs: number;
}

const cache = new Map<string, CacheEntry>();

function firstPositiveNumber(obj: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const k of keys) {
    const v = obj[k];
    const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

const MCAP_KEYS = [
  'marketCap',
  'market_cap',
  'market_cap_usd',
  'marketcap',
  'mcap',
  'fdv',
  'fdv_usd',
] as const;

const LIQ_KEYS = [
  'liquidity',
  'liquidity_usd',
  'liquidityUsd',
  'liquidityInUsd',
  'tvl',
  'tvl_usd',
] as const;

/** Collect candidate pool objects from a variety of plausible DeFi response envelopes. */
function collectPoolObjects(json: unknown): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const pushIfObj = (v: unknown): void => {
    if (v && typeof v === 'object' && !Array.isArray(v)) out.push(v as Record<string, unknown>);
  };
  const visit = (node: unknown, depth: number): void => {
    if (depth > 4 || node == null) return;
    if (Array.isArray(node)) {
      for (const el of node) visit(el, depth + 1);
      return;
    }
    if (typeof node === 'object') {
      const obj = node as Record<string, unknown>;
      pushIfObj(obj);
      for (const key of ['result', 'pools', 'data', 'value']) {
        if (key in obj) visit(obj[key], depth + 1);
      }
    }
  };
  visit(json, 0);
  return out;
}

/**
 * Parse a Shyft DeFi pools response into `{mcapUsd, liqUsd}` (best positive reading across pools).
 * Returns `null` when no positive mcap can be read (caller falls back to PG).
 */
export function parseShyftDefiPools(json: unknown): ShyftDefiMcapResult | null {
  const pools = collectPoolObjects(json);
  if (pools.length === 0) return null;
  let bestMcap: number | null = null;
  let bestLiq: number | null = null;
  for (const p of pools) {
    const mc = firstPositiveNumber(p, MCAP_KEYS);
    if (mc != null && (bestMcap == null || mc > bestMcap)) bestMcap = mc;
    const lq = firstPositiveNumber(p, LIQ_KEYS);
    if (lq != null && (bestLiq == null || lq > bestLiq)) bestLiq = lq;
  }
  if (bestMcap == null && bestLiq == null) return null;
  return { mcapUsd: bestMcap, liqUsd: bestLiq };
}

export interface ShyftDefiMcapOptions {
  ttlMs: number;
  /** Defaults to `SHYFT_DEFI_API_BASE` env or `https://defi.shyft.to`. */
  apiBase?: string;
  /** Defaults to `SHYFT_DEFI_API_KEY` / `SHYFT_API_KEY` env. */
  apiKey?: string;
  /** DeFi `dex` query param; default `pumpFunAmm`. */
  dex?: string;
  /** Injected fetch for tests. */
  fetchImpl?: typeof fetch;
  /** `now` override for tests. */
  nowMs?: number;
  /** Per-request timeout (ms). */
  timeoutMs?: number;
}

function resolveApiBase(opts: ShyftDefiMcapOptions): string {
  return (opts.apiBase ?? process.env.SHYFT_DEFI_API_BASE?.trim() ?? '').replace(/\/+$/, '') || 'https://defi.shyft.to';
}

function resolveApiKey(opts: ShyftDefiMcapOptions): string {
  return (opts.apiKey ?? process.env.SHYFT_DEFI_API_KEY?.trim() ?? process.env.SHYFT_API_KEY?.trim() ?? '').trim();
}

/** Test-only cache reset. */
export function __resetShyftDefiMcapCacheForTests(): void {
  cache.clear();
}

/**
 * Best-effort DeFi mcap/liq for a candidate mint, TTL-cached. Returns `null` on any failure (no key,
 * network error, non-200, unparseable body, empty result) so the caller keeps the PG source.
 */
export async function resolveShyftDefiMcap(
  mint: string,
  opts: ShyftDefiMcapOptions,
): Promise<ShyftDefiMcapResult | null> {
  if (!mint) return null;
  const now = opts.nowMs ?? Date.now();
  const ttl = Number.isFinite(opts.ttlMs) && opts.ttlMs > 0 ? opts.ttlMs : 12_000;
  const cached = cache.get(mint);
  if (cached && now - cached.fetchedAtMs < ttl) {
    return cached.mcapUsd != null || cached.liqUsd != null ? { mcapUsd: cached.mcapUsd, liqUsd: cached.liqUsd } : null;
  }
  const apiKey = resolveApiKey(opts);
  if (!apiKey) return null;
  const base = resolveApiBase(opts);
  const dex = opts.dex?.trim() || 'pumpFunAmm';
  const url = `${base}/v0/pools/get_by_token?token=${encodeURIComponent(mint)}&dex=${encodeURIComponent(dex)}`;
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = Number.isFinite(opts.timeoutMs) && (opts.timeoutMs ?? 0) > 0 ? (opts.timeoutMs as number) : 2_500;

  let parsed: ShyftDefiMcapResult | null = null;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await doFetch(url, {
        headers: { accept: 'application/json', 'x-api-key': apiKey },
        signal: ctrl.signal,
      });
      if (res.ok) {
        const json = await res.json();
        parsed = parseShyftDefiPools(json);
      }
    } finally {
      clearTimeout(timer);
    }
  } catch {
    parsed = null;
  }

  cache.set(mint, {
    mcapUsd: parsed?.mcapUsd ?? null,
    liqUsd: parsed?.liqUsd ?? null,
    fetchedAtMs: now,
  });
  return parsed;
}
