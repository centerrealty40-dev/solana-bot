import type { CopyTraderConfig } from './config.js';

/** Split entry: probe at leader+premium, remainder on dip below leader. */
export function usesSplitEntryProbe(cfg: CopyTraderConfig): boolean {
  return cfg.entryProbeFraction > 0 && cfg.entryProbeFraction < 0.999;
}

export function usesDipOnlyEntry(cfg: CopyTraderConfig): boolean {
  return cfg.entryProbeFraction <= 0 && cfg.entryDipDiscountPct > 0;
}

export function roundUsd(n: number): number {
  return Math.round(n * 100) / 100;
}

export function entryProbeSizeUsd(cfg: CopyTraderConfig): number {
  const total = cfg.positionUsd;
  if (!usesSplitEntryProbe(cfg)) return total;
  const probe = roundUsd(total * cfg.entryProbeFraction);
  if (probe <= 0 || probe >= total) return total;
  return probe;
}

export function entryDipSizeUsd(cfg: CopyTraderConfig): number {
  const total = cfg.positionUsd;
  if (usesDipOnlyEntry(cfg)) return total;
  if (!usesSplitEntryProbe(cfg)) return 0;
  const dip = roundUsd(total - entryProbeSizeUsd(cfg));
  return dip > 0 ? dip : 0;
}

export function leaderDipTargetPx(leaderPriceUsd: number, dipDiscountPct: number): number {
  if (!(leaderPriceUsd > 0) || !(dipDiscountPct > 0)) return 0;
  return leaderPriceUsd * (1 - dipDiscountPct / 100);
}
