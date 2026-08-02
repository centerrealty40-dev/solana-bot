/**
 * Market context the copy gates need at the moment of a leader buy.
 *
 * These fields (pair age, 5m buy/sell counts, 5m price change) are not carried
 * by the shared DexScreener quote cache — that cache is also written by legacy
 * producers that omit them — so this module always parses a live pair payload
 * and keeps its own short-lived cache. The global DexScreener rate limiter is
 * still honoured by `fetchDexScreenerPairDetails`.
 */
import { fetchDexScreenerPairDetails } from '../papertrader/pricing/dexscreener-quote-cache.js';

export type CopyEntryContext = {
  mint: string;
  pairAgeHours: number | null;
  buys5m: number | null;
  sells5m: number | null;
  /** buys5m / sells5m, null when either side is unknown. */
  buySellRatio5m: number | null;
  priceChange5mPct: number | null;
  liquidityUsd: number | null;
  marketCapUsd: number | null;
  volume5mUsd: number | null;
  volume1hUsd: number | null;
  fetchedAtMs: number;
};

const cache = new Map<string, { at: number; val: CopyEntryContext | null }>();

function contextTtlMs(): number {
  const raw = Number(process.env.COPY_TRADER_ENTRY_CONTEXT_TTL_MS);
  if (Number.isFinite(raw) && raw >= 5_000 && raw <= 600_000) return Math.trunc(raw);
  return 60_000;
}

export function __resetCopyEntryContextCacheForTests(): void {
  cache.clear();
}

export async function fetchCopyEntryContext(
  mint: string,
  nowMs = Date.now(),
): Promise<CopyEntryContext | null> {
  if (!mint) return null;
  const ttl = contextTtlMs();
  const mem = cache.get(mint);
  if (mem && nowMs - mem.at < ttl) return mem.val;

  let val: CopyEntryContext | null = null;
  try {
    const details = await fetchDexScreenerPairDetails(mint, { bypassCache: true, nowMs });
    if (details) {
      const buys = details.buys5m;
      const sells = details.sells5m;
      val = {
        mint,
        pairAgeHours:
          details.pairCreatedAtMs != null && details.pairCreatedAtMs > 0
            ? Math.max(0, (nowMs - details.pairCreatedAtMs) / 3_600_000)
            : null,
        buys5m: buys,
        sells5m: sells,
        buySellRatio5m: buys != null && sells != null ? buys / Math.max(1, sells) : null,
        priceChange5mPct: details.priceChangeM5Pct,
        liquidityUsd: details.liquidityUsd,
        marketCapUsd: details.marketCapUsd,
        volume5mUsd: details.volume5mUsd,
        volume1hUsd: details.volume1hUsd,
        fetchedAtMs: details.fetchedAtMs,
      };
    }
  } catch {
    val = null;
  }

  cache.set(mint, { at: nowMs, val });
  return val;
}
