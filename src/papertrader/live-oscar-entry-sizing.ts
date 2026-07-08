import type { PaperTraderConfig } from './config.js';
import { isLiveOscarTradingStrategyId } from '../preset-c/live-oscar-family.js';
import {
  ENTRY_SPLIT_LEG_COUNT,
  type EntrySplitLegIndex,
  entrySplitLegDoneFromState,
  entrySplitLegUsdFromState,
  setEntrySplitLegDone,
} from './entry-split-legs.js';
import {
  resolveLiveOscarMcapTier,
  resolveLiveOscarTradeTierFromOpen,
  type LiveOscarTradeTier,
} from './live-oscar-mcap-tier.js';
import type { LiveStagedEntryState, OpenTrade } from './types.js';

/** Prod tier mcap bands (≥ $3M when low lane ON). */
export type LiveOscarProdMcapBand = '3_12' | '12_plus';

export type LiveOscarProdBandEntryPlan = {
  band: LiveOscarProdMcapBand;
  maxUsd: number;
  splitLegCount: number;
  avgLeg1Usd: number;
  avgLeg2Usd: number;
};

export function resolveLiveOscarProdMcapBand(
  cfg: PaperTraderConfig,
  mcapUsd: number,
): LiveOscarProdMcapBand | undefined {
  if (!isLiveOscarTradingStrategyId(cfg.strategyId)) return undefined;
  const mcap = Number(mcapUsd);
  if (!Number.isFinite(mcap) || mcap <= 0) return undefined;
  const prodMin = cfg.liveOscarLowMcapLaneEnabled
    ? cfg.liveOscarLowMcapMaxUsd
    : (cfg.discoveryMinMarketCapUsd ?? 0);
  if (prodMin > 0 && mcap + 1e-9 < prodMin) return undefined;
  if (mcap + 1e-9 < cfg.liveOscarProdMcapBand12MUsd) return '3_12';
  return '12_plus';
}

function prodBandMaxUsd(cfg: PaperTraderConfig, band: LiveOscarProdMcapBand): number {
  switch (band) {
    case '3_12':
      return cfg.liveOscarProdMcapMaxUsd3_12;
    case '12_plus':
      return cfg.liveOscarProdMcapMaxUsd12Plus;
  }
}

function prodEntrySplitLegUsdValues(cfg: PaperTraderConfig): readonly number[] {
  return [
    cfg.liveStagedEntryEntrySplitLegUsd,
    cfg.liveStagedEntryEntrySplitLeg2Usd,
    cfg.liveStagedEntryEntrySplitLeg3Usd,
    cfg.liveStagedEntryEntrySplitLeg4Usd,
    cfg.liveStagedEntryEntrySplitLeg5Usd,
    cfg.liveStagedEntryEntrySplitLeg6Usd,
    cfg.liveStagedEntryEntrySplitLeg7Usd,
    cfg.liveStagedEntryEntrySplitLeg8Usd,
  ];
}

function prodConfiguredEntrySplitLegCount(cfg: PaperTraderConfig): number {
  const active = prodEntrySplitLegUsdValues(cfg).filter((usd) => usd > 0).length;
  return Math.max(1, active);
}

function prodConfiguredEntrySplitTotalUsd(cfg: PaperTraderConfig): number {
  return prodEntrySplitLegUsdValues(cfg).reduce((sum, usd) => sum + Math.max(0, usd), 0);
}

/** Derive split/avg legs from band max cap (configured split legs + staged avg). */
export function deriveLiveOscarProdBandEntryPlan(
  cfg: PaperTraderConfig,
  band: LiveOscarProdMcapBand,
): LiveOscarProdBandEntryPlan {
  const maxUsd = prodBandMaxUsd(cfg, band);
  const legUsd = cfg.liveStagedEntryEntrySplitLegUsd;
  const avg1Default = cfg.liveStagedEntrySecondLegUsd;
  const avg2Default = cfg.liveStagedEntryThirdLegUsd;
  const splitLegCount = prodConfiguredEntrySplitLegCount(cfg);
  const splitTotal = prodConfiguredEntrySplitTotalUsd(cfg);
  const fullMax = splitTotal + avg1Default + avg2Default;

  if (maxUsd >= fullMax) {
    return {
      band,
      maxUsd,
      splitLegCount,
      avgLeg1Usd: avg1Default,
      avgLeg2Usd: avg2Default,
    };
  }
  if (maxUsd > splitTotal) {
    const avg1 = avg1Default;
    const avg2 = Math.max(0, maxUsd - splitTotal - avg1);
    return { band, maxUsd, splitLegCount, avgLeg1Usd: avg1, avgLeg2Usd: avg2 };
  }
  if (maxUsd >= splitTotal) {
    return { band, maxUsd, splitLegCount, avgLeg1Usd: 0, avgLeg2Usd: 0 };
  }
  const scaledSplitLegCount = legUsd > 0 ? Math.max(1, Math.floor(maxUsd / legUsd)) : 1;
  return { band, maxUsd, splitLegCount: scaledSplitLegCount, avgLeg1Usd: 0, avgLeg2Usd: 0 };
}

function resolveProdBandPlanIfApplicable(
  cfg: PaperTraderConfig,
  tier: LiveOscarTradeTier | undefined,
  marketCapUsd: number | null | undefined,
): LiveOscarProdBandEntryPlan | undefined {
  const effectiveTier = tier ?? resolveLiveOscarTradeTierFromMcap(cfg, marketCapUsd);
  if (effectiveTier !== 'prod') return undefined;
  if (marketCapUsd == null || !(marketCapUsd > 0)) return undefined;
  const band = resolveLiveOscarProdMcapBand(cfg, marketCapUsd);
  if (!band) return undefined;
  return deriveLiveOscarProdBandEntryPlan(cfg, band);
}

function prodSplitLegEnabled(
  cfg: PaperTraderConfig,
  tier: LiveOscarTradeTier | undefined,
  marketCapUsd: number | null | undefined,
  legIndex: EntrySplitLegIndex,
): boolean {
  if (tier === 'micro' || tier === 'low' || tier === 'scalp_wave') return false;

  const mcapTier =
    marketCapUsd != null && marketCapUsd > 0 ? resolveLiveOscarMcapTier(cfg, marketCapUsd) : null;
  if (mcapTier != null && mcapTier !== 'prod') return false;

  const tradeTier = tier ?? resolveLiveOscarTradeTierFromMcap(cfg, marketCapUsd);
  if (tradeTier != null && tradeTier !== 'prod') return false;

  const plan = resolveProdBandPlanIfApplicable(cfg, 'prod', marketCapUsd);
  if (!plan) {
    return legIndex <= prodConfiguredEntrySplitLegCount(cfg);
  }
  return legIndex <= plan.splitLegCount;
}

/** Tier-aware staged-entry split leg-1: low/prod/default from env. */
export function resolveLiveOscarEntrySplitLegUsd(
  cfg: PaperTraderConfig,
  tier?: LiveOscarTradeTier,
  marketCapUsd?: number | null,
): number {
  if (tier === 'micro') return cfg.liveOscarMicroMcapEntrySplitLegUsd;
  if (tier === 'low') return cfg.liveOscarLowMcapEntrySplitLegUsd;
  if (!prodSplitLegEnabled(cfg, tier, marketCapUsd, 1)) return 0;
  return cfg.liveStagedEntryEntrySplitLegUsd;
}

/** Tier-aware split leg-2; micro: `0` = disabled. Other tiers: `0` → same as leg-1. */
export function resolveLiveOscarEntrySplitLeg2Usd(
  cfg: PaperTraderConfig,
  tier?: LiveOscarTradeTier,
  marketCapUsd?: number | null,
): number {
  const leg1 = resolveLiveOscarEntrySplitLegUsd(cfg, tier, marketCapUsd);
  if (tier === 'micro') {
    return cfg.liveOscarMicroMcapEntrySplitLeg2Usd;
  }
  if (tier === 'low') {
    const configured = cfg.liveOscarLowMcapEntrySplitLeg2Usd;
    return configured > 0 ? configured : leg1;
  }
  if (!prodSplitLegEnabled(cfg, tier, marketCapUsd, 2)) return 0;
  const configured = cfg.liveStagedEntryEntrySplitLeg2Usd;
  return configured > 0 ? configured : leg1;
}

/** Tier-aware split leg-3 (timed entry split, not averaging). Low/micro default `0`. */
export function resolveLiveOscarEntrySplitLeg3Usd(
  cfg: PaperTraderConfig,
  tier?: LiveOscarTradeTier,
  marketCapUsd?: number | null,
): number {
  if (tier === 'low') return cfg.liveOscarLowMcapEntrySplitLeg3Usd;
  if (tier === 'micro') return 0;
  if (!prodSplitLegEnabled(cfg, tier, marketCapUsd, 3)) return 0;
  return cfg.liveStagedEntryEntrySplitLeg3Usd;
}

/** Prod timed entry-split legs 4–8; micro `0`; low uses tier env legs 4–5. */
export function resolveLiveOscarEntrySplitLeg4Usd(
  cfg: PaperTraderConfig,
  tier?: LiveOscarTradeTier,
  marketCapUsd?: number | null,
): number {
  if (tier === 'micro') return 0;
  if (tier === 'low') return cfg.liveOscarLowMcapEntrySplitLeg4Usd;
  if (!prodSplitLegEnabled(cfg, tier, marketCapUsd, 4)) return 0;
  return cfg.liveStagedEntryEntrySplitLeg4Usd;
}

export function resolveLiveOscarEntrySplitLeg5Usd(
  cfg: PaperTraderConfig,
  tier?: LiveOscarTradeTier,
  marketCapUsd?: number | null,
): number {
  if (tier === 'micro') return 0;
  if (tier === 'low') return cfg.liveOscarLowMcapEntrySplitLeg5Usd;
  if (!prodSplitLegEnabled(cfg, tier, marketCapUsd, 5)) return 0;
  return cfg.liveStagedEntryEntrySplitLeg5Usd;
}

export function resolveLiveOscarEntrySplitLeg6Usd(
  cfg: PaperTraderConfig,
  tier?: LiveOscarTradeTier,
  marketCapUsd?: number | null,
): number {
  if (tier === 'micro' || tier === 'low') return 0;
  if (!prodSplitLegEnabled(cfg, tier, marketCapUsd, 6)) return 0;
  return cfg.liveStagedEntryEntrySplitLeg6Usd;
}

export function resolveLiveOscarEntrySplitLeg7Usd(
  cfg: PaperTraderConfig,
  tier?: LiveOscarTradeTier,
  marketCapUsd?: number | null,
): number {
  if (tier === 'micro' || tier === 'low') return 0;
  if (!prodSplitLegEnabled(cfg, tier, marketCapUsd, 7)) return 0;
  return cfg.liveStagedEntryEntrySplitLeg7Usd;
}

export function resolveLiveOscarEntrySplitLeg8Usd(
  cfg: PaperTraderConfig,
  tier?: LiveOscarTradeTier,
  marketCapUsd?: number | null,
): number {
  if (tier === 'micro' || tier === 'low') return 0;
  if (!prodSplitLegEnabled(cfg, tier, marketCapUsd, 8)) return 0;
  return cfg.liveStagedEntryEntrySplitLeg8Usd;
}

export function resolveLiveOscarEntrySplitLegUsdByIndex(
  cfg: PaperTraderConfig,
  tier: LiveOscarTradeTier | undefined,
  legIndex: EntrySplitLegIndex,
  marketCapUsd?: number | null,
): number {
  switch (legIndex) {
    case 1:
      return resolveLiveOscarEntrySplitLegUsd(cfg, tier, marketCapUsd);
    case 2:
      return resolveLiveOscarEntrySplitLeg2Usd(cfg, tier, marketCapUsd);
    case 3:
      return resolveLiveOscarEntrySplitLeg3Usd(cfg, tier, marketCapUsd);
    case 4:
      return resolveLiveOscarEntrySplitLeg4Usd(cfg, tier, marketCapUsd);
    case 5:
      return resolveLiveOscarEntrySplitLeg5Usd(cfg, tier, marketCapUsd);
    case 6:
      return resolveLiveOscarEntrySplitLeg6Usd(cfg, tier, marketCapUsd);
    case 7:
      return resolveLiveOscarEntrySplitLeg7Usd(cfg, tier, marketCapUsd);
    case 8:
      return resolveLiveOscarEntrySplitLeg8Usd(cfg, tier, marketCapUsd);
    default:
      return 0;
  }
}

export function resolveLiveOscarEntrySplitTotalUsd(
  cfg: PaperTraderConfig,
  tier?: LiveOscarTradeTier,
  marketCapUsd?: number | null,
): number {
  let sum = 0;
  for (let i = 1; i <= ENTRY_SPLIT_LEG_COUNT; i++) {
    sum += resolveLiveOscarEntrySplitLegUsdByIndex(cfg, tier, i as EntrySplitLegIndex, marketCapUsd);
  }
  return sum;
}

/** First staged averaging drop % from signal anchor (tier-aware; E+2 −10% on prod/low/micro). */
export function resolveLiveOscarStagedAvgFirstDropPct(
  cfg: PaperTraderConfig,
  tier?: LiveOscarTradeTier,
  _marketCapUsd?: number | null,
): number {
  if (tier === 'micro') return cfg.liveOscarMicroMcapStagedAvgDropPct;
  if (tier === 'low') return cfg.liveOscarLowMcapStagedAvgDropPct;
  return cfg.liveStagedEntrySecondDropPct;
}

/** Tier-aware first staged avg leg USD. */
export function resolveLiveOscarStagedAvgLegUsd(
  cfg: PaperTraderConfig,
  tier?: LiveOscarTradeTier,
  marketCapUsd?: number | null,
): number {
  if (tier === 'micro') return cfg.liveOscarMicroMcapStagedAvgLegUsd;
  if (tier === 'low') return cfg.liveOscarLowMcapStagedAvgLegUsd;
  const plan = resolveProdBandPlanIfApplicable(cfg, tier, marketCapUsd);
  if (plan) return plan.avgLeg1Usd;
  return cfg.liveStagedEntrySecondLegUsd;
}

/** Second staged averaging leg (prod + low when configured). */
export function resolveLiveOscarStagedAvgSecondLegUsd(
  cfg: PaperTraderConfig,
  tier?: LiveOscarTradeTier,
  marketCapUsd?: number | null,
): number {
  if (tier === 'low') return cfg.liveOscarLowMcapStagedAvgSecondLegUsd;
  if (tier === 'micro') return 0;
  const plan = resolveProdBandPlanIfApplicable(cfg, tier, marketCapUsd);
  if (plan) return plan.avgLeg2Usd;
  return cfg.liveStagedEntryThirdLegUsd;
}

export function resolveLiveOscarStagedAvgSecondDropPct(
  cfg: PaperTraderConfig,
  tier?: LiveOscarTradeTier,
  _marketCapUsd?: number | null,
): number {
  if (tier === 'low') return cfg.liveOscarLowMcapStagedAvgSecondDropPct;
  if (tier === 'micro') return 0;
  return cfg.liveStagedEntryThirdDropPct;
}

export function resolveLiveOscarStagedEntryMaxUsd(
  cfg: PaperTraderConfig,
  tier?: LiveOscarTradeTier,
  marketCapUsd?: number | null,
): number {
  const plan = resolveProdBandPlanIfApplicable(cfg, tier, marketCapUsd);
  if (plan) return plan.maxUsd;
  let sum = resolveLiveOscarEntrySplitTotalUsd(cfg, tier, marketCapUsd);
  sum += resolveLiveOscarStagedAvgLegUsd(cfg, tier, marketCapUsd);
  sum += resolveLiveOscarStagedAvgSecondLegUsd(cfg, tier, marketCapUsd);
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

  const prodMaxCap = cfg.liveOscarProdMcapMaxUsd3_12;
  const prodDerivedMax = resolveLiveOscarStagedEntryMaxUsd(cfg, 'prod', cfg.liveOscarProdMcapBand12MUsd - 1);
  if (Math.abs(prodMaxCap - prodDerivedMax) > 1e-6) {
    errors.push(
      `PAPER_LIVE_OSCAR_PROD_MCAP_MAX_3_12_USD (${prodMaxCap}) must match derived plan (${prodDerivedMax})`,
    );
  }
  const prod12PlusCap = cfg.liveOscarProdMcapMaxUsd12Plus;
  const prod12PlusDerived = resolveLiveOscarStagedEntryMaxUsd(cfg, 'prod', cfg.liveOscarProdMcapBand12MUsd);
  if (Math.abs(prod12PlusCap - prod12PlusDerived) > 1e-6) {
    errors.push(
      `PAPER_LIVE_OSCAR_PROD_MCAP_MAX_12_PLUS_USD (${prod12PlusCap}) must match derived plan (${prod12PlusDerived})`,
    );
  }

  if (cfg.liveOscarLowMcapLaneEnabled) {
    const lowLeg1 = cfg.liveOscarLowMcapEntrySplitLegUsd;
    const lowLeg2 = resolveLiveOscarEntrySplitLeg2Usd(cfg, 'low');
    const lowLeg3 = resolveLiveOscarEntrySplitLeg3Usd(cfg, 'low');
    const lowLeg4 = resolveLiveOscarEntrySplitLeg4Usd(cfg, 'low');
    const lowLeg5 = resolveLiveOscarEntrySplitLeg5Usd(cfg, 'low');
    const lowPos = cfg.liveOscarLowMcapPositionUsd;
    if (!(lowLeg1 > 0)) {
      errors.push('PAPER_LIVE_OSCAR_LOW_MCAP_ENTRY_SPLIT_LEG_USD must be > 0');
    }
    if (!(lowPos > 0)) {
      errors.push('PAPER_LIVE_OSCAR_LOW_MCAP_POSITION_USD must be > 0');
    }
    const lowSplitTotal = lowLeg1 + lowLeg2 + lowLeg3 + lowLeg4 + lowLeg5;
    if (lowLeg1 > 0 && lowPos > 0 && Math.abs(lowPos - lowSplitTotal) > 1e-6) {
      errors.push(
        `PAPER_LIVE_OSCAR_LOW_MCAP_POSITION_USD (${lowPos}) must equal leg1..leg5 sum (${lowSplitTotal})`,
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
  marketCapUsd?: number | null,
): void {
  if (st.copyLeaderAdoptStagedPlan) return;
  const leg1 = resolveLiveOscarEntrySplitLegUsd(cfg, tier, marketCapUsd);
  const avgUsd = resolveLiveOscarStagedAvgLegUsd(cfg, tier, marketCapUsd);
  const avg2Usd = resolveLiveOscarStagedAvgSecondLegUsd(cfg, tier, marketCapUsd);
  const avgDrop = resolveLiveOscarStagedAvgFirstDropPct(cfg, tier, marketCapUsd);
  const avg2Drop = resolveLiveOscarStagedAvgSecondDropPct(cfg, tier, marketCapUsd);
  st.firstLegUsd = leg1;
  st.entrySplitLegUsd = leg1;
  st.entrySplitLeg2Usd = resolveLiveOscarEntrySplitLeg2Usd(cfg, tier, marketCapUsd);
  st.entrySplitLeg3Usd = resolveLiveOscarEntrySplitLeg3Usd(cfg, tier, marketCapUsd);
  st.entrySplitLeg4Usd = resolveLiveOscarEntrySplitLeg4Usd(cfg, tier, marketCapUsd);
  st.entrySplitLeg5Usd = resolveLiveOscarEntrySplitLeg5Usd(cfg, tier, marketCapUsd);
  st.entrySplitLeg6Usd = resolveLiveOscarEntrySplitLeg6Usd(cfg, tier, marketCapUsd);
  st.entrySplitLeg7Usd = resolveLiveOscarEntrySplitLeg7Usd(cfg, tier, marketCapUsd);
  st.entrySplitLeg8Usd = resolveLiveOscarEntrySplitLeg8Usd(cfg, tier, marketCapUsd);
  for (let i = 2; i <= ENTRY_SPLIT_LEG_COUNT; i++) {
    const legIndex = i as EntrySplitLegIndex;
    const canonicalDisabled = entrySplitLegUsdFromState(st, legIndex) <= 0;
    const alreadyDone = entrySplitLegDoneFromState(st, legIndex);
    setEntrySplitLegDone(st, legIndex, canonicalDisabled || alreadyDone);
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
    } else {
      st.avgThirdLegUsd = 0;
      st.thirdLegUsd = 0;
      st.avgThirdDropPct = 0;
      st.thirdDropPct = 0;
    }
  }
}

/** Before live buy_open: first journal leg + staged plan must match canonical split. */
export function applyCanonicalOpenLegUsd(cfg: PaperTraderConfig, ot: OpenTrade): void {
  const st = ot.liveStagedEntry;
  if (!st?.entrySplitV2) return;
  const tier = resolveLiveOscarTradeTierFromOpen(cfg, ot);
  const mcap = ot.entryMarketCapUsd;
  applyCanonicalStagedEntrySizing(cfg, st, tier, mcap);
  const leg = resolveLiveOscarEntrySplitLegUsd(cfg, tier, mcap);
  const openLeg = ot.legs.find((l) => l.reason === 'open');
  const hasFilledBuy = (ot.entryLegSignatures?.length ?? 0) > 0;
  if (openLeg && !hasFilledBuy && openLeg.sizeUsd !== leg) {
    openLeg.sizeUsd = leg;
    ot.totalInvestedUsd = ot.legs.reduce((s, l) => s + l.sizeUsd, 0);
  }
}

/**
 * Hard per-position notional ceiling (USD) for a live-oscar position: the tier plan max,
 * optionally tightened by the global `liveOscarHardPositionMaxUsd` lever. Fed to the live
 * buy pipeline so cumulative on-chain buys are gated/clamped against the REAL wallet holding
 * (source of truth), preventing sliced-add runaways that over-buy past the plan cap.
 */
export function resolveLiveOscarPositionCeilingUsd(cfg: PaperTraderConfig, ot: OpenTrade): number {
  const tier = resolveLiveOscarTradeTierFromOpen(cfg, ot);
  const planMax = resolveLiveOscarStagedEntryMaxUsd(cfg, tier, ot.entryMarketCapUsd);
  const hardMax = cfg.liveOscarHardPositionMaxUsd ?? 0;
  if (hardMax > 0) {
    return planMax > 0 ? Math.min(planMax, hardMax) : hardMax;
  }
  return planMax;
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
