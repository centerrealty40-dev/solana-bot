import type { PaperTraderConfig } from './config.js';

/** Двухфазный Live Oscar: узкий коридор ≤$3M vs prod >$3M. */
export type LiveOscarMcapTier = 'below' | 'low' | 'prod';

export function isLiveOscarTwoPhaseMcap(cfg: PaperTraderConfig): boolean {
  return cfg.strategyId === 'live-oscar' && cfg.liveOscarLowMcapLaneEnabled;
}

export function resolveLiveOscarMcapTier(cfg: PaperTraderConfig, mcapUsd: number): LiveOscarMcapTier {
  const mcap = Number(mcapUsd);
  if (!Number.isFinite(mcap) || mcap <= 0) return 'below';
  if (!isLiveOscarTwoPhaseMcap(cfg)) {
    const prodMin = cfg.discoveryMinMarketCapUsd ?? 0;
    if (prodMin > 0 && mcap + 1e-9 < prodMin) return 'below';
    return 'prod';
  }
  if (mcap + 1e-9 < cfg.liveOscarLowMcapMinUsd) return 'below';
  /** $3M ровно — prod (как до 1.11.306 при SQL min $3M); low только $1.3M ≤ mcap < $3M. */
  if (mcap + 1e-9 < cfg.liveOscarLowMcapMaxUsd) return 'low';
  return 'prod';
}

/** Пороги входа (dip / vol1h / post-crash min drop) для tier; prod = без изменений. */
export function liveOscarTierEntryConfig(
  cfg: PaperTraderConfig,
  tier: LiveOscarMcapTier,
): PaperTraderConfig {
  if (tier !== 'low') return cfg;
  return {
    ...cfg,
    dipMinDropPct: cfg.liveOscarLowMcapDipMinDropPct,
    vol1hMinUsd: cfg.liveOscarLowMcapVol1hMinUsd,
    postCrashFastPathMinDropPct: cfg.liveOscarLowMcapDipMinDropPct,
  };
}

export function liveOscarTierStagedSplitLegUsd(cfg: PaperTraderConfig, tier: LiveOscarMcapTier): number {
  if (tier === 'low') return cfg.liveOscarLowMcapEntrySplitLegUsd;
  return cfg.liveStagedEntryEntrySplitLegUsd;
}

export function liveOscarTierPositionUsd(cfg: PaperTraderConfig, tier: LiveOscarMcapTier): number {
  if (tier === 'low') return cfg.liveOscarLowMcapPositionUsd;
  return cfg.positionUsd;
}

export function liveOscarTierDcaLevelsSpec(cfg: PaperTraderConfig, tier: LiveOscarMcapTier): string {
  if (tier === 'low') return cfg.liveOscarLowMcapDcaLevelsSpec;
  return cfg.dcaLevelsSpec;
}
