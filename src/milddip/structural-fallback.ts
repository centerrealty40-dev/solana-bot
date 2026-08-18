import type { MildDipConfig } from './config.js';

export type StructuralFallbackSnapshot = {
  priceUsd: number;
  volume5mUsd: number | null;
  liquidityUsd: number | null;
  buys5m: number | null;
  sells5m: number | null;
  volume1hUsd: number | null;
  priceChange5mPct: number | null;
  priceChange1hPct: number | null;
  pairAgeHours: number | null;
  dexId: string | null;
  marketCapUsd: null;
};

type CachedFallback = {
  fetchedAtMs: number;
  snapshot: StructuralFallbackSnapshot;
};

type GeckoResponse = {
  data?: unknown;
};

type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

const fallbackCache = new Map<string, CachedFallback>();
const lastRequestByMint = new Map<string, number>();
let bucketLastRefillMs: number | null = null;
let bucketTokens = 0;
let bucketRatePerMin = 0;

function finite(raw: unknown): number | null {
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function nonNegative(raw: unknown): number | null {
  const value = finite(raw);
  return value != null && value >= 0 ? value : null;
}

function positive(raw: unknown): number | null {
  const value = finite(raw);
  return value != null && value > 0 ? value : null;
}

function stringValue(raw: unknown): string | null {
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
}

function objectValue(raw: unknown): Record<string, unknown> | null {
  return raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
}

function relationshipId(
  relationships: Record<string, unknown> | null,
  name: string,
): string | null {
  const relation = objectValue(relationships?.[name]);
  return stringValue(objectValue(relation?.data)?.id);
}

function poolCreatedAtMs(raw: unknown): number | null {
  if (typeof raw === 'string' && raw.trim()) {
    const numeric = finite(raw);
    if (numeric != null) {
      return numeric > 10_000_000_000 ? numeric : numeric * 1_000;
    }
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  const numeric = finite(raw);
  if (numeric == null || numeric <= 0) return null;
  return numeric > 10_000_000_000 ? numeric : numeric * 1_000;
}

function ageHours(raw: unknown, nowMs: number): number | null {
  const createdAtMs = poolCreatedAtMs(raw);
  if (createdAtMs == null) return null;
  return Math.max(0, (nowMs - createdAtMs) / 3_600_000);
}

function normalizedDexId(dexId: string): string {
  return dexId.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function allowedDex(dexId: string | null, allowedDexIds: string[]): boolean {
  if (allowedDexIds.length === 0) return true;
  return (
    dexId != null &&
    allowedDexIds.some((id) => normalizedDexId(id) === normalizedDexId(dexId))
  );
}

function pickPool(
  payload: GeckoResponse,
  mint: string,
  allowedDexIds: string[],
): Record<string, unknown> | null {
  if (!Array.isArray(payload.data)) return null;
  const expectedBase = `solana_${mint}`;
  let best: Record<string, unknown> | null = null;
  let bestReserve = -1;
  for (const row of payload.data) {
    const pool = objectValue(row);
    const attributes = objectValue(pool?.attributes);
    const relationships = objectValue(pool?.relationships);
    if (!pool || !attributes || relationshipId(relationships, 'base_token') !== expectedBase) {
      continue;
    }
    const dexId = relationshipId(relationships, 'dex');
    if (!allowedDex(dexId, allowedDexIds)) continue;
    const reserve = positive(attributes.reserve_in_usd);
    if (reserve == null || reserve < bestReserve) continue;
    best = pool;
    bestReserve = reserve;
  }
  return best;
}

function parsePool(
  pool: Record<string, unknown>,
  nowMs: number,
): StructuralFallbackSnapshot | null {
  const attributes = objectValue(pool.attributes);
  const relationships = objectValue(pool.relationships);
  if (!attributes) return null;
  const priceUsd = positive(attributes.base_token_price_usd);
  if (priceUsd == null) return null;
  const volumeUsd = objectValue(attributes.volume_usd);
  const transactions = objectValue(attributes.transactions);
  const m5 = objectValue(transactions?.m5);
  const priceChange = objectValue(attributes.price_change_percentage);
  return {
    priceUsd,
    volume5mUsd: nonNegative(volumeUsd?.m5),
    liquidityUsd: nonNegative(attributes.reserve_in_usd),
    buys5m: nonNegative(m5?.buys),
    sells5m: nonNegative(m5?.sells),
    volume1hUsd: nonNegative(volumeUsd?.h1),
    priceChange5mPct: finite(priceChange?.m5),
    priceChange1hPct: finite(priceChange?.h1),
    pairAgeHours: ageHours(attributes.pool_created_at, nowMs),
    dexId: relationshipId(relationships, 'dex'),
    marketCapUsd: null,
  };
}

function takeBucket(nowMs: number, maxPerMin: number): boolean {
  if (maxPerMin <= 0) return false;
  if (
    bucketLastRefillMs == null ||
    nowMs < bucketLastRefillMs ||
    bucketRatePerMin !== maxPerMin
  ) {
    bucketLastRefillMs = nowMs;
    bucketTokens = maxPerMin;
    bucketRatePerMin = maxPerMin;
  } else {
    bucketTokens = Math.min(
      maxPerMin,
      bucketTokens + ((nowMs - bucketLastRefillMs) * maxPerMin) / 60_000,
    );
    bucketLastRefillMs = nowMs;
  }
  if (bucketTokens < 1) return false;
  bucketTokens -= 1;
  return true;
}

function pruneState(nowMs: number, cacheTtlMs: number, mintGapMs: number): void {
  for (const [mint, cached] of fallbackCache) {
    if (nowMs - cached.fetchedAtMs > Math.max(0, cacheTtlMs)) {
      fallbackCache.delete(mint);
    }
  }
  for (const [mint, requestedAtMs] of lastRequestByMint) {
    if (nowMs - requestedAtMs > Math.max(0, mintGapMs)) {
      lastRequestByMint.delete(mint);
    }
  }
}

export function resetStructuralFallbackStateForTests(): void {
  fallbackCache.clear();
  lastRequestByMint.clear();
  bucketLastRefillMs = null;
  bucketTokens = 0;
  bucketRatePerMin = 0;
}

export async function fetchMildDipStructuralFallback(
  mint: string,
  cfg: Pick<
    MildDipConfig,
    | 'structuralFallbackMaxPerMin'
    | 'structuralFallbackEnabled'
    | 'structuralFallbackMintGapMs'
    | 'structuralFallbackCacheTtlMs'
    | 'structuralFallbackTimeoutMs'
    | 'entry'
  >,
  nowMs: number,
  opts?: { fetchImpl?: FetchLike },
): Promise<StructuralFallbackSnapshot | null> {
  if (!mint || !cfg.structuralFallbackEnabled) return null;
  pruneState(nowMs, cfg.structuralFallbackCacheTtlMs, cfg.structuralFallbackMintGapMs);
  const cached = fallbackCache.get(mint);
  if (
    cached &&
    cfg.structuralFallbackCacheTtlMs > 0 &&
    nowMs - cached.fetchedAtMs >= 0 &&
    nowMs - cached.fetchedAtMs <= cfg.structuralFallbackCacheTtlMs
  ) {
    return cached.snapshot;
  }
  const lastRequest = lastRequestByMint.get(mint);
  if (lastRequest != null && nowMs - lastRequest < cfg.structuralFallbackMintGapMs) {
    return null;
  }
  if (!takeBucket(nowMs, cfg.structuralFallbackMaxPerMin)) {
    return null;
  }
  lastRequestByMint.set(mint, nowMs);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), cfg.structuralFallbackTimeoutMs);
  try {
    const fetchImpl = opts?.fetchImpl ?? (fetch as unknown as FetchLike);
    const response = await fetchImpl(
      `https://api.geckoterminal.com/api/v2/networks/solana/tokens/${encodeURIComponent(mint)}/pools`,
      {
        headers: { accept: 'application/json' },
        signal: controller.signal,
      },
    );
    if (!response.ok) return null;
    const payload = (await response.json()) as GeckoResponse;
    const pool = pickPool(payload, mint, cfg.entry.allowedDexIds);
    const snapshot = pool ? parsePool(pool, nowMs) : null;
    if (snapshot) {
      fallbackCache.set(mint, { fetchedAtMs: nowMs, snapshot });
    }
    return snapshot;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export function getStructuralFallbackStateSizesForTests(): {
  cache: number;
  lastRequestByMint: number;
} {
  return {
    cache: fallbackCache.size,
    lastRequestByMint: lastRequestByMint.size,
  };
}
