import type { PaperTraderConfig } from './config.js';

/** Live Oscar mcap resolution: below / micro / low / prod / scalp_wave. */
export type LiveOscarMcapTier = 'below' | 'micro' | 'low' | 'prod' | 'scalp_wave';

/** Tradeable tiers (journal / sizing / restore). */
export type LiveOscarTradeTier = 'micro' | 'low' | 'prod' | 'scalp_wave';

export function isLiveOscarTwoPhaseMcap(cfg: PaperTraderConfig): boolean {
  return cfg.strategyId === 'live-oscar' && cfg.liveOscarLowMcapLaneEnabled;
}

export function isLiveOscarMcapTieringEnabled(cfg: PaperTraderConfig): boolean {
  return (
    cfg.strategyId === 'live-oscar' &&
    (cfg.liveOscarLowMcapLaneEnabled || cfg.liveOscarMicroMcapLaneEnabled)
  );
}

export function liveOscarBelowMcapThresholdUsd(cfg: PaperTraderConfig): number {
  if (cfg.liveOscarMicroMcapLaneEnabled) return cfg.liveOscarMicroMcapMinUsd;
  if (isLiveOscarTwoPhaseMcap(cfg)) return cfg.liveOscarLowMcapMinUsd;
  return cfg.discoveryMinMarketCapUsd ?? 0;
}

export function resolveLiveOscarMcapTier(cfg: PaperTraderConfig, mcapUsd: number): LiveOscarMcapTier {
  const mcap = Number(mcapUsd);
  if (!Number.isFinite(mcap) || mcap <= 0) return 'below';
  if (!isLiveOscarMcapTieringEnabled(cfg)) {
    const prodMin = cfg.discoveryMinMarketCapUsd ?? 0;
    if (prodMin > 0 && mcap + 1e-9 < prodMin) return 'below';
    return 'prod';
  }
  if (cfg.liveOscarMicroMcapLaneEnabled) {
    if (mcap + 1e-9 < cfg.liveOscarMicroMcapMinUsd) return 'below';
    if (mcap + 1e-9 < cfg.liveOscarMicroMcapMaxUsd) return 'micro';
  } else if (mcap + 1e-9 < cfg.liveOscarLowMcapMinUsd) {
    return 'below';
  }
  if (isLiveOscarTwoPhaseMcap(cfg)) {
    /** $3M ровно — prod; low только $1.3M ≤ mcap < $3M. */
    if (mcap + 1e-9 < cfg.liveOscarLowMcapMaxUsd) return 'low';
  }
  return 'prod';
}

export function resolveLiveOscarTradeTierFromOpen(
  cfg: PaperTraderConfig,
  ot: {
    liveOscarMcapTier?: LiveOscarTradeTier;
    liveOscarTradeLane?: 'prod' | 'scalp_wave';
    liveExitPolicyId?: string;
    entryMarketCapUsd?: number | null;
  },
): LiveOscarTradeTier | undefined {
  if (ot.liveOscarMcapTier) return ot.liveOscarMcapTier;
  if (ot.liveOscarTradeLane === 'scalp_wave' || ot.liveExitPolicyId === 'scalp_wave_v1') {
    return 'scalp_wave';
  }
  const mcap = ot.entryMarketCapUsd;
  if (mcap != null && mcap > 0) {
    const t = resolveLiveOscarMcapTier(cfg, mcap);
    if (t === 'micro' || t === 'low' || t === 'prod' || t === 'scalp_wave') return t;
  }
  return undefined;
}

/** Пороги входа (dip / vol1h / post-crash min drop) по mcap-tier. */
export function liveOscarTierEntryConfig(
  cfg: PaperTraderConfig,
  tier: LiveOscarMcapTier,
): PaperTraderConfig {
  if (tier === 'scalp_wave') {
    return {
      ...cfg,
      dipMinDropPct: cfg.liveOscarScalpWaveDipMinDropPct,
      dipMaxDropPct: cfg.liveOscarScalpWaveDipMaxDropPct,
      dipMinAgeMin: cfg.liveOscarScalpWaveMinAgeMin,
      dipMinImpulsePct: cfg.liveOscarScalpWaveMinImpulsePct,
      vol1hMinUsd: cfg.liveOscarScalpWaveVol1hMinUsd,
      postCrashFastPathMinDropPct: cfg.liveOscarScalpWaveDipMinDropPct,
      positionUsd: cfg.liveOscarScalpWavePositionUsd,
    };
  }
  if (tier === 'micro') {
    return {
      ...cfg,
      dipMinDropPct: cfg.liveOscarMicroMcapDipMinDropPct,
      vol1hMinUsd: cfg.liveOscarMicroMcapVol1hMinUsd,
      postCrashFastPathMinDropPct: cfg.liveOscarMicroMcapDipMinDropPct,
    };
  }
  if (tier === 'low') {
    return {
      ...cfg,
      dipMinDropPct: cfg.liveOscarLowMcapDipMinDropPct,
      vol1hMinUsd: cfg.liveOscarLowMcapVol1hMinUsd,
      postCrashFastPathMinDropPct: cfg.liveOscarLowMcapDipMinDropPct,
    };
  }
  if (tier === 'prod' && isLiveOscarTwoPhaseMcap(cfg)) {
    return {
      ...cfg,
      dipMinDropPct: cfg.liveOscarProdMcapDipMinDropPct,
      vol1hMinUsd: cfg.liveOscarProdMcapVol1hMinUsd,
      postCrashFastPathMinDropPct: cfg.liveOscarProdMcapDipMinDropPct,
    };
  }
  return cfg;
}

export function liveOscarTierStagedSplitLegUsd(cfg: PaperTraderConfig, tier: LiveOscarMcapTier): number {
  if (tier === 'scalp_wave') return cfg.liveOscarScalpWavePositionUsd;
  if (tier === 'micro') return cfg.liveOscarMicroMcapEntrySplitLegUsd;
  return cfg.liveStagedEntryEntrySplitLegUsd;
}

export function liveOscarTierPositionUsd(cfg: PaperTraderConfig, tier: LiveOscarMcapTier): number {
  if (tier === 'scalp_wave') return cfg.liveOscarScalpWavePositionUsd;
  if (tier === 'micro') return cfg.liveOscarMicroMcapPositionUsd;
  if (tier === 'low') return cfg.liveOscarLowMcapPositionUsd;
  return cfg.positionUsd;
}

export function liveOscarTierDcaLevelsSpec(cfg: PaperTraderConfig, tier: LiveOscarMcapTier): string {
  if (tier === 'scalp_wave') return '';
  if (tier === 'micro') return cfg.liveOscarMicroMcapDcaLevelsSpec;
  if (tier === 'low') return cfg.liveOscarLowMcapDcaLevelsSpec;
  return cfg.dcaLevelsSpec;
}
