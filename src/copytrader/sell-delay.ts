/**
 * Mirror-exit sell delay: optional wait only when the mark has already dropped
 * past `sellDelaySkipMaxDropPct` vs entry (else sell immediately).
 */

export type SellDelayCfg = {
  sellDelayMinMs: number;
  sellDelayMaxMs: number;
  /** Skip delay when drop from entry ≤ this % (inclusive). **0** = never skip. */
  sellDelaySkipMaxDropPct: number;
};

export function randomSellDelayMs(cfg: Pick<SellDelayCfg, 'sellDelayMinMs' | 'sellDelayMaxMs'>): number {
  const span = cfg.sellDelayMaxMs - cfg.sellDelayMinMs;
  if (span <= 0) return cfg.sellDelayMinMs;
  return cfg.sellDelayMinMs + Math.floor(Math.random() * (span + 1));
}

export type ResolveSellDelayArgs = {
  entryPriceUsd?: number | null;
  currentPriceUsd?: number | null;
  /** Fallback ref when we have no copy entry (wallet-only position). */
  leaderSellPriceUsd?: number | null;
};

export type ResolveSellDelayResult = {
  delayMs: number;
  /** (1 - mark/ref)*100; null when prices unavailable. */
  dropPct: number | null;
  /** True when delay collapsed to 0 because drop ≤ threshold (or prices missing with skip on). */
  skipped: boolean;
};

/**
 * If `sellDelaySkipMaxDropPct` > 0:
 * - drop ≤ threshold → delay 0
 * - drop > threshold → random in [min, max]
 * - prices missing → delay 0 (do not speculate on a bounce we cannot measure)
 *
 * If skip is off (0): always use [min, max] (legacy).
 */
export function resolveSellDelayMs(
  cfg: SellDelayCfg,
  args: ResolveSellDelayArgs,
): ResolveSellDelayResult {
  const base = randomSellDelayMs(cfg);
  if (!(cfg.sellDelaySkipMaxDropPct > 0)) {
    return { delayMs: base, dropPct: null, skipped: false };
  }

  const ref =
    args.entryPriceUsd != null && args.entryPriceUsd > 0
      ? args.entryPriceUsd
      : args.leaderSellPriceUsd != null && args.leaderSellPriceUsd > 0
        ? args.leaderSellPriceUsd
        : null;
  const mark = args.currentPriceUsd;
  if (ref == null || mark == null || !(mark > 0)) {
    return { delayMs: 0, dropPct: null, skipped: true };
  }

  const dropPct = (1 - mark / ref) * 100;
  if (dropPct <= cfg.sellDelaySkipMaxDropPct + 1e-9) {
    return { delayMs: 0, dropPct, skipped: true };
  }
  return { delayMs: base, dropPct, skipped: false };
}
