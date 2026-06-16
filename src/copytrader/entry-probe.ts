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

/** True when staged entry uses mid tier ($300+$300) instead of full positionUsd split. */
export function isMidMcapEntryTier(cfg: CopyTraderConfig, marketCapUsd: number | undefined): boolean {
  if (!(marketCapUsd != null && marketCapUsd > 0)) return false;
  if (cfg.entryFullMcapUsd <= 0) return false;
  return marketCapUsd < cfg.entryFullMcapUsd;
}

/** Planned total entry deploy (probe + dip) for this mcap. */
export function entryTargetUsd(cfg: CopyTraderConfig, marketCapUsd?: number): number {
  if (isMidMcapEntryTier(cfg, marketCapUsd)) return cfg.entryMidPositionUsd;
  return cfg.positionUsd;
}

export function entryProbeSizeUsd(cfg: CopyTraderConfig, marketCapUsd?: number): number {
  const total = entryTargetUsd(cfg, marketCapUsd);
  if (!usesSplitEntryProbe(cfg)) return total;
  if (isMidMcapEntryTier(cfg, marketCapUsd)) {
    const leg = roundUsd(cfg.entryMidLegUsd);
    return leg > 0 && leg < total ? leg : roundUsd(total / 2);
  }
  const probe = roundUsd(total * cfg.entryProbeFraction);
  if (probe <= 0 || probe >= total) return total;
  return probe;
}

export function entryDipSizeUsd(cfg: CopyTraderConfig, marketCapUsd?: number): number {
  const total = entryTargetUsd(cfg, marketCapUsd);
  if (usesDipOnlyEntry(cfg)) return total;
  if (!usesSplitEntryProbe(cfg)) return 0;
  if (isMidMcapEntryTier(cfg, marketCapUsd)) {
    const leg = roundUsd(cfg.entryMidLegUsd);
    const dip = leg > 0 ? leg : roundUsd(total / 2);
    return dip > 0 && dip < total ? dip : 0;
  }
  const dip = roundUsd(total - entryProbeSizeUsd(cfg, marketCapUsd));
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

/** Refresh pending entry leg sizes when dex mcap is known (mid $300+$300 vs full $500+$500). */
export function syncEntryPendingSizing(
  cfg: CopyTraderConfig,
  pending: {
    kind: 'entry' | 'add';
    entryLeg?: EntryLeg;
    sizeUsd: number;
    entryTargetUsd?: number;
    entryMcapUsd?: number;
  },
  marketCapUsd?: number,
): void {
  if (pending.kind !== 'entry' || !(marketCapUsd != null && marketCapUsd > 0)) return;
  pending.entryMcapUsd = marketCapUsd;
  pending.entryTargetUsd = entryTargetUsd(cfg, marketCapUsd);
  if (pending.entryLeg === 'dip' || usesDipOnlyEntry(cfg)) {
    pending.sizeUsd = entryDipSizeUsd(cfg, marketCapUsd);
    return;
  }
  pending.sizeUsd = usesSplitEntryProbe(cfg)
    ? entryProbeSizeUsd(cfg, marketCapUsd)
    : entryTargetUsd(cfg, marketCapUsd);
}
