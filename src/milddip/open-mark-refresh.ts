/**
 * Non-blocking price refresh for open bags.
 *
 * Exit marks read the in-process ring and must never await HTTP. Stream swaps
 * should feed the ring; when they go quiet (EtxCL9: 72 marks frozen at entry
 * through a +mcap spike), this refresher writes Dex prices into the ring in
 * the background with a hard in-flight + per-mint gap cap so we do not rebuild
 * the 120 RPM gate queue.
 */
import { fetchDexScreenerPairDetails } from '../papertrader/pricing/dexscreener-quote-cache.js';
import { noteOpenMarkMetrics } from './open-mark-metrics.js';
import { mildDipPriceRing } from './price-ring.js';

const lastAttemptMs = new Map<string, number>();
const inFlight = new Set<string>();

export function __resetOpenMarkRefreshForTests(): void {
  lastAttemptMs.clear();
  inFlight.clear();
}

export function openMarkRefreshInFlightCount(): number {
  return inFlight.size;
}

/**
 * Fire-and-forget Dex quote → price ring. Safe to call every mark pass.
 */
export function requestOpenMarkRefresh(args: {
  mint: string;
  nowMs: number;
  /** Min gap between attempts per mint (default 8s). */
  minGapMs: number;
  /** Global cap on concurrent Dex refreshes (default 3). */
  maxInFlight: number;
  allowedDexIds: string[];
  cacheTtlMs: number;
}): boolean {
  const mint = args.mint;
  if (!mint || mint.length < 32) return false;
  const minGap = args.minGapMs > 0 ? args.minGapMs : 8_000;
  const maxInFlight = args.maxInFlight > 0 ? args.maxInFlight : 3;
  if (inFlight.has(mint)) return false;
  if (inFlight.size >= maxInFlight) return false;
  const last = lastAttemptMs.get(mint) ?? 0;
  if (args.nowMs - last < minGap) return false;

  lastAttemptMs.set(mint, args.nowMs);
  inFlight.add(mint);
  const cacheTtl = args.cacheTtlMs > 0 ? args.cacheTtlMs : 15_000;

  // Self-rate-limited (gap + maxInFlight) — must not sit behind the discovery
  // Dex gate (EtxCL9: gate was ~11m ahead → refresh never landed, peak frozen).
  // 1.11.820 — read the batch-warmed cache instead of forcing a fetch; the
  // caller prefetches the whole open book in one request per 30 mints.
  void fetchDexScreenerPairDetails(mint, {
    nowMs: args.nowMs,
    allowedDexIds: args.allowedDexIds,
    cacheTtlMs: cacheTtl,
    bypassGate: true,
  })
    .then((details) => {
      const now = Date.now();
      const px = details?.priceUsd;
      if (px != null && px > 0) {
        mildDipPriceRing.note(mint, px, {
          tsMs: now,
          source: 'dex',
        });
      }
      if (details) {
        noteOpenMarkMetrics(mint, {
          tsMs: now,
          pc5mPct: details.priceChangeM5Pct,
          volume5mUsd: details.volume5mUsd,
          liquidityUsd: details.liquidityUsd,
          dexId: details.dexId ?? null,
        });
      }
    })
    .catch(() => {
      /* ignore — next gap will retry */
    })
    .finally(() => {
      inFlight.delete(mint);
    });

  return true;
}
