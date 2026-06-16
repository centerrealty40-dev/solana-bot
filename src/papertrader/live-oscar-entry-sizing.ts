import type { PaperTraderConfig } from './config.js';
import {
  resolveLiveOscarMcapTier,
  resolveLiveOscarTradeTierFromOpen,
  type LiveOscarTradeTier,
} from './live-oscar-mcap-tier.js';
import type { LiveStagedEntryState, OpenTrade } from './types.js';

/** Tier-aware staged-entry split leg: micro=$300, low/prod/default=$730 (canonical env). */
export function resolveLiveOscarEntrySplitLegUsd(
  cfg: PaperTraderConfig,
  tier?: LiveOscarTradeTier,
): number {
  if (tier === 'micro') return cfg.liveOscarMicroMcapEntrySplitLegUsd;
  return cfg.liveStagedEntryEntrySplitLegUsd;
}

/** Fail fast on boot when tier-specific env diverges from contracts. */
export function assertLiveOscarUnifiedEntrySizing(cfg: PaperTraderConfig): void {
  if (cfg.strategyId !== 'live-oscar' || !cfg.liveStagedEntryEnabled) return;

  const leg = resolveLiveOscarEntrySplitLegUsd(cfg);
  const pos = cfg.positionUsd;
  const errors: string[] = [];

  if (!(leg > 0)) {
    errors.push('PAPER_LIVE_STAGED_ENTRY_ENTRY_SPLIT_LEG_USD must be > 0');
  }
  if (!(pos > 0)) {
    errors.push('PAPER_POSITION_USD must be > 0');
  }
  if (leg > 0 && pos > 0 && Math.abs(pos - leg * 2) > 1e-6) {
    errors.push(
      `PAPER_POSITION_USD (${pos}) must equal 2× PAPER_LIVE_STAGED_ENTRY_ENTRY_SPLIT_LEG_USD (${leg * 2})`,
    );
  }
  if (cfg.liveStagedEntryFirstLegUsd > 0 && Math.abs(cfg.liveStagedEntryFirstLegUsd - leg) > 1e-6) {
    errors.push(
      `PAPER_LIVE_STAGED_ENTRY_FIRST_LEG_USD (${cfg.liveStagedEntryFirstLegUsd}) must equal ENTRY_SPLIT_LEG (${leg})`,
    );
  }
  if (
    cfg.liveOscarLowMcapLaneEnabled &&
    Math.abs(cfg.liveOscarLowMcapEntrySplitLegUsd - leg) > 1e-6
  ) {
    errors.push(
      `PAPER_LIVE_OSCAR_LOW_MCAP_ENTRY_SPLIT_LEG_USD (${cfg.liveOscarLowMcapEntrySplitLegUsd}) must equal ENTRY_SPLIT_LEG (${leg})`,
    );
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
    const microLeg = cfg.liveOscarMicroMcapEntrySplitLegUsd;
    const microPos = cfg.liveOscarMicroMcapPositionUsd;
    if (!(microLeg > 0)) {
      errors.push('PAPER_LIVE_OSCAR_MICRO_MCAP_ENTRY_SPLIT_LEG_USD must be > 0');
    }
    if (!(microPos > 0)) {
      errors.push('PAPER_LIVE_OSCAR_MICRO_MCAP_POSITION_USD must be > 0');
    }
    if (microLeg > 0 && microPos > 0 && Math.abs(microPos - microLeg * 2) > 1e-6) {
      errors.push(
        `PAPER_LIVE_OSCAR_MICRO_MCAP_POSITION_USD (${microPos}) must equal 2× MICRO_ENTRY_SPLIT_LEG (${microLeg * 2})`,
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
  const leg = resolveLiveOscarEntrySplitLegUsd(cfg, tier);
  st.firstLegUsd = leg;
  st.entrySplitLegUsd = leg;
  st.entrySplitDelayMs = cfg.liveStagedEntryEntrySplitDelayMs;
  st.entrySplitMaxUpPct = cfg.liveStagedEntryEntrySplitMaxUpPct;
  st.entrySplitMaxDownPct = cfg.liveStagedEntryEntrySplitMaxDownPct;
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
  if (t === 'micro' || t === 'low' || t === 'prod') return t;
  return undefined;
}
