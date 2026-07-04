/**
 * Birdeye REST market-data client for discovery freshness (Lite+ tier).
 *
 * Endpoints (Solana):
 *  - GET /defi/v3/token/market-data?address=<mint>  → price, mcap, liq, fdv
 *  - GET /defi/v3/token/trade-data/single?address=<mint>&frames=5m → volume_5m_usd
 *
 * TTL in-memory cache limits burst; 429 / CU quota responses surface `tierInsufficient`
 * for observability (`birdeye_tier_insufficient` journal events).
 */
import { fetch } from 'undici';

export type BirdeyeFetchErrorKind = 'rate_limit' | 'quota' | 'auth' | 'network' | 'parse';

export interface BirdeyeMarketQuote {
  priceUsd: number | null;
  marketCapUsd: number | null;
  liquidityUsd: number | null;
  volume5mUsd: number | null;
  fetchedAtMs: number;
}

interface CacheEntry extends BirdeyeMarketQuote {
  tierInsufficient?: boolean;
  lastErrorKind?: BirdeyeFetchErrorKind;
}

const cache = new Map<string, CacheEntry>();

const BIRDEYE_BASE = 'https://public-api.birdeye.so';

function positive(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function parseBirdeyeMarketData(json: unknown): Partial<BirdeyeMarketQuote> | null {
  const root = json as { success?: boolean; data?: Record<string, unknown> };
  if (root?.success === false) return null;
  const d = root?.data;
  if (!d || typeof d !== 'object') return null;
  const priceUsd = positive(d.price);
  const marketCapUsd = positive(d.market_cap ?? d.marketCap);
  const liquidityUsd = positive(d.liquidity);
  const fdv = positive(d.fdv);
  const mcap = marketCapUsd ?? fdv;
  if (priceUsd == null && mcap == null && liquidityUsd == null) return null;
  return { priceUsd, marketCapUsd: mcap, liquidityUsd, volume5mUsd: null, fetchedAtMs: Date.now() };
}

export function parseBirdeyeTradeData5m(json: unknown): number | null {
  const root = json as { success?: boolean; data?: Record<string, unknown> };
  if (root?.success === false) return null;
  const d = root?.data;
  if (!d || typeof d !== 'object') return null;
  return positive(d.volume_5m_usd ?? d.volume_5m);
}

export function classifyBirdeyeError(status: number, message: string): BirdeyeFetchErrorKind {
  const msg = message.toLowerCase();
  if (status === 429 || msg.includes('too many requests') || msg.includes('rate limit')) {
    return 'rate_limit';
  }
  if (/compute units|cu limit|usage limit|quota|max usage|exceeded/i.test(msg)) {
    return 'quota';
  }
  if (status === 401 || status === 403 || msg.includes('unauthorized') || msg.includes('access denied')) {
    return 'auth';
  }
  return 'network';
}

export function isBirdeyeTierInsufficient(kind: BirdeyeFetchErrorKind | undefined): boolean {
  return kind === 'rate_limit' || kind === 'quota';
}

export interface BirdeyeMarketOptions {
  apiKey?: string;
  ttlMs: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  nowMs?: number;
  /** When false, skip trade-data call (saves CU). */
  fetchVolume5m?: boolean;
}

function resolveApiKey(opts: BirdeyeMarketOptions): string {
  return (opts.apiKey ?? process.env.BIRDEYE_API_KEY?.trim() ?? '').trim();
}

/** Test-only cache reset. */
export function __resetBirdeyeMarketCacheForTests(): void {
  cache.clear();
}

async function birdeyeGet(
  path: string,
  apiKey: string,
  doFetch: typeof fetch,
  timeoutMs: number,
): Promise<{ ok: boolean; status: number; json: unknown; message: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await doFetch(`${BIRDEYE_BASE}${path}`, {
      headers: {
        accept: 'application/json',
        'X-API-KEY': apiKey,
        'x-chain': 'solana',
      },
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    const message = String((json as { message?: string })?.message ?? text.slice(0, 200));
    return { ok: res.ok, status: res.status, json, message };
  } catch {
    return { ok: false, status: 0, json: null, message: 'network_error' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Best-effort Birdeye market quote for a mint (TTL cached). Returns `null` on missing key or total failure.
 * Sets `tierInsufficient` on cache entry when rate-limit / CU quota is hit.
 */
export async function resolveBirdeyeMarketQuote(
  mint: string,
  opts: BirdeyeMarketOptions,
): Promise<(BirdeyeMarketQuote & { tierInsufficient?: boolean; errorKind?: BirdeyeFetchErrorKind }) | null> {
  if (!mint) return null;
  const now = opts.nowMs ?? Date.now();
  const ttl = Number.isFinite(opts.ttlMs) && opts.ttlMs > 0 ? opts.ttlMs : 12_000;
  const cached = cache.get(mint);
  if (cached && now - cached.fetchedAtMs < ttl) {
    return {
      priceUsd: cached.priceUsd,
      marketCapUsd: cached.marketCapUsd,
      liquidityUsd: cached.liquidityUsd,
      volume5mUsd: cached.volume5mUsd,
      fetchedAtMs: cached.fetchedAtMs,
      tierInsufficient: cached.tierInsufficient,
      errorKind: cached.lastErrorKind,
    };
  }

  const apiKey = resolveApiKey(opts);
  if (!apiKey) return null;

  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs =
    Number.isFinite(opts.timeoutMs) && (opts.timeoutMs ?? 0) > 0 ? (opts.timeoutMs as number) : 3_000;

  let tierInsufficient = false;
  let lastErrorKind: BirdeyeFetchErrorKind | undefined;

  const marketPath = `/defi/v3/token/market-data?address=${encodeURIComponent(mint)}`;
  const marketRes = await birdeyeGet(marketPath, apiKey, doFetch, timeoutMs);
  let parsed = marketRes.ok ? parseBirdeyeMarketData(marketRes.json) : null;
  if (!marketRes.ok || parsed == null) {
    lastErrorKind = classifyBirdeyeError(marketRes.status, marketRes.message);
    if (isBirdeyeTierInsufficient(lastErrorKind)) tierInsufficient = true;
  }

  let volume5mUsd: number | null = parsed?.volume5mUsd ?? null;
  if (opts.fetchVolume5m !== false && !tierInsufficient) {
    const tradePath = `/defi/v3/token/trade-data/single?address=${encodeURIComponent(mint)}&frames=5m`;
    const tradeRes = await birdeyeGet(tradePath, apiKey, doFetch, timeoutMs);
    if (tradeRes.ok) {
      const vol = parseBirdeyeTradeData5m(tradeRes.json);
      if (vol != null) volume5mUsd = vol;
    } else {
      const kind = classifyBirdeyeError(tradeRes.status, tradeRes.message);
      if (isBirdeyeTierInsufficient(kind)) {
        tierInsufficient = true;
        lastErrorKind = kind;
      }
    }
  }

  const fetchedAtMs = now;
  const out: CacheEntry = {
    priceUsd: parsed?.priceUsd ?? null,
    marketCapUsd: parsed?.marketCapUsd ?? null,
    liquidityUsd: parsed?.liquidityUsd ?? null,
    volume5mUsd,
    fetchedAtMs,
    tierInsufficient: tierInsufficient || undefined,
    lastErrorKind,
  };
  cache.set(mint, out);

  if (
    out.priceUsd == null &&
    out.marketCapUsd == null &&
    out.liquidityUsd == null &&
    out.volume5mUsd == null
  ) {
    return tierInsufficient ? { ...out, tierInsufficient: true, errorKind: lastErrorKind } : null;
  }
  return {
    ...out,
    tierInsufficient: tierInsufficient || undefined,
    errorKind: lastErrorKind,
  };
}
