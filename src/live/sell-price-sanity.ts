/**
 * Live sell price sanity — reject ghost Jupiter/PG quotes before token-raw sizing (DdPrHY RCA).
 */

/** Absolute floor — reject near-zero quotes that explode token raw (NEST RCA). */
export const LIVE_SELL_MIN_PRICE_USD = 1e-5;

/** Max |quote − reference| / reference before aborting sell sizing. */
export const LIVE_SELL_GHOST_QUOTE_MAX_DEVIATION_FRAC = 0.25;

/** Partial sells never exceed this fraction of on-chain SPL balance (unless sell_full). */
export const LIVE_PARTIAL_SELL_MAX_CHAIN_FRACTION = 0.5;

export function liveSellPriceUsdSane(priceUsdPerToken: number): boolean {
  return Number.isFinite(priceUsdPerToken) && priceUsdPerToken >= LIVE_SELL_MIN_PRICE_USD;
}

export function resolveLiveSellReferencePriceUsd(args: {
  lastObservedPriceUsd?: number | null;
  avgEntryMarket?: number;
  avgEntry?: number;
}): number | null {
  const { lastObservedPriceUsd, avgEntryMarket, avgEntry } = args;
  if (lastObservedPriceUsd != null && lastObservedPriceUsd > 0 && Number.isFinite(lastObservedPriceUsd)) {
    return lastObservedPriceUsd;
  }
  if (avgEntryMarket != null && avgEntryMarket > 0 && Number.isFinite(avgEntryMarket)) {
    return avgEntryMarket;
  }
  if (avgEntry != null && avgEntry > 0 && Number.isFinite(avgEntry)) {
    return avgEntry;
  }
  return null;
}

export type LiveSellQuoteSanityResult =
  | { ok: true }
  | {
      ok: false;
      reason: 'ghost_price_quote_rejected';
      quotePriceUsd: number;
      referencePriceUsd: number;
      deviationFrac: number;
    };

export function liveSellQuotePriceSanity(args: {
  quotePriceUsd: number;
  referencePriceUsd?: number | null;
  maxDeviationFrac?: number;
}): LiveSellQuoteSanityResult {
  const { quotePriceUsd, referencePriceUsd } = args;
  const maxDev = args.maxDeviationFrac ?? LIVE_SELL_GHOST_QUOTE_MAX_DEVIATION_FRAC;
  if (!liveSellPriceUsdSane(quotePriceUsd)) {
    return {
      ok: false,
      reason: 'ghost_price_quote_rejected',
      quotePriceUsd,
      referencePriceUsd: referencePriceUsd ?? 0,
      deviationFrac: Number.POSITIVE_INFINITY,
    };
  }
  if (!(referencePriceUsd != null && referencePriceUsd > 0 && Number.isFinite(referencePriceUsd))) {
    return { ok: true };
  }
  const deviationFrac = Math.abs(quotePriceUsd - referencePriceUsd) / referencePriceUsd;
  if (deviationFrac > maxDev + 1e-12) {
    return {
      ok: false,
      reason: 'ghost_price_quote_rejected',
      quotePriceUsd,
      referencePriceUsd,
      deviationFrac,
    };
  }
  return { ok: true };
}

export function fractionOfTokenRaw(chainAmt: bigint, fraction: number): bigint {
  if (fraction >= 1) return chainAmt;
  if (!(fraction > 0) || chainAmt <= 0n) return 0n;
  const scaled = BigInt(Math.max(1, Math.round(fraction * 10_000)));
  return (chainAmt * scaled) / 10_000n;
}

export function capPartialSellTokenRaw(args: {
  intentKind: 'sell_partial' | 'sell_full';
  computedRaw: bigint;
  chainAmt: bigint;
  maxPartialChainFraction?: number;
}): { raw: bigint; cappedByPartialMax: boolean } {
  if (args.intentKind === 'sell_full') {
    return { raw: args.chainAmt, cappedByPartialMax: false };
  }
  const maxFrac = args.maxPartialChainFraction ?? LIVE_PARTIAL_SELL_MAX_CHAIN_FRACTION;
  const maxRaw = fractionOfTokenRaw(args.chainAmt, maxFrac);
  if (maxRaw <= 0n) {
    return { raw: 0n, cappedByPartialMax: false };
  }
  if (args.computedRaw <= maxRaw) {
    return { raw: args.computedRaw, cappedByPartialMax: false };
  }
  return { raw: maxRaw, cappedByPartialMax: true };
}

/** True when raw MTM deviates sharply from prior observed and clamp corrected it (ghost tick). */
export function isGhostMtmExitTick(args: {
  previousObservedUsd: number;
  rawUsd: number;
  clampedUsd: number;
  maxDeviationFrac?: number;
}): boolean {
  const maxDev = args.maxDeviationFrac ?? LIVE_SELL_GHOST_QUOTE_MAX_DEVIATION_FRAC;
  const { previousObservedUsd, rawUsd, clampedUsd } = args;
  if (!(previousObservedUsd > 0) || !(rawUsd > 0) || !(clampedUsd > 0)) return false;
  const rawDev = Math.abs(rawUsd - previousObservedUsd) / previousObservedUsd;
  if (rawDev <= maxDev + 1e-12) return false;
  const clampCorrected =
    Math.abs(clampedUsd - rawUsd) / Math.max(rawUsd, 1e-18) > 0.01;
  return clampCorrected;
}

/** Journal anchor: prefer exit-clamped MTM when clamp materially changed the tick. */
export function resolveObservedPriceUsdForJournal(rawUsd: number, exitMtmUsd: number): number {
  if (!(rawUsd > 0)) return exitMtmUsd > 0 ? exitMtmUsd : 0;
  if (!(exitMtmUsd > 0)) return rawUsd;
  if (Math.abs(exitMtmUsd - rawUsd) / Math.max(rawUsd, 1e-18) > 0.002) return exitMtmUsd;
  return rawUsd;
}
