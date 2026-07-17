import type { AwakeningConfig } from './awakening-config.js';
import type { AwakeningDexMarket, AwakeningSignalResult } from './awakening-types.js';

function pos(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Five-minute buckets in (6h − 5m) and (1h − 5m) DexScreener windows. */
const PRIOR_6H_5M_BUCKETS = 71;
const PRIOR_1H_5M_BUCKETS = 12;
const PRIOR_6H_HOURLY_BUCKETS = 6;

type AwakeningSignalCfg = Pick<
  AwakeningConfig,
  | 'vol5mMinUsd'
  | 'maxVol24hUsd'
  | 'minPoolAgeMin'
  | 'vol5mSpikeMinMult'
  | 'vol5mSpikeVs1hMinMult'
  | 'quietPrior5mAvgFloorUsd'
  | 'minMcapUsd'
  | 'minLiqUsd'
  | 'minBuyRatio'
  | 'buyRatioSpikeBypass'
  | 'minPriceChangeM5IgnitionPct'
  | 'maxPriceChangeH24Pct'
  | 'maxPriceChangeH6Pct'
  | 'minPriceChangeM5Pct'
  | 'minPriceChangeH24Pct'
  | 'minPriceChangeH6Pct'
  | 'minPriceChangeH1Pct'
  | 'maxVol1hPerMcap'
  | 'maxVol5mToVol1hRatio'
  | 'lateBurstMinVol1hUsd'
  | 'miniPumpPeakVol5mToVol1hMin'
  | 'miniPumpPeakSpike6hMin'
  | 'quietPriorVol6hMaxUsd'
  | 'quietVol1hMaxUsd'
  | 'minVol1hUsd'
  | 'gradualAwakeningEnabled'
  | 'gradualVol5mSpike6hMult'
  | 'gradualVol1hSpikeVs6hMult'
  | 'gradualMaxPriceChangeH6Pct'
  | 'gradualMaxPriceChangeH24Pct'
  | 'gradualMaxVol5mSpikeVs1hMult'
  | 'gradualMaxPriceChangeM5Pct'
  | 'quietPriorReIgnitionSpike6hMult'
  | 'earlySpikeEnabled'
  | 'earlySpikeVol5mSpike6hMult'
  | 'earlySpikeVol5mSpike1hMult'
  | 'earlySpikeMaxVol1hUsd'
  | 'earlySpikeMinPriceChangeM5Pct'
  | 'earlySpikeTailMinVol1hUsd'
  | 'gradualMaxVol5mSpikeVs1hMult'
>;

export type AwakeningEntryPath = 'early_spike' | 'ignition' | 'gradual';

export interface AwakeningComputedMetrics {
  vol5mUsd: number;
  vol1hUsd: number;
  vol6hUsd: number;
  vol24hUsd: number;
  priorVol6hUsd: number;
  priorVol1hUsd: number;
  prior6h5mAvgUsd: number;
  prior1h5mAvgUsd: number;
  vol5mSpikeVs6hMult: number;
  vol5mSpikeVs1hMult: number;
  vol1hSpikeVs6hHourlyMult: number;
  volVelocity: number;
  vol5mToVol1hRatio: number | null;
  vol1hToVol6hRatio: number | null;
  vol1hPerMcap: number | null;
  poolAgeMin: number | null;
  buyRatio: number | null;
  entryPath?: AwakeningEntryPath;
}

function computeMetrics(cfg: AwakeningSignalCfg, market: AwakeningDexMarket): AwakeningComputedMetrics {
  const vol5m = pos(market.volume5mUsd) ?? 0;
  const vol1h = pos(market.volume1hUsd) ?? 0;
  const vol6h = pos(market.volume6hUsd) ?? 0;
  const vol24h = pos(market.volume24hUsd) ?? 0;
  const mcap = pos(market.marketCapUsd);

  const priorVol6h = Math.max(0, vol6h - vol5m);
  const priorVol1h = Math.max(0, vol1h - vol5m);
  const quietFloor = cfg.quietPrior5mAvgFloorUsd;
  const prior6h5mAvg = priorVol6h / PRIOR_6H_5M_BUCKETS;
  const prior1h5mAvg = priorVol1h / PRIOR_1H_5M_BUCKETS;
  const vol5mSpikeVs6hMult = vol5m / Math.max(prior6h5mAvg, quietFloor);
  const vol5mSpikeVs1hMult = vol5m / Math.max(prior1h5mAvg, quietFloor);
  const prior6hHourlyAvg = priorVol6h / PRIOR_6H_HOURLY_BUCKETS;
  const vol1hSpikeVs6hHourlyMult = vol1h / Math.max(prior6hHourlyAvg, quietFloor * PRIOR_1H_5M_BUCKETS);

  const buys = market.buys5m ?? 0;
  const sells = market.sells5m ?? 0;
  const txnTotal = buys + sells;

  return {
    vol5mUsd: vol5m,
    vol1hUsd: vol1h,
    vol6hUsd: vol6h,
    vol24hUsd: vol24h,
    priorVol6hUsd: priorVol6h,
    priorVol1hUsd: priorVol1h,
    prior6h5mAvgUsd: prior6h5mAvg,
    prior1h5mAvgUsd: prior1h5mAvg,
    vol5mSpikeVs6hMult,
    vol5mSpikeVs1hMult,
    vol1hSpikeVs6hHourlyMult,
    volVelocity: vol5m / Math.max(vol1h, 1),
    vol5mToVol1hRatio: vol1h > 0 ? vol5m / vol1h : null,
    vol1hToVol6hRatio: vol6h > 0 ? vol1h / vol6h : null,
    vol1hPerMcap: mcap != null && mcap > 0 ? vol1h / mcap : null,
    poolAgeMin: market.poolAgeMin,
    buyRatio: txnTotal > 0 ? buys / txnTotal : null,
  };
}

function pushCommonGates(
  cfg: AwakeningSignalCfg,
  market: AwakeningDexMarket,
  metrics: AwakeningComputedMetrics,
  reasons: string[],
): void {
  const mcap = pos(market.marketCapUsd);
  const liq = pos(market.liquidityUsd);

  if (metrics.poolAgeMin == null || metrics.poolAgeMin < cfg.minPoolAgeMin) {
    reasons.push(`pool_age<${cfg.minPoolAgeMin}m`);
  }
  if (metrics.vol24hUsd > cfg.maxVol24hUsd) {
    reasons.push(`vol24h>${cfg.maxVol24hUsd}`);
  }
  if (metrics.vol1hPerMcap != null && metrics.vol1hPerMcap > cfg.maxVol1hPerMcap) {
    reasons.push(`vol1h/mcap>${cfg.maxVol1hPerMcap}`);
  }
  if (mcap == null || mcap < cfg.minMcapUsd) {
    reasons.push(`mcap<${cfg.minMcapUsd}`);
  }
  if (liq == null || liq < cfg.minLiqUsd) {
    reasons.push(`liq<${cfg.minLiqUsd}`);
  }

  const h24 = market.priceChangeH24;
  if (h24 != null && h24 < cfg.minPriceChangeH24Pct) {
    reasons.push(`price_h24<${cfg.minPriceChangeH24Pct}`);
  }
  const h6 = market.priceChangeH6;
  if (h6 != null && h6 < cfg.minPriceChangeH6Pct) {
    reasons.push(`price_h6<${cfg.minPriceChangeH6Pct}`);
  }
  const h1 = market.priceChangeH1;
  if (h1 != null && h1 < cfg.minPriceChangeH1Pct) {
    reasons.push(`price_h1<${cfg.minPriceChangeH1Pct}`);
  }
}

function pushLateBurstBlock(
  cfg: AwakeningSignalCfg,
  metrics: AwakeningComputedMetrics,
  reasons: string[],
): void {
  if (
    metrics.vol5mToVol1hRatio != null &&
    metrics.vol1hUsd >= cfg.lateBurstMinVol1hUsd &&
    metrics.vol5mToVol1hRatio > cfg.maxVol5mToVol1hRatio
  ) {
    reasons.push(`late_burst_vol5m/vol1h>${cfg.maxVol5mToVol1hRatio}`);
  }
}

/** 2× green 2m + red 3rd: vol squeezed into last 5m on huge spike (works even when vol1h is tiny). */
export function isAwakeningMiniPumpPeak(
  cfg: Pick<AwakeningConfig, 'miniPumpPeakVol5mToVol1hMin' | 'miniPumpPeakSpike6hMin'>,
  metrics: Pick<AwakeningComputedMetrics, 'vol5mToVol1hRatio' | 'vol5mSpikeVs6hMult'>,
): boolean {
  return (
    metrics.vol5mToVol1hRatio != null &&
    metrics.vol5mToVol1hRatio >= cfg.miniPumpPeakVol5mToVol1hMin &&
    metrics.vol5mSpikeVs6hMult >= cfg.miniPumpPeakSpike6hMin
  );
}

function pushMiniPumpPeakBlock(
  cfg: AwakeningSignalCfg,
  metrics: AwakeningComputedMetrics,
  reasons: string[],
): void {
  if (isAwakeningMiniPumpPeak(cfg, metrics)) {
    reasons.push(
      `mini_pump_peak:vol5m/vol1h>=${cfg.miniPumpPeakVol5mToVol1hMin},spike6h>=${cfg.miniPumpPeakSpike6hMin}`,
    );
  }
}

function pushBuyRatioGate(
  cfg: AwakeningSignalCfg,
  market: AwakeningDexMarket,
  metrics: AwakeningComputedMetrics,
  ignitionBurst: boolean,
  reasons: string[],
): void {
  const m5 = market.priceChangeM5;
  const ignitionPriceOk = m5 == null || m5 >= cfg.minPriceChangeM5IgnitionPct;
  if (metrics.buyRatio == null || metrics.buyRatio < cfg.minBuyRatio) {
    const bypassBuyRatio = cfg.buyRatioSpikeBypass && ignitionBurst && ignitionPriceOk;
    if (!bypassBuyRatio) {
      reasons.push(`buy_ratio<${cfg.minBuyRatio}`);
    }
  }
}

/** Confirmed vol5m burst vs quiet prior — re-awakening ignition shape. */
export function isAwakeningIgnitionBurst(
  cfg: Pick<AwakeningConfig, 'vol5mMinUsd' | 'vol5mSpikeMinMult' | 'vol5mSpikeVs1hMinMult'>,
  metrics: { vol5mUsd: number; vol5mSpikeVs6hMult: number; vol5mSpikeVs1hMult: number },
): boolean {
  return (
    metrics.vol5mUsd >= cfg.vol5mMinUsd &&
    metrics.vol5mSpikeVs6hMult >= cfg.vol5mSpikeMinMult &&
    metrics.vol5mSpikeVs1hMult >= cfg.vol5mSpikeVs1hMinMult
  );
}

function evaluateEarlySpikePath(
  cfg: AwakeningSignalCfg,
  market: AwakeningDexMarket,
  metrics: AwakeningComputedMetrics,
): string[] {
  const reasons: string[] = [];
  if (!cfg.earlySpikeEnabled) {
    reasons.push('early_spike_disabled');
    return reasons;
  }

  const mcap = pos(market.marketCapUsd);
  const liq = pos(market.liquidityUsd);
  if (metrics.poolAgeMin == null || metrics.poolAgeMin < cfg.minPoolAgeMin) {
    reasons.push(`pool_age<${cfg.minPoolAgeMin}m`);
  }
  if (metrics.vol24hUsd > cfg.maxVol24hUsd) {
    reasons.push(`vol24h>${cfg.maxVol24hUsd}`);
  }
  if (mcap == null || mcap < cfg.minMcapUsd) {
    reasons.push(`mcap<${cfg.minMcapUsd}`);
  }
  if (liq == null || liq < cfg.minLiqUsd) {
    reasons.push(`liq<${cfg.minLiqUsd}`);
  }
  if (metrics.vol5mUsd < cfg.vol5mMinUsd) {
    reasons.push(`vol5m<${cfg.vol5mMinUsd}`);
  }
  if (metrics.vol5mSpikeVs6hMult < cfg.earlySpikeVol5mSpike6hMult) {
    reasons.push(`early_spike_6h<${cfg.earlySpikeVol5mSpike6hMult}`);
  }
  if (metrics.vol5mSpikeVs1hMult < cfg.earlySpikeVol5mSpike1hMult) {
    reasons.push(`early_spike_1h<${cfg.earlySpikeVol5mSpike1hMult}`);
  }
  if (metrics.vol1hUsd > cfg.earlySpikeMaxVol1hUsd) {
    reasons.push(`early_vol1h>${cfg.earlySpikeMaxVol1hUsd}`);
  }
  if (
    metrics.vol1hUsd >= cfg.earlySpikeTailMinVol1hUsd &&
    metrics.vol5mSpikeVs1hMult > cfg.gradualMaxVol5mSpikeVs1hMult
  ) {
    reasons.push(`early_spike_1h_tail>${cfg.gradualMaxVol5mSpikeVs1hMult}`);
  }

  const m5 = market.priceChangeM5;
  if (m5 != null && m5 < cfg.earlySpikeMinPriceChangeM5Pct) {
    reasons.push(`early_price_m5<${cfg.earlySpikeMinPriceChangeM5Pct}`);
  }
  if (m5 != null && m5 < -3) {
    reasons.push('early_price_m5_red_candle');
  }

  const earlyBurst =
    metrics.vol5mUsd >= cfg.vol5mMinUsd &&
    metrics.vol5mSpikeVs6hMult >= cfg.earlySpikeVol5mSpike6hMult &&
    metrics.vol5mSpikeVs1hMult >= cfg.earlySpikeVol5mSpike1hMult;
  pushBuyRatioGate(cfg, market, metrics, earlyBurst, reasons);
  return reasons;
}

function evaluateIgnitionPath(
  cfg: AwakeningSignalCfg,
  market: AwakeningDexMarket,
  metrics: AwakeningComputedMetrics,
): string[] {
  const reasons: string[] = [];
  pushCommonGates(cfg, market, metrics, reasons);
  pushLateBurstBlock(cfg, metrics, reasons);
  pushMiniPumpPeakBlock(cfg, metrics, reasons);

  if (metrics.vol5mUsd < cfg.vol5mMinUsd) {
    reasons.push(`vol5m<${cfg.vol5mMinUsd}`);
  }
  if (
    metrics.priorVol6hUsd > cfg.quietPriorVol6hMaxUsd &&
    metrics.vol1hUsd > cfg.quietVol1hMaxUsd &&
    metrics.vol5mSpikeVs6hMult < cfg.quietPriorReIgnitionSpike6hMult
  ) {
    reasons.push(`prior6h_quiet>${cfg.quietPriorVol6hMaxUsd}`);
  }
  if (metrics.vol5mSpikeVs6hMult < cfg.vol5mSpikeMinMult) {
    reasons.push(`vol5m_spike_6h<${cfg.vol5mSpikeMinMult}`);
  }
  if (metrics.vol5mSpikeVs1hMult < cfg.vol5mSpikeVs1hMinMult) {
    reasons.push(`vol5m_spike_1h<${cfg.vol5mSpikeVs1hMinMult}`);
  }

  const h24 = market.priceChangeH24;
  if (h24 != null && h24 > cfg.maxPriceChangeH24Pct) {
    reasons.push(`price_h24>${cfg.maxPriceChangeH24Pct}`);
  }
  const h6 = market.priceChangeH6;
  if (h6 != null && h6 > cfg.maxPriceChangeH6Pct) {
    reasons.push(`price_h6>${cfg.maxPriceChangeH6Pct}`);
  }

  const m5 = market.priceChangeM5;
  if (m5 != null && m5 < cfg.minPriceChangeM5Pct) {
    reasons.push(`price_m5<${cfg.minPriceChangeM5Pct}`);
  }

  const ignitionBurst = isAwakeningIgnitionBurst(cfg, metrics);
  pushBuyRatioGate(cfg, market, metrics, ignitionBurst, reasons);
  return reasons;
}

function evaluateGradualPath(
  cfg: AwakeningSignalCfg,
  market: AwakeningDexMarket,
  metrics: AwakeningComputedMetrics,
): string[] {
  const reasons: string[] = [];
  if (!cfg.gradualAwakeningEnabled) {
    reasons.push('gradual_disabled');
    return reasons;
  }

  pushCommonGates(cfg, market, metrics, reasons);
  pushLateBurstBlock(cfg, metrics, reasons);
  pushMiniPumpPeakBlock(cfg, metrics, reasons);

  if (metrics.vol5mUsd < cfg.vol5mMinUsd) {
    reasons.push(`vol5m<${cfg.vol5mMinUsd}`);
  }
  if (metrics.vol1hUsd < cfg.minVol1hUsd) {
    reasons.push(`vol1h<${cfg.minVol1hUsd}`);
  }

  const volGrowing =
    metrics.vol5mSpikeVs6hMult >= cfg.gradualVol5mSpike6hMult ||
    metrics.vol1hSpikeVs6hHourlyMult >= cfg.gradualVol1hSpikeVs6hMult;
  if (!volGrowing) {
    reasons.push(
      `gradual_vol<sp6:${cfg.gradualVol5mSpike6hMult}|vh6:${cfg.gradualVol1hSpikeVs6hMult}`,
    );
  }
  if (metrics.vol5mSpikeVs1hMult > cfg.gradualMaxVol5mSpikeVs1hMult) {
    reasons.push(`gradual_spike_1h>${cfg.gradualMaxVol5mSpikeVs1hMult}`);
  }

  const h24 = market.priceChangeH24;
  if (h24 != null && h24 > cfg.gradualMaxPriceChangeH24Pct) {
    reasons.push(`gradual_price_h24>${cfg.gradualMaxPriceChangeH24Pct}`);
  }
  const h6 = market.priceChangeH6;
  if (h6 != null && h6 > cfg.gradualMaxPriceChangeH6Pct) {
    reasons.push(`gradual_price_h6>${cfg.gradualMaxPriceChangeH6Pct}`);
  }

  const m5 = market.priceChangeM5;
  if (m5 != null && m5 < cfg.minPriceChangeM5Pct) {
    reasons.push(`price_m5<${cfg.minPriceChangeM5Pct}`);
  }
  if (m5 != null && m5 > cfg.gradualMaxPriceChangeM5Pct) {
    reasons.push(`gradual_price_m5>${cfg.gradualMaxPriceChangeM5Pct}`);
  }

  const gradualBurst =
    metrics.vol5mUsd >= cfg.vol5mMinUsd &&
    (metrics.vol5mSpikeVs6hMult >= cfg.gradualVol5mSpike6hMult ||
      metrics.vol1hSpikeVs6hHourlyMult >= cfg.gradualVol1hSpikeVs6hMult);
  pushBuyRatioGate(cfg, market, metrics, gradualBurst, reasons);
  return reasons;
}

/** Spike passed but only soft gates (buy_ratio / m5) blocked — retry soon. */
export function isAwakeningNearMiss(reasons: string[]): boolean {
  if (reasons.length === 0) return false;
  const hardFail = reasons.some(
    (r) =>
      r.startsWith('vol5m_spike_') ||
      r.startsWith('early_spike_') ||
      r.startsWith('early_vol1h>') ||
      r.startsWith('gradual_vol<') ||
      r.startsWith('late_burst_') ||
      r.startsWith('mini_pump_peak:') ||
      r.startsWith('prior6h_quiet>') ||
      r.startsWith('vol1h_quiet>') ||
      r.startsWith('gradual_spike_1h>'),
  );
  if (hardFail) return false;
  return reasons.every(
    (r) =>
      r.startsWith('buy_ratio<') ||
      r.startsWith('price_m5<') ||
      r.startsWith('gradual_price_m5>'),
  );
}

export function awakeningEvalCooldownMs(
  cfg: Pick<AwakeningConfig, 'candidateCooldownMs' | 'candidateNearMissCooldownMs' | 'candidateFailCooldownMs'>,
  verdict: AwakeningSignalResult,
): number {
  if (verdict.pass) return cfg.candidateCooldownMs;
  if (isAwakeningNearMiss(verdict.reasons)) return cfg.candidateNearMissCooldownMs;
  return cfg.candidateFailCooldownMs;
}

/**
 * Dormant-low awakening: ignition burst on quiet prior OR gradual vol build
 * with modest price rise before retail pump — NOT late-burst peak entries.
 */
export function evaluateAwakeningSignal(
  cfg: AwakeningSignalCfg,
  market: AwakeningDexMarket,
): AwakeningSignalResult {
  const metrics = computeMetrics(cfg, market);
  const earlyReasons = evaluateEarlySpikePath(cfg, market, metrics);
  const ignitionReasons = evaluateIgnitionPath(cfg, market, metrics);
  const gradualReasons = evaluateGradualPath(cfg, market, metrics);

  if (earlyReasons.length === 0) {
    return {
      pass: true,
      reasons: [],
      metrics: { ...metrics, entryPath: 'early_spike' },
    };
  }
  if (ignitionReasons.length === 0) {
    return {
      pass: true,
      reasons: [],
      metrics: { ...metrics, entryPath: 'ignition' },
    };
  }
  if (gradualReasons.length === 0) {
    return {
      pass: true,
      reasons: [],
      metrics: { ...metrics, entryPath: 'gradual' },
    };
  }

  const merged = [...new Set([...earlyReasons, ...ignitionReasons, ...gradualReasons])];
  return {
    pass: false,
    reasons: merged,
    metrics,
  };
}
