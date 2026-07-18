import type { CopyTraderConfig } from './config.js';
import { copyTraderLiveOscarBridge } from './live-bridge.js';
import { liveFetchBuyQuote } from '../live/jupiter.js';
import { getSolUsd } from '../papertrader/pricing.js';
import { entryDipMaxPriceUsd } from './entry-probe.js';
import type { PendingBuy } from './state.js';
import { findPendingBuy } from './pending-buy-retry.js';

/** Implied token USD price from a Jupiter buy quote (SOL → memecoin). */
export function impliedBuyPriceUsdFromQuote(
  quoteResponse: Record<string, unknown>,
  solUsd: number,
): number {
  const outRaw = quoteResponse.outAmount;
  const inRaw = quoteResponse.inAmount;
  const outN = typeof outRaw === 'string' ? Number(outRaw) : Number(outRaw ?? 0);
  const inN = typeof inRaw === 'string' ? Number(inRaw) : Number(inRaw ?? 0);
  if (!(outN > 0) || !(inN > 0) || !(solUsd > 0)) return 0;
  return ((inN / 1e9) * solUsd) / (outN / 1e6);
}

export type EntryDipEvalPrice = {
  priceUsd: number;
  source: 'jupiter_quote' | 'dex';
  quoteUnavailable: boolean;
  /** True when eval reused cached Jupiter price within min-interval window. */
  quoteCached?: boolean;
};

export type EntryDipQuoteCache = {
  lastTs?: number;
  lastPriceUsd?: number;
};

/** Returns cached eval price when within `entryDipJupiterMinIntervalMs`; else null. */
export function entryDipQuoteCacheHit(
  cfg: CopyTraderConfig,
  cache: EntryDipQuoteCache | undefined,
  nowMs = Date.now(),
): number | null {
  const minIv = cfg.entryDipJupiterMinIntervalMs;
  if (minIv <= 0 || cache?.lastTs == null || !(cache.lastPriceUsd != null && cache.lastPriceUsd > 0)) {
    return null;
  }
  if (nowMs - cache.lastTs < minIv) return cache.lastPriceUsd;
  return null;
}

/** Live/dry_run: gate on Jupiter quote price; paper: Dex spot. */
export async function resolveEntryDipEvalPrice(args: {
  cfg: CopyTraderConfig;
  mint: string;
  dipSizeUsd: number;
  dexPriceUsd: number;
  quoteCache?: EntryDipQuoteCache;
  nowMs?: number;
}): Promise<EntryDipEvalPrice> {
  const { cfg, mint, dipSizeUsd, dexPriceUsd, quoteCache } = args;
  const nowMs = args.nowMs ?? Date.now();
  if (cfg.executionMode === 'paper' || !cfg.entryDipUseJupiter) {
    return { priceUsd: dexPriceUsd, source: 'dex', quoteUnavailable: false };
  }

  const cached = entryDipQuoteCacheHit(cfg, quoteCache, nowMs);
  if (cached != null) {
    return { priceUsd: cached, source: 'jupiter_quote', quoteUnavailable: false, quoteCached: true };
  }

  const solUsd = getSolUsd();
  const quote = await liveFetchBuyQuote({
    cfg: copyTraderLiveOscarBridge(cfg),
    outputMint: mint,
    sizeUsd: dipSizeUsd,
    solUsd,
  });
  if (!quote) {
    return { priceUsd: 0, source: 'jupiter_quote', quoteUnavailable: true };
  }
  const priceUsd = impliedBuyPriceUsdFromQuote(quote.quoteResponse, solUsd);
  if (!(priceUsd > 0)) {
    return { priceUsd: 0, source: 'jupiter_quote', quoteUnavailable: true };
  }
  if (quoteCache) {
    quoteCache.lastTs = nowMs;
    quoteCache.lastPriceUsd = priceUsd;
  }
  return { priceUsd, source: 'jupiter_quote', quoteUnavailable: false };
}

export function resetEntryDipPassStreak(state: { pendingBuys: PendingBuy[] }, pendingId: string): void {
  const row = findPendingBuy(state, pendingId);
  if (row) row.dipPassStreak = 0;
}

export function bumpEntryDipPassStreak(state: { pendingBuys: PendingBuy[] }, pendingId: string): number {
  const row = findPendingBuy(state, pendingId);
  if (!row) return 0;
  const next = (row.dipPassStreak ?? 0) + 1;
  row.dipPassStreak = next;
  return next;
}

export function entryDipConfirmReason(
  cfg: CopyTraderConfig,
  streak: number,
  priceUsd: number,
  leaderPriceUsd: number,
  probeEntryPriceUsd?: number,
): string {
  const target = entryDipMaxPriceUsd(cfg, leaderPriceUsd, probeEntryPriceUsd);
  return `dip_confirm_ticks ${streak}/${cfg.entryDipConfirmTicks} price=${priceUsd.toExponential(4)} target<=${target.toExponential(4)}`;
}
