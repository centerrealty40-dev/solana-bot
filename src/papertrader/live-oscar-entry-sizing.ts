import type { PaperTraderConfig } from './config.js';
import { isLiveOscarTradingStrategyId } from '../preset-c/live-oscar-family.js';
import {
  resolveLiveOscarMcapTier,
  resolveLiveOscarTradeTierFromOpen,
  type LiveOscarTradeTier,
} from './live-oscar-mcap-tier.js';
import type { LiveStagedEntryState, OpenTrade } from './types.js';

/** Tier-aware staged-entry split leg-1: micro=$300, low/prod/default=$200 (canonical env). */
export function resolveLiveOscarEntrySplitLegUsd(
  cfg: PaperTraderConfig,
  tier?: LiveOscarTradeTier,
): number {
  if (tier === 'micro') return cfg.liveOscarMicroMcapEntrySplitLegUsd;
  return cfg.liveStagedEntryEntrySplitLegUsd;
}

/** Tier-aware split leg-2 @ −5%; micro: `0` = disabled. Other tiers: `0` → same as leg-1. */
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

export function resolveLiveOscarEntrySplitTotalUsd(
  cfg: PaperTraderConfig,
  tier?: LiveOscarTradeTier,
): number {
  return resolveLiveOscarEntrySplitLegUsd(cfg, tier) + resolveLiveOscarEntrySplitLeg2Usd(cfg, tier);
}

/** Tier-aware leg-3 staged avg @ −10%: all tiers $300 (prod via `liveStagedEntrySecondLegUsd`). */
export function resolveLiveOscarStagedAvgLegUsd(
  cfg: PaperTraderConfig,
  tier?: LiveOscarTradeTier,
): number {
  if (tier === 'micro') return cfg.liveOscarMicroMcapStagedAvgLegUsd;
  if (tier === 'low') return cfg.liveOscarLowMcapStagedAvgLegUsd;
  return cfg.liveStagedEntrySecondLegUsd;
}

export function resolveLiveOscarStagedEntryMaxUsd(
  cfg: PaperTraderConfig,
  tier?: LiveOscarTradeTier,
): number {
  let sum = resolveLiveOscarEntrySplitTotalUsd(cfg, tier);
  sum += resolveLiveOscarStagedAvgLegUsd(cfg, tier);
  if (cfg.liveStagedEntryThirdLegUsd > 0) sum += cfg.liveStagedEntryThirdLegUsd;
  return sum;
}

/** Fail fast on boot when tier-specific env diverges from contracts. */
export function assertLiveOscarUnifiedEntrySizing(cfg: PaperTraderConfig): void {
  if (!isLiveOscarTradingStrategyId(cfg.strategyId) || !cfg.liveStagedEntryEnabled) return;

  const leg1 = resolveLiveOscarEntrySplitLegUsd(cfg);
  const leg2 = resolveLiveOscarEntrySplitLeg2Usd(cfg);
  const pos = cfg.positionUsd;
  const errors: string[] = [];

  if (!(leg1 > 0)) {
    errors.push('PAPER_LIVE_STAGED_ENTRY_ENTRY_SPLIT_LEG_USD must be > 0');
  }
  if (!(pos > 0)) {
    errors.push('PAPER_POSITION_USD must be > 0');
  }
  if (leg1 > 0 && pos > 0 && Math.abs(pos - (leg1 + leg2)) > 1e-6) {
    errors.push(
      `PAPER_POSITION_USD (${pos}) must equal leg1+leg2 (${leg1}+${leg2}=${leg1 + leg2})`,
    );
  }
  if (cfg.liveStagedEntryFirstLegUsd > 0 && Math.abs(cfg.liveStagedEntryFirstLegUsd - leg1) > 1e-6) {
    errors.push(
      `PAPER_LIVE_STAGED_ENTRY_FIRST_LEG_USD (${cfg.liveStagedEntryFirstLegUsd}) must equal ENTRY_SPLIT_LEG (${leg1})`,
    );
  }
  if (
    cfg.liveOscarLowMcapLaneEnabled &&
    Math.abs(cfg.liveOscarLowMcapEntrySplitLegUsd - leg1) > 1e-6
  ) {
    errors.push(
      `PAPER_LIVE_OSCAR_LOW_MCAP_ENTRY_SPLIT_LEG_USD (${cfg.liveOscarLowMcapEntrySplitLegUsd}) must equal ENTRY_SPLIT_LEG (${leg1})`,
    );
  }
  if (cfg.liveOscarLowMcapLaneEnabled && cfg.liveOscarLowMcapEntrySplitLeg2Usd > 0) {
    if (Math.abs(cfg.liveOscarLowMcapEntrySplitLeg2Usd - leg2) > 1e-6) {
      errors.push(
        `PAPER_LIVE_OSCAR_LOW_MCAP_ENTRY_SPLIT_LEG2_USD (${cfg.liveOscarLowMcapEntrySplitLeg2Usd}) must equal ENTRY_SPLIT_LEG2 (${leg2})`,
      );
    }
  }
  if (
    cfg.liveOscarLowMcapLaneEnabled &&
    Math.abs(cfg.liveOscarLowMcapPositionUsd - pos) > 1e-6
  ) {
    errors.push(
      `PAPER_LIVE_OSCAR_LOW_MCAP_POSITION_USD (${cfg.liveOscarLowMcapPositionUsd}) must equal PAPER_POSITION_USD (${pos})`,
    );
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
  const leg2 = resolveLiveOscarEntrySplitLeg2Usd(cfg, tier);
  const avgUsd = resolveLiveOscarStagedAvgLegUsd(cfg, tier);
  st.firstLegUsd = leg1;
  st.entrySplitLegUsd = leg1;
  st.entrySplitLeg2Usd = leg2;
  st.entrySplitDelayMs = cfg.liveStagedEntryEntrySplitDelayMs;
  st.entrySplitMaxUpPct = cfg.liveStagedEntryEntrySplitMaxUpPct;
  st.entrySplitMaxDownPct = cfg.liveStagedEntryEntrySplitMaxDownPct;
  st.entrySplitTargetDropPct = cfg.liveStagedEntryEntrySplitTargetDropPct;
  if (!st.mintFirstProbe) {
    st.avgSecondLegUsd = avgUsd;
    st.secondLegUsd = avgUsd;
    st.avgSecondDropPct = cfg.liveStagedEntrySecondDropPct;
    st.secondDropPct = cfg.liveStagedEntrySecondDropPct;
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
