import type { AwakeningConfig } from './awakening-config.js';
import type { AwakeningDexMarket, AwakeningSignalResult } from './awakening-types.js';

function pos(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Five-minute buckets in (6h − 5m) and (1h − 5m) DexScreener windows. */
const PRIOR_6H_5M_BUCKETS = 71;
const PRIOR_1H_5M_BUCKETS = 12;

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
>;

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

/** Spike passed but only soft gates (buy_ratio / m5) blocked — retry soon. */
export function isAwakeningNearMiss(reasons: string[]): boolean {
  if (reasons.length === 0) return false;
  const spikeFailed = reasons.some((r) => r.startsWith('vol5m_spike_'));
  if (spikeFailed) return false;
  return reasons.every((r) => r.startsWith('buy_ratio<') || r.startsWith('price_m5<'));
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
 * Dormant-low awakening: first real vol5m burst on a previously quiet, aged coin —
 * NOT a one-shot pump that is already fading, NOT a multi-day downhill, and
 * NOT mid-rally continuation after vol1h has already accumulated.
 * Pure function — no I/O.
 */
export function evaluateAwakeningSignal(
  cfg: AwakeningSignalCfg,
  market: AwakeningDexMarket,
): AwakeningSignalResult {
  const reasons: string[] = [];

  const vol5m = pos(market.volume5mUsd) ?? 0;
  const vol1h = pos(market.volume1hUsd) ?? 0;
  const vol6h = pos(market.volume6hUsd) ?? 0;
  const vol24h = pos(market.volume24hUsd) ?? 0;
  const mcap = pos(market.marketCapUsd);
  const liq = pos(market.liquidityUsd);
  const poolAgeMin = market.poolAgeMin;

  const priorVol6h = Math.max(0, vol6h - vol5m);
  const priorVol1h = Math.max(0, vol1h - vol5m);
  const quietFloor = cfg.quietPrior5mAvgFloorUsd;
  const prior6h5mAvg = priorVol6h / PRIOR_6H_5M_BUCKETS;
  const prior1h5mAvg = priorVol1h / PRIOR_1H_5M_BUCKETS;
  const vol5mSpikeVs6hMult = vol5m / Math.max(prior6h5mAvg, quietFloor);
  const vol5mSpikeVs1hMult = vol5m / Math.max(prior1h5mAvg, quietFloor);

  const volVelocity = vol5m / Math.max(vol1h, 1);
  const vol5mToVol1hRatio = vol1h > 0 ? vol5m / vol1h : null;
  const vol1hToVol6hRatio = vol6h > 0 ? vol1h / vol6h : null;
  const vol1hPerMcap = mcap != null && mcap > 0 ? vol1h / mcap : null;

  const buys = market.buys5m ?? 0;
  const sells = market.sells5m ?? 0;
  const txnTotal = buys + sells;
  const buyRatio = txnTotal > 0 ? buys / txnTotal : null;

  const metrics = {
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
    volVelocity,
    vol5mToVol1hRatio,
    vol1hToVol6hRatio,
    vol1hPerMcap,
    poolAgeMin,
    buyRatio,
  };

  if (poolAgeMin == null || poolAgeMin < cfg.minPoolAgeMin) {
    reasons.push(`pool_age<${cfg.minPoolAgeMin}m`);
  }

  if (vol5m < cfg.vol5mMinUsd) {
    reasons.push(`vol5m<${cfg.vol5mMinUsd}`);
  }

  // Early trigger: live vol5m vs quiet prior baseline — not accumulated vol1h floor.
  if (vol5mSpikeVs6hMult < cfg.vol5mSpikeMinMult) {
    reasons.push(`vol5m_spike_6h<${cfg.vol5mSpikeMinMult}`);
  }
  if (vol5mSpikeVs1hMult < cfg.vol5mSpikeVs1hMinMult) {
    reasons.push(`vol5m_spike_1h<${cfg.vol5mSpikeVs1hMinMult}`);
  }

  if (vol24h > cfg.maxVol24hUsd) {
    reasons.push(`vol24h>${cfg.maxVol24hUsd}`);
  }

  if (vol1hPerMcap != null && vol1hPerMcap > cfg.maxVol1hPerMcap) {
    reasons.push(`vol1h/mcap>${cfg.maxVol1hPerMcap}`);
  }

  if (mcap == null || mcap < cfg.minMcapUsd) {
    reasons.push(`mcap<${cfg.minMcapUsd}`);
  }
  if (liq == null || liq < cfg.minLiqUsd) {
    reasons.push(`liq<${cfg.minLiqUsd}`);
  }
  const m5 = market.priceChangeM5;
  const ignitionBurst = isAwakeningIgnitionBurst(cfg, metrics);
  const ignitionPriceOk =
    m5 == null || m5 >= cfg.minPriceChangeM5IgnitionPct;

  if (buyRatio == null || buyRatio < cfg.minBuyRatio) {
    const bypassBuyRatio =
      cfg.buyRatioSpikeBypass && ignitionBurst && ignitionPriceOk;
    if (!bypassBuyRatio) {
      reasons.push(`buy_ratio<${cfg.minBuyRatio}`);
    }
  }

  const h24 = market.priceChangeH24;
  if (h24 != null && h24 > cfg.maxPriceChangeH24Pct) {
    reasons.push(`price_h24>${cfg.maxPriceChangeH24Pct}`);
  }
  const h6 = market.priceChangeH6;
  if (h6 != null && h6 > cfg.maxPriceChangeH6Pct) {
    reasons.push(`price_h6>${cfg.maxPriceChangeH6Pct}`);
  }

  if (h24 != null && h24 < cfg.minPriceChangeH24Pct) {
    reasons.push(`price_h24<${cfg.minPriceChangeH24Pct}`);
  }
  if (h6 != null && h6 < cfg.minPriceChangeH6Pct) {
    reasons.push(`price_h6<${cfg.minPriceChangeH6Pct}`);
  }
  const h1 = market.priceChangeH1;
  if (h1 != null && h1 < cfg.minPriceChangeH1Pct) {
    reasons.push(`price_h1<${cfg.minPriceChangeH1Pct}`);
  }

  if (m5 != null && m5 < cfg.minPriceChangeM5Pct) {
    reasons.push(`price_m5<${cfg.minPriceChangeM5Pct}`);
  }

  return {
    pass: reasons.length === 0,
    reasons,
    metrics,
  };
}
