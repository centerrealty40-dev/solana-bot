import type { PaperTraderConfig } from './config.js';
import { isLiveOscarTradingStrategyId } from '../preset-c/live-oscar-family.js';
import {
  ENTRY_SPLIT_LEG_COUNT,
  type EntrySplitLegIndex,
  entrySplitLegUsdFromState,
  setEntrySplitLegDone,
} from './entry-split-legs.js';
import {
  resolveLiveOscarMcapTier,
  resolveLiveOscarTradeTierFromOpen,
  type LiveOscarTradeTier,
} from './live-oscar-mcap-tier.js';
import type { LiveStagedEntryState, OpenTrade } from './types.js';

/** Tier-aware staged-entry split leg-1: low/prod/default from env. */
export function resolveLiveOscarEntrySplitLegUsd(
  cfg: PaperTraderConfig,
  tier?: LiveOscarTradeTier,
): number {
  if (tier === 'micro') return cfg.liveOscarMicroMcapEntrySplitLegUsd;
  if (tier === 'low') return cfg.liveOscarLowMcapEntrySplitLegUsd;
  return cfg.liveStagedEntryEntrySplitLegUsd;
}

/** Tier-aware split leg-2; micro: `0` = disabled. Other tiers: `0` → same as leg-1. */
export function resolveLiveOscarEntrySplitLeg2Usd(
  cfg: PaperTraderConfig,
  tier?: LiveOscarTradeTier,
): number {
  const leg1 = resolveLiveOscarEntrySplitLegUsd(cfg, tier);
  if (tier === 'micro') {
    return cfg.liveOscarMicroMcapEntrySplitLeg2Usd;
  }
  if (tier === 'low') {
    const configured = cfg.liveOscarLowMcapEntrySplitLeg2Usd;
    return configured > 0 ? configured : leg1;
  }
  const configured = cfg.liveStagedEntryEntrySplitLeg2Usd;
  return configured > 0 ? configured : leg1;
}

/** Tier-aware split leg-3 (timed entry split, not averaging). Low/micro default `0`. */
export function resolveLiveOscarEntrySplitLeg3Usd(
  cfg: PaperTraderConfig,
  tier?: LiveOscarTradeTier,
): number {
  if (tier === 'low') return cfg.liveOscarLowMcapEntrySplitLeg3Usd;
  if (tier === 'micro') return 0;
  return cfg.liveStagedEntryEntrySplitLeg3Usd;
}

/** Prod timed entry-split legs 4–7; low/micro always `0`. */
export function resolveLiveOscarEntrySplitLeg4Usd(
  cfg: PaperTraderConfig,
  tier?: LiveOscarTradeTier,
): number {
  if (tier === 'micro' || tier === 'low') return 0;
  return cfg.liveStagedEntryEntrySplitLeg4Usd;
}

export function resolveLiveOscarEntrySplitLeg5Usd(
  cfg: PaperTraderConfig,
  tier?: LiveOscarTradeTier,
): number {
  if (tier === 'micro' || tier === 'low') return 0;
  return cfg.liveStagedEntryEntrySplitLeg5Usd;
}

export function resolveLiveOscarEntrySplitLeg6Usd(
  cfg: PaperTraderConfig,
  tier?: LiveOscarTradeTier,
): number {
  if (tier === 'micro' || tier === 'low') return 0;
  return cfg.liveStagedEntryEntrySplitLeg6Usd;
}

export function resolveLiveOscarEntrySplitLeg7Usd(
  cfg: PaperTraderConfig,
  tier?: LiveOscarTradeTier,
): number {
  if (tier === 'micro' || tier === 'low') return 0;
  return cfg.liveStagedEntryEntrySplitLeg7Usd;
}

export function resolveLiveOscarEntrySplitLegUsdByIndex(
  cfg: PaperTraderConfig,
  tier: LiveOscarTradeTier | undefined,
  legIndex: EntrySplitLegIndex,
): number {
  switch (legIndex) {
    case 1:
      return resolveLiveOscarEntrySplitLegUsd(cfg, tier);
    case 2:
      return resolveLiveOscarEntrySplitLeg2Usd(cfg, tier);
    case 3:
      return resolveLiveOscarEntrySplitLeg3Usd(cfg, tier);
    case 4:
      return resolveLiveOscarEntrySplitLeg4Usd(cfg, tier);
    case 5:
      return resolveLiveOscarEntrySplitLeg5Usd(cfg, tier);
    case 6:
      return resolveLiveOscarEntrySplitLeg6Usd(cfg, tier);
    case 7:
      return resolveLiveOscarEntrySplitLeg7Usd(cfg, tier);
    default:
      return 0;
  }
}

export function resolveLiveOscarEntrySplitTotalUsd(
  cfg: PaperTraderConfig,
  tier?: LiveOscarTradeTier,
): number {
  let sum = 0;
  for (let i = 1; i <= ENTRY_SPLIT_LEG_COUNT; i++) {
    sum += resolveLiveOscarEntrySplitLegUsdByIndex(cfg, tier, i as EntrySplitLegIndex);
  }
  return sum;
}

/** First staged averaging drop % from signal anchor. */
export function resolveLiveOscarStagedAvgFirstDropPct(
  cfg: PaperTraderConfig,
  tier?: LiveOscarTradeTier,
): number {
  if (tier === 'low') return cfg.liveOscarLowMcapStagedAvgDropPct;
  return cfg.liveStagedEntrySecondDropPct;
}

/** Tier-aware first staged avg leg USD. */
export function resolveLiveOscarStagedAvgLegUsd(
  cfg: PaperTraderConfig,
  tier?: LiveOscarTradeTier,
): number {
  if (tier === 'micro') return cfg.liveOscarMicroMcapStagedAvgLegUsd;
  if (tier === 'low') return cfg.liveOscarLowMcapStagedAvgLegUsd;
  return cfg.liveStagedEntrySecondLegUsd;
}

/** Second staged averaging leg (prod only when configured). */
export function resolveLiveOscarStagedAvgSecondLegUsd(
  cfg: PaperTraderConfig,
  tier?: LiveOscarTradeTier,
): number {
  if (tier === 'low' || tier === 'micro') return 0;
  return cfg.liveStagedEntryThirdLegUsd;
}

export function resolveLiveOscarStagedAvgSecondDropPct(
  cfg: PaperTraderConfig,
  tier?: LiveOscarTradeTier,
): number {
  if (tier === 'low' || tier === 'micro') return 0;
  return cfg.liveStagedEntryThirdDropPct;
}

export function resolveLiveOscarStagedEntryMaxUsd(
  cfg: PaperTraderConfig,
  tier?: LiveOscarTradeTier,
): number {
  let sum = resolveLiveOscarEntrySplitTotalUsd(cfg, tier);
  sum += resolveLiveOscarStagedAvgLegUsd(cfg, tier);
  sum += resolveLiveOscarStagedAvgSecondLegUsd(cfg, tier);
  return sum;
}

/** Fail fast on boot when tier-specific env diverges from contracts. */
export function assertLiveOscarUnifiedEntrySizing(cfg: PaperTraderConfig): void {
  if (!isLiveOscarTradingStrategyId(cfg.strategyId) || !cfg.liveStagedEntryEnabled) return;

  const prodLeg1 = resolveLiveOscarEntrySplitLegUsd(cfg, 'prod');
  const prodSplitTotal = resolveLiveOscarEntrySplitTotalUsd(cfg, 'prod');
  const pos = cfg.positionUsd;
  const errors: string[] = [];

  if (!(prodLeg1 > 0)) {
    errors.push('PAPER_LIVE_STAGED_ENTRY_ENTRY_SPLIT_LEG_USD must be > 0');
  }
  if (!(pos > 0)) {
    errors.push('PAPER_POSITION_USD must be > 0');
  }
  if (prodLeg1 > 0 && pos > 0 && Math.abs(pos - prodSplitTotal) > 1e-6) {
    errors.push(
      `PAPER_POSITION_USD (${pos}) must equal prod entry-split total (${prodSplitTotal})`,
    );
  }
  if (cfg.liveStagedEntryFirstLegUsd > 0 && Math.abs(cfg.liveStagedEntryFirstLegUsd - prodLeg1) > 1e-6) {
    errors.push(
      `PAPER_LIVE_STAGED_ENTRY_FIRST_LEG_USD (${cfg.liveStagedEntryFirstLegUsd}) must equal ENTRY_SPLIT_LEG (${prodLeg1})`,
    );
  }

  if (cfg.liveOscarLowMcapLaneEnabled) {
    const lowLeg1 = cfg.liveOscarLowMcapEntrySplitLegUsd;
    const lowLeg2 = resolveLiveOscarEntrySplitLeg2Usd(cfg, 'low');
    const lowLeg3 = resolveLiveOscarEntrySplitLeg3Usd(cfg, 'low');
    const lowPos = cfg.liveOscarLowMcapPositionUsd;
    if (!(lowLeg1 > 0)) {
      errors.push('PAPER_LIVE_OSCAR_LOW_MCAP_ENTRY_SPLIT_LEG_USD must be > 0');
    }
    if (!(lowPos > 0)) {
      errors.push('PAPER_LIVE_OSCAR_LOW_MCAP_POSITION_USD must be > 0');
    }
    if (lowLeg1 > 0 && lowPos > 0 && Math.abs(lowPos - (lowLeg1 + lowLeg2 + lowLeg3)) > 1e-6) {
      errors.push(
        `PAPER_LIVE_OSCAR_LOW_MCAP_POSITION_USD (${lowPos}) must equal leg1+leg2+leg3 (${lowLeg1}+${lowLeg2}+${lowLeg3}=${lowLeg1 + lowLeg2 + lowLeg3})`,
      );
    }
  }

  if (cfg.liveOscarMicroMcapLaneEnabled) {
    const microLeg1 = cfg.liveOscarMicroMcapEntrySplitLegUsd;
    const microLeg2 = resolveLiveOscarEntrySplitLeg2Usd(cfg, 'micro');
    const microPos = cfg.liveOscarMicroMcapPositionUsd;
    if (!(microLeg1 > 0)) {
      errors.push('PAPER_LIVE_OSCAR_MICRO_MCAP_ENTRY_SPLIT_LEG_USD must be > 0');
    }
    if (!(microPos > 0)) {
      errors.push('PAPER_LIVE_OSCAR_MICRO_MCAP_POSITION_USD must be > 0');
    }
    if (microLeg1 > 0 && microPos > 0 && Math.abs(microPos - (microLeg1 + microLeg2)) > 1e-6) {
      errors.push(
        `PAPER_LIVE_OSCAR_MICRO_MCAP_POSITION_USD (${microPos}) must equal leg1+leg2 (${microLeg1}+${microLeg2}=${microLeg1 + microLeg2})`,
      );
    }
  }

  if (errors.length > 0) {
    throw new Error(`live-oscar entry sizing misconfigured: ${errors.join('; ')}`);
  }
}

/** Keep in-memory / restored staged plan aligned with current env (prevents tier drift). */
export function applyCanonicalStagedEntrySizing(
  cfg: PaperTraderConfig,
  st: LiveStagedEntryState,
  tier?: LiveOscarTradeTier,
): void {
  const leg1 = resolveLiveOscarEntrySplitLegUsd(cfg, tier);
  const avgUsd = resolveLiveOscarStagedAvgLegUsd(cfg, tier);
  const avg2Usd = resolveLiveOscarStagedAvgSecondLegUsd(cfg, tier);
  const avgDrop = resolveLiveOscarStagedAvgFirstDropPct(cfg, tier);
  const avg2Drop = resolveLiveOscarStagedAvgSecondDropPct(cfg, tier);
  st.firstLegUsd = leg1;
  st.entrySplitLegUsd = leg1;
  st.entrySplitLeg2Usd = resolveLiveOscarEntrySplitLeg2Usd(cfg, tier);
  st.entrySplitLeg3Usd = resolveLiveOscarEntrySplitLeg3Usd(cfg, tier);
  st.entrySplitLeg4Usd = resolveLiveOscarEntrySplitLeg4Usd(cfg, tier);
  st.entrySplitLeg5Usd = resolveLiveOscarEntrySplitLeg5Usd(cfg, tier);
  st.entrySplitLeg6Usd = resolveLiveOscarEntrySplitLeg6Usd(cfg, tier);
  st.entrySplitLeg7Usd = resolveLiveOscarEntrySplitLeg7Usd(cfg, tier);
  for (let i = 2; i <= ENTRY_SPLIT_LEG_COUNT; i++) {
    setEntrySplitLegDone(st, i as EntrySplitLegIndex, entrySplitLegUsdFromState(st, i as EntrySplitLegIndex) <= 0);
  }
  st.entrySplitDelayMs = cfg.liveStagedEntryEntrySplitDelayMs;
  st.entrySplitMaxUpPct = cfg.liveStagedEntryEntrySplitMaxUpPct;
  st.entrySplitMaxDownPct = cfg.liveStagedEntryEntrySplitMaxDownPct;
  st.entrySplitTargetDropPct = cfg.liveStagedEntryEntrySplitTargetDropPct;
  if (!st.mintFirstProbe) {
    st.avgSecondLegUsd = avgUsd;
    st.secondLegUsd = avgUsd;
    st.avgSecondDropPct = avgDrop;
    st.secondDropPct = avgDrop;
    if (avg2Usd > 0 && avg2Drop > 0) {
      st.avgThirdLegUsd = avg2Usd;
      st.thirdLegUsd = avg2Usd;
      st.avgThirdDropPct = avg2Drop;
      st.thirdDropPct = avg2Drop;
    }
  }
}

/** Before live buy_open: first journal leg + staged plan must match canonical split. */
export function applyCanonicalOpenLegUsd(cfg: PaperTraderConfig, ot: OpenTrade): void {
  const st = ot.liveStagedEntry;
  if (!st?.entrySplitV2) return;
  const tier = resolveLiveOscarTradeTierFromOpen(cfg, ot);
  applyCanonicalStagedEntrySizing(cfg, st, tier);
  const leg = resolveLiveOscarEntrySplitLegUsd(cfg, tier);
  const openLeg = ot.legs.find((l) => l.reason === 'open');
  const hasFilledBuy = (ot.entryLegSignatures?.length ?? 0) > 0;
  if (openLeg && !hasFilledBuy && openLeg.sizeUsd !== leg) {
    openLeg.sizeUsd = leg;
    ot.totalInvestedUsd = ot.legs.reduce((s, l) => s + l.sizeUsd, 0);
  }
}

/** Resolve trade tier from signal mcap at staged-entry build time. */
export function resolveLiveOscarTradeTierFromMcap(
  cfg: PaperTraderConfig,
  marketCapUsd: number | null | undefined,
): LiveOscarTradeTier | undefined {
  if (marketCapUsd == null || !(marketCapUsd > 0)) return undefined;
  const t = resolveLiveOscarMcapTier(cfg, marketCapUsd);
  if (t === 'micro' || t === 'low' || t === 'prod' || t === 'scalp_wave') return t;
  return undefined;
}
