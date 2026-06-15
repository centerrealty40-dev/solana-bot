import type { CopyTraderConfig } from './config.js';
import type { EntryLeg } from './state.js';

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

/** Dip cap: leader −discount% and, after probe fill, at least entryDipVsProbePct below our probe entry. */
export function entryDipMaxPriceUsd(
  cfg: CopyTraderConfig,
  leaderPriceUsd: number,
  probeEntryPriceUsd?: number,
): number {
  const fromLeader = leaderDipTargetPx(leaderPriceUsd, cfg.entryDipDiscountPct);
  if (!(fromLeader > 0)) return 0;
  const probePx = probeEntryPriceUsd ?? 0;
  if (!(probePx > 0) || !(cfg.entryDipVsProbePct > 0)) return fromLeader;
  const fromProbe = probePx * (1 - cfg.entryDipVsProbePct / 100);
  return Math.min(fromLeader, fromProbe);
}

/** Ms before first probe/full entry attempt after leader buy (dip leg schedules at 0 when probe fills). */
export function entryScheduleDelayMs(
  cfg: CopyTraderConfig,
  args: { kind: 'entry' | 'add'; entryLeg?: EntryLeg },
): number {
  if (args.kind === 'entry' && args.entryLeg === 'probe') return cfg.entryProbeBuyDelayMs;
  if (args.kind === 'entry' && args.entryLeg === 'dip') return 0;
  return cfg.buyDelayMs;
}

export function isEntryProbePending(args: {
  kind: 'entry' | 'add';
  entryLeg?: EntryLeg;
  usesDipOnly: boolean;
}): boolean {
  return args.kind === 'entry' && args.entryLeg !== 'dip' && !args.usesDipOnly;
}
