/**
 * Discovery market quote resolver: Birdeye → DexScreener → PG snapshot.
 *
 * Pure pick logic + async orchestrator used at live-oscar discovery eval.
 * Default-OFF via `BIRDEYE_PRIMARY_ENABLED`; when OFF skips Birdeye REST, DexScreener → PG.
 */
import { fetch } from 'undici';
import type { SnapshotCandidateRow } from '../types.js';
import {
  isBirdeyeTierInsufficient,
  resolveBirdeyeMarketQuote,
  type BirdeyeFetchErrorKind,
} from './birdeye-market.js';
import { snapshotRowTsMs, snapshotPriceAgeMs } from '../stale-price.js';
import {
  dexQuoteCacheTtlMs,
  fetchDexScreenerQuoteViaCache,
  isDexQuoteCacheEnabled,
} from './dexscreener-quote-cache.js';

export type DiscoveryQuoteSource = 'birdeye' | 'dexscreener' | 'pg_snapshot';

export interface DiscoveryMarketQuote {
  priceUsd: number | null;
  marketCapUsd: number | null;
  liquidityUsd: number | null;
  volume5mUsd: number | null;
  volume1hUsd: number | null;
  source: DiscoveryQuoteSource;
  /** Epoch ms when the chosen quote was observed (Birdeye fetch time or PG snapshot ts). */
  quoteTsMs: number | null;
  pgSnapshotAgeMs: number | null;
  birdeyeTierInsufficient?: boolean;
  birdeyeErrorKind?: BirdeyeFetchErrorKind;
  /** True when PG is stale beyond coverageGapMinMs and neither Birdeye nor DexScreener had fresh data. */
  coverageGap?: boolean;
}

export interface DiscoveryQuotePickInput {
  pgRow: Pick<
    SnapshotCandidateRow,
    'price_usd' | 'market_cap_usd' | 'liquidity_usd' | 'volume_5m' | 'volume_1h' | 'ts'
  >;
  birdeye?: {
    priceUsd: number | null;
    marketCapUsd: number | null;
    liquidityUsd: number | null;
    volume5mUsd: number | null;
    volume1hUsd: number | null;
    fetchedAtMs: number;
    tierInsufficient?: boolean;
    errorKind?: BirdeyeFetchErrorKind;
  } | null;
  dexscreener?: {
    priceUsd: number | null;
    marketCapUsd: number | null;
    liquidityUsd: number | null;
    volume5mUsd: number | null;
    volume1hUsd: number | null;
    fetchedAtMs: number;
  } | null;
  nowMs: number;
  maxStaleMs: number;
  coverageGapMinMs: number;
}

function pgBaseline(input: DiscoveryQuotePickInput): DiscoveryMarketQuote {
  const pgTs = snapshotRowTsMs(input.pgRow.ts);
  const pgAge = snapshotPriceAgeMs(pgTs, input.nowMs);
  return {
    priceUsd: positive(input.pgRow.price_usd),
    marketCapUsd: positive(input.pgRow.market_cap_usd),
    liquidityUsd: positive(input.pgRow.liquidity_usd),
    volume5mUsd: positive(input.pgRow.volume_5m),
    volume1hUsd: positive(input.pgRow.volume_1h),
    source: 'pg_snapshot',
    quoteTsMs: pgTs,
    pgSnapshotAgeMs: pgAge,
  };
}

function positive(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function isFresh(tsMs: number | null | undefined, nowMs: number, maxStaleMs: number): boolean {
  if (tsMs == null || !Number.isFinite(tsMs)) return false;
  const maxStale = Number.isFinite(maxStaleMs) && maxStaleMs > 0 ? maxStaleMs : 0;
  if (maxStale <= 0) return true;
  const age = nowMs - tsMs;
  return age >= 0 && age <= maxStale;
}

/** Pure fallback pick: Birdeye (fresh) → DexScreener (fresh) → PG. Merges fields from best available layers. */
export function pickDiscoveryMarketQuote(input: DiscoveryQuotePickInput): DiscoveryMarketQuote {
  const base = pgBaseline(input);
  const { nowMs, maxStaleMs } = input;

  const b = input.birdeye;
  const d = input.dexscreener;

  const bFresh =
    b != null &&
    !b.tierInsufficient &&
    (b.priceUsd != null ||
      b.marketCapUsd != null ||
      b.liquidityUsd != null ||
      b.volume5mUsd != null ||
      b.volume1hUsd != null) &&
    isFresh(b.fetchedAtMs, nowMs, maxStaleMs);

  const dFresh =
    d != null &&
    (d.priceUsd != null ||
      d.marketCapUsd != null ||
      d.liquidityUsd != null ||
      d.volume5mUsd != null ||
      d.volume1hUsd != null) &&
    isFresh(d.fetchedAtMs, nowMs, maxStaleMs);

  let source: DiscoveryQuoteSource = 'pg_snapshot';
  let quoteTsMs = base.quoteTsMs;

  if (bFresh) {
    source = 'birdeye';
    quoteTsMs = b!.fetchedAtMs;
  } else if (dFresh) {
    source = 'dexscreener';
    quoteTsMs = d!.fetchedAtMs;
  }

  const pickPrice = (bFresh ? b!.priceUsd : null) ?? (dFresh ? d!.priceUsd : null) ?? base.priceUsd;
  const pickMcap =
    (bFresh ? b!.marketCapUsd : null) ?? (dFresh ? d!.marketCapUsd : null) ?? base.marketCapUsd;
  const pickLiq =
    (bFresh ? b!.liquidityUsd : null) ?? (dFresh ? d!.liquidityUsd : null) ?? base.liquidityUsd;
  const pickVol =
    (bFresh ? b!.volume5mUsd : null) ?? (dFresh ? d!.volume5mUsd : null) ?? base.volume5mUsd;
  const pickVol1h =
    (bFresh ? b!.volume1hUsd : null) ?? (dFresh ? d!.volume1hUsd : null) ?? base.volume1hUsd;

  const coverageGap =
    base.pgSnapshotAgeMs != null &&
    input.coverageGapMinMs > 0 &&
    base.pgSnapshotAgeMs > input.coverageGapMinMs &&
    !bFresh &&
    !dFresh;

  return {
    priceUsd: pickPrice,
    marketCapUsd: pickMcap,
    liquidityUsd: pickLiq,
    volume5mUsd: pickVol,
    volume1hUsd: pickVol1h,
    source,
    quoteTsMs,
    pgSnapshotAgeMs: base.pgSnapshotAgeMs,
    birdeyeTierInsufficient: b?.tierInsufficient === true || isBirdeyeTierInsufficient(b?.errorKind),
    birdeyeErrorKind: b?.errorKind,
    coverageGap,
  };
}

/** Absolute % divergence of a quote price vs the PG snapshot baseline. Infinity when PG is unusable. */
export function quotePgDivergencePct(
  quotePriceUsd: number | null | undefined,
  pgPriceUsd: number | null | undefined,
): number {
  const q = Number(quotePriceUsd);
  const p = Number(pgPriceUsd);
  if (!Number.isFinite(q) || !Number.isFinite(p) || q <= 0 || p <= 0) return Infinity;
  return (Math.abs(q - p) / p) * 100;
}

/**
 * Cross-source guard: should we REJECT adopting a non-PG quote price for an entry decision because it
 * diverges from the PG snapshot beyond `maxDivergencePct`? Only applies to external (birdeye/dexscreener)
 * quotes with both prices usable. Prevents phantom dips from a bad quote on fragmented multi-pool liquidity.
 */
export function isDiscoveryQuoteDivergent(
  quote: Pick<DiscoveryMarketQuote, 'source' | 'priceUsd'> | null | undefined,
  pgPriceUsd: number | null | undefined,
  maxDivergencePct: number,
): boolean {
  if (quote == null || quote.source === 'pg_snapshot') return false;
  if (!(maxDivergencePct > 0)) return false;
  const q = Number(quote.priceUsd);
  const p = Number(pgPriceUsd);
  if (!Number.isFinite(q) || !Number.isFinite(p) || q <= 0 || p <= 0) return false;
  return quotePgDivergencePct(q, p) > maxDivergencePct;
}

/** True when discovery eval resolved price/mcap/liq/vol from fresh Birdeye or DexScreener (not PG). */
export function isFreshExternalDiscoveryQuote(
  quote: DiscoveryMarketQuote | null | undefined,
  maxStaleMs: number,
  nowMs: number = Date.now(),
): boolean {
  if (quote == null || quote.source === 'pg_snapshot') return false;
  if (quote.birdeyeTierInsufficient) return false;
  if (quote.coverageGap) return false;
  return isFresh(quote.quoteTsMs, nowMs, maxStaleMs);
}

export interface DexScreenerMarketSnapshot {
  priceUsd: number | null;
  marketCapUsd: number | null;
  liquidityUsd: number | null;
  volume5mUsd: number | null;
  volume1hUsd: number | null;
  fetchedAtMs: number;
}

const dsCache = new Map<string, { at: number; val: DexScreenerMarketSnapshot | null }>();

/** Test-only. */
export function __resetDexScreenerMarketCacheForTests(): void {
  dsCache.clear();
}

function pickBestSolanaPair(pairs: unknown[], mint: string): Record<string, unknown> | null {
  if (!Array.isArray(pairs) || pairs.length === 0) return null;
  const relevant = pairs.filter((p) => {
    const row = p as { chainId?: string; baseToken?: { address?: string }; quoteToken?: { address?: string } };
    if (row.chainId && row.chainId !== 'solana') return false;
    const base = row.baseToken?.address ?? '';
    const quote = row.quoteToken?.address ?? '';
    return base === mint || quote === mint;
  });
  const pool = relevant.length > 0 ? relevant : pairs;
  let best: Record<string, unknown> | null = null;
  let bestLiq = -1;
  for (const p of pool) {
    const row = p as { liquidity?: { usd?: number } };
    const liq = Number(row.liquidity?.usd ?? 0);
    if (liq > bestLiq) {
      bestLiq = liq;
      best = p as Record<string, unknown>;
    }
  }
  return best;
}

export function parseDexScreenerPair(pair: Record<string, unknown>): DexScreenerMarketSnapshot {
  const priceUsd = positive(pair.priceUsd);
  const marketCapUsd = positive((pair as { marketCap?: number }).marketCap ?? (pair as { fdv?: number }).fdv);
  const liquidityUsd = positive((pair.liquidity as { usd?: number } | undefined)?.usd);
  const volume = pair.volume as { m5?: number; h1?: number } | undefined;
  const volume5mUsd = positive(volume?.m5);
  const volume1hUsd = positive(volume?.h1);
  return {
    priceUsd,
    marketCapUsd,
    liquidityUsd,
    volume5mUsd,
    volume1hUsd,
    fetchedAtMs: Date.now(),
  };
}

export async function fetchDexScreenerMarketSnapshot(
  mint: string,
  opts?: { fetchImpl?: typeof fetch; cacheTtlMs?: number; nowMs?: number },
): Promise<DexScreenerMarketSnapshot | null> {
  if (!mint) return null;
  const now = opts?.nowMs ?? Date.now();
  const ttl = opts?.cacheTtlMs ?? dexQuoteCacheTtlMs();

  if (isDexQuoteCacheEnabled()) {
    return fetchDexScreenerQuoteViaCache(mint, {
      fetchImpl: opts?.fetchImpl,
      cacheTtlMs: ttl,
      nowMs: now,
    });
  }

  const cached = dsCache.get(mint);
  if (cached && now - cached.at < ttl) return cached.val;

  const doFetch = opts?.fetchImpl ?? fetch;
  try {
    const res = await doFetch(
      `https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(mint)}`,
      { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8_000) },
    );
    if (!res.ok) {
      dsCache.set(mint, { at: now, val: null });
      return null;
    }
    const j = (await res.json()) as { pairs?: unknown[] };
    const best = pickBestSolanaPair(j.pairs ?? [], mint);
    if (!best) {
      dsCache.set(mint, { at: now, val: null });
      return null;
    }
    const snap = { ...parseDexScreenerPair(best), fetchedAtMs: now };
    dsCache.set(mint, { at: now, val: snap });
    return snap;
  } catch {
    dsCache.set(mint, { at: now, val: null });
    return null;
  }
}

export interface ResolveDiscoveryMarketQuoteOpts {
  enabled: boolean;
  mint: string;
  pgRow: SnapshotCandidateRow;
  apiKey?: string;
  birdeyeTtlMs: number;
  birdeyeMaxStaleMs: number;
  coverageGapMinMs: number;
  nowMs?: number;
  fetchImpl?: typeof fetch;
}

/** Async orchestrator: Birdeye (optional) → DexScreener → PG via pure fallback pick. */
export async function resolveDiscoveryMarketQuote(
  opts: ResolveDiscoveryMarketQuoteOpts,
): Promise<DiscoveryMarketQuote> {
  const nowMs = opts.nowMs ?? Date.now();

  const birdeye = opts.enabled
    ? await resolveBirdeyeMarketQuote(opts.mint, {
        apiKey: opts.apiKey,
        ttlMs: opts.birdeyeTtlMs,
        fetchImpl: opts.fetchImpl,
        nowMs,
      })
    : null;

  let dexscreener: DexScreenerMarketSnapshot | null = null;
  const birdeyeUsable =
    birdeye != null &&
    !birdeye.tierInsufficient &&
    (birdeye.priceUsd != null ||
      birdeye.marketCapUsd != null ||
      birdeye.liquidityUsd != null ||
      birdeye.volume5mUsd != null ||
      birdeye.volume1hUsd != null);

  if (!birdeyeUsable) {
    dexscreener = await fetchDexScreenerMarketSnapshot(opts.mint, {
      fetchImpl: opts.fetchImpl,
      nowMs,
      cacheTtlMs: opts.birdeyeTtlMs,
    });
  }

  return pickDiscoveryMarketQuote({
    pgRow: opts.pgRow,
    birdeye: birdeye
      ? {
          priceUsd: birdeye.priceUsd,
          marketCapUsd: birdeye.marketCapUsd,
          liquidityUsd: birdeye.liquidityUsd,
          volume5mUsd: birdeye.volume5mUsd,
          volume1hUsd: birdeye.volume1hUsd,
          fetchedAtMs: birdeye.fetchedAtMs,
          tierInsufficient: birdeye.tierInsufficient,
          errorKind: birdeye.errorKind,
        }
      : null,
    dexscreener,
    nowMs,
    maxStaleMs: opts.birdeyeMaxStaleMs,
    coverageGapMinMs: opts.coverageGapMinMs,
  });
}

export function buildBirdeyeCoverageGapEvent(args: {
  mint: string;
  lane: string;
  pgSnapshotAgeMs: number;
  coverageGapMinMs: number;
  source: DiscoveryQuoteSource;
}): Record<string, unknown> {
  return {
    kind: 'birdeye_coverage_gap',
    mint: args.mint,
    lane: args.lane,
    reason: 'birdeye_coverage_gap',
    pgSnapshotAgeMs: args.pgSnapshotAgeMs,
    coverageGapMinMs: args.coverageGapMinMs,
    resolvedSource: args.source,
  };
}

export function buildBirdeyeTierInsufficientEvent(args: {
  mint: string;
  lane: string;
  errorKind?: BirdeyeFetchErrorKind;
  message?: string;
}): Record<string, unknown> {
  return {
    kind: 'birdeye_tier_insufficient',
    mint: args.mint,
    lane: args.lane,
    reason: 'birdeye_tier_insufficient',
    errorKind: args.errorKind ?? 'quota',
    message: args.message,
  };
}
