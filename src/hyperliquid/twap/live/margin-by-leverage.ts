import type { HlTwapLiveConfig } from './config.js';

/** Collateral tiers keyed by HL effective max leverage bucket. */
export type MarginByLevTiers = {
  /** effectiveLev ≤ 3 */
  lev3Usd: number;
  /** effectiveLev 4–5 */
  lev5Usd: number;
  /** effectiveLev ≥ 6 (7× default tier) */
  lev7Usd: number;
};

export type MarginByLevInput = Pick<
  HlTwapLiveConfig,
  'notionalUsd' | 'marginLev3Usd' | 'marginLev5Usd' | 'marginLev7Usd' | 'leverage'
>;

/** Effective cross leverage: min(HL coin max, requested). */
export function effectiveLeverage(maxLev: number | undefined, requestedLev: number): number {
  if (maxLev == null || maxLev <= 0) return requestedLev;
  return Math.min(requestedLev, maxLev);
}

export function marginTiersFromConfig(cfg: MarginByLevInput): MarginByLevTiers {
  return {
    lev3Usd: cfg.marginLev3Usd,
    lev5Usd: cfg.marginLev5Usd,
    lev7Usd: cfg.marginLev7Usd,
  };
}

/**
 * Entry collateral (USD) from effective leverage tier.
 * - ≤3× → lev3 (default $1500 → gross $4500)
 * - 4–5× → lev5 (default $1000); 4× uses the 5× tier (between 3× and 7× buckets)
 * - ≥6× → lev7 (default $800)
 */
export function marginUsdForMaxLev(effectiveLev: number, tiers: MarginByLevTiers): number {
  if (effectiveLev <= 3) return tiers.lev3Usd;
  if (effectiveLev <= 5) return tiers.lev5Usd;
  return tiers.lev7Usd;
}

/** Gross notional for a new open: margin × effective leverage. */
export function openGrossUsdForMaxLev(effectiveLev: number, tiers: MarginByLevTiers): number {
  return marginUsdForMaxLev(effectiveLev, tiers) * effectiveLev;
}

export function createLeverageForCoin(
  requestedLev: number,
  maxLevByCoin?: Map<string, number>,
): (coin: string) => number {
  return (coin: string) => effectiveLeverage(maxLevByCoin?.get(coin), requestedLev);
}

export function openMarginUsdForCoin(
  coin: string,
  cfg: MarginByLevInput,
  leverageForCoin: (coin: string) => number,
): number {
  return marginUsdForMaxLev(leverageForCoin(coin), marginTiersFromConfig(cfg));
}

export function openGrossUsdForCoin(
  coin: string,
  cfg: MarginByLevInput,
  leverageForCoin: (coin: string) => number,
): number {
  const lev = leverageForCoin(coin);
  return openGrossUsdForMaxLev(lev, marginTiersFromConfig(cfg));
}

export function formatMarginByLevStartup(cfg: MarginByLevInput): string {
  const tiers = marginTiersFromConfig(cfg);
  return (
    `margin_by_lev 3x=$${tiers.lev3Usd} 5x=$${tiers.lev5Usd} 7x=$${tiers.lev7Usd}` +
    ` (base_notional=$${cfg.notionalUsd})`
  );
}
