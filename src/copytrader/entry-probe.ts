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

/**
 * Fixed clip for the low-mcap band (e.g. $30k–$150k → $50), takes priority over
 * leader-mirror sizing.
 */
export function isLowMcapEntryTier(cfg: CopyTraderConfig, marketCapUsd: number | undefined): boolean {
  if (!(cfg.entryLowPositionUsd > 0) || !(cfg.entryLowMcapMaxUsd > 0)) return false;
  if (!(marketCapUsd != null && marketCapUsd > 0)) return false;
  const min = cfg.entryLowMcapMinUsd > 0 ? cfg.entryLowMcapMinUsd : 0;
  return marketCapUsd + 1e-9 >= min && marketCapUsd + 1e-9 < cfg.entryLowMcapMaxUsd;
}

export function usesInitialLeaderMirror(cfg: CopyTraderConfig): boolean {
  return cfg.initialMirrorRatio > 0;
}

/** Initial entry notional from leader buy USD when mirror ratio is enabled. */
export function leaderInitialEntryUsd(cfg: CopyTraderConfig, leaderBuyUsd: number): number {
  if (!(leaderBuyUsd > 0) || !usesInitialLeaderMirror(cfg)) return 0;
  const mirrored = leaderBuyUsd * cfg.initialMirrorRatio;
  const floored = cfg.minMirrorEntryUsd > 0 ? Math.max(cfg.minMirrorEntryUsd, mirrored) : mirrored;
  return roundUsd(floored);
}

/** Planned total entry deploy (probe + dip) for this mcap / leader buy. */
export function entryTargetUsd(
  cfg: CopyTraderConfig,
  marketCapUsd?: number,
  leaderBuyUsd?: number,
): number {
  if (isLowMcapEntryTier(cfg, marketCapUsd)) return roundUsd(cfg.entryLowPositionUsd);
  if (usesInitialLeaderMirror(cfg) && leaderBuyUsd != null && leaderBuyUsd > 0) {
    return leaderInitialEntryUsd(cfg, leaderBuyUsd);
  }
  if (isMidMcapEntryTier(cfg, marketCapUsd)) return cfg.entryMidPositionUsd;
  return cfg.positionUsd;
}

export function entryProbeSizeUsd(
  cfg: CopyTraderConfig,
  marketCapUsd?: number,
  leaderBuyUsd?: number,
): number {
  const total = entryTargetUsd(cfg, marketCapUsd, leaderBuyUsd);
  if (!usesSplitEntryProbe(cfg)) return total;
  if (isMidMcapEntryTier(cfg, marketCapUsd)) {
    const leg = roundUsd(cfg.entryMidLegUsd);
    return leg > 0 && leg < total ? leg : roundUsd(total / 2);
  }
  const probe = roundUsd(total * cfg.entryProbeFraction);
  if (probe <= 0 || probe >= total) return total;
  return probe;
}

export function entryDipSizeUsd(
  cfg: CopyTraderConfig,
  marketCapUsd?: number,
  leaderBuyUsd?: number,
): number {
  const total = entryTargetUsd(cfg, marketCapUsd, leaderBuyUsd);
  if (usesDipOnlyEntry(cfg)) return total;
  if (!usesSplitEntryProbe(cfg)) return 0;
  if (isMidMcapEntryTier(cfg, marketCapUsd)) {
    const leg = roundUsd(cfg.entryMidLegUsd);
    const dip = leg > 0 ? leg : roundUsd(total / 2);
    return dip > 0 && dip < total ? dip : 0;
  }
  const dip = roundUsd(total - entryProbeSizeUsd(cfg, marketCapUsd, leaderBuyUsd));
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

/**
 * Same as `entryScheduleDelayMs`, but collapses to 0 when the live mark is
 * already within `buyDelaySkipMaxPremiumPct` of the leader fill.
 */
export function resolveEntryBuyDelayMs(
  cfg: CopyTraderConfig,
  args: {
    kind: 'entry' | 'add';
    entryLeg?: EntryLeg;
    leaderPriceUsd: number;
    currentPriceUsd?: number | null;
  },
): number {
  const base = entryScheduleDelayMs(cfg, { kind: args.kind, entryLeg: args.entryLeg });
  if (base <= 0) return 0;
  if (!(cfg.buyDelaySkipMaxPremiumPct > 0)) return base;
  const leader = args.leaderPriceUsd;
  const mark = args.currentPriceUsd;
  if (!(leader > 0) || mark == null || !(mark > 0)) return base;
  const premiumPct = (mark / leader - 1) * 100;
  if (premiumPct <= cfg.buyDelaySkipMaxPremiumPct + 1e-9) return 0;
  return base;
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
    leaderBuyUsd?: number;
  },
  marketCapUsd?: number,
): void {
  if (pending.kind !== 'entry') return;
  const leaderBuyUsd = pending.leaderBuyUsd;
  if (marketCapUsd != null && marketCapUsd > 0) pending.entryMcapUsd = marketCapUsd;
  pending.entryTargetUsd = entryTargetUsd(cfg, marketCapUsd, leaderBuyUsd);
  if (pending.entryLeg === 'dip' || usesDipOnlyEntry(cfg)) {
    pending.sizeUsd = entryDipSizeUsd(cfg, marketCapUsd, leaderBuyUsd);
    return;
  }
  pending.sizeUsd = usesSplitEntryProbe(cfg)
    ? entryProbeSizeUsd(cfg, marketCapUsd, leaderBuyUsd)
    : entryTargetUsd(cfg, marketCapUsd, leaderBuyUsd);
}
