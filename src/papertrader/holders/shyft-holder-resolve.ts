/**
 * Shyft Token API holder-count resolver (fallback / last resort).
 *
 * `GET {base}/sol/v1/token/get_owners?token_address=<mint>&network=mainnet-beta&limit=1`
 * with header `x-api-key`. Reads `total` (or common aliases) from the response envelope.
 *
 * Used when QuickNode live resolve fails or the per-tick QN budget is exhausted.
 */
import { fetch } from 'undici';

export interface ShyftHolderCountResult {
  count: number;
}

interface CacheEntry {
  count: number | null;
  fetchedAtMs: number;
}

const cache = new Map<string, CacheEntry>();

const TOTAL_KEYS = [
  'total',
  'total_owners',
  'total_holders',
  'holder_count',
  'holders',
  'owners_count',
] as const;

function firstNonNegativeInt(obj: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const k of keys) {
    const v = obj[k];
    const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
    if (Number.isFinite(n) && n >= 0) return Math.round(n);
  }
  return null;
}

function collectObjects(json: unknown): Record<string, unknown>[] {
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
      for (const key of ['result', 'data', 'value']) {
        if (key in obj) visit(obj[key], depth + 1);
      }
    }
  };
  visit(json, 0);
  return out;
}

/** Parse Shyft `get_owners` (or similar) response into a non-negative holder total. */
export function parseShyftHolderTotal(json: unknown): number | null {
  const objs = collectObjects(json);
  for (const obj of objs) {
    const n = firstNonNegativeInt(obj, TOTAL_KEYS);
    if (n != null) return n;
  }
  return null;
}

export interface ShyftHolderResolveOptions {
  ttlMs: number;
  /** Defaults to `SHYFT_API_BASE` env or `https://api.shyft.to`. */
  apiBase?: string;
  /** Defaults to `SHYFT_API_KEY` env. */
  apiKey?: string;
  fetchImpl?: typeof fetch;
  nowMs?: number;
  timeoutMs?: number;
}

export type ShyftHolderResolveOk = { ok: true; count: number; fromCache: boolean };
export type ShyftHolderResolveFail = { ok: false; reason: 'no_key' | 'http' | 'timeout' | 'parse' };
export type ShyftHolderResolveResult = ShyftHolderResolveOk | ShyftHolderResolveFail;

function resolveApiBase(opts: ShyftHolderResolveOptions): string {
  return (opts.apiBase ?? process.env.SHYFT_API_BASE?.trim() ?? '').replace(/\/+$/, '') || 'https://api.shyft.to';
}

function resolveApiKey(opts: ShyftHolderResolveOptions): string {
  return (opts.apiKey ?? process.env.SHYFT_API_KEY?.trim() ?? '').trim();
}

/** Test-only cache reset. */
export function __resetShyftHolderCacheForTests(): void {
  cache.clear();
}

/**
 * Best-effort holder total for a mint via Shyft Token API, TTL-cached.
 */
export async function resolveShyftHolderCount(
  mint: string,
  opts: ShyftHolderResolveOptions,
): Promise<ShyftHolderResolveResult> {
  if (!mint) return { ok: false, reason: 'parse' };
  const now = opts.nowMs ?? Date.now();
  const ttl = Number.isFinite(opts.ttlMs) && opts.ttlMs > 0 ? opts.ttlMs : 90_000;
  const cached = cache.get(mint);
  if (cached && now - cached.fetchedAtMs < ttl) {
    if (cached.count != null) return { ok: true, count: cached.count, fromCache: true };
    return { ok: false, reason: 'parse' };
  }

  const apiKey = resolveApiKey(opts);
  if (!apiKey) {
    cache.set(mint, { count: null, fetchedAtMs: now });
    return { ok: false, reason: 'no_key' };
  }

  const base = resolveApiBase(opts);
  const url =
    `${base}/sol/v1/token/get_owners?` +
    `token_address=${encodeURIComponent(mint)}&network=mainnet-beta&limit=1`;
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs =
    Number.isFinite(opts.timeoutMs) && (opts.timeoutMs ?? 0) > 0 ? (opts.timeoutMs as number) : 4_000;

  let count: number | null = null;
  let failReason: ShyftHolderResolveFail['reason'] = 'http';
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
        count = parseShyftHolderTotal(json);
        failReason = count == null ? 'parse' : failReason;
      }
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    failReason = (e as Error)?.name === 'AbortError' ? 'timeout' : 'http';
    count = null;
  }

  cache.set(mint, { count, fetchedAtMs: now });
  if (count != null) return { ok: true, count, fromCache: false };
  return { ok: false, reason: failReason };
}
