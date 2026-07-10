import type { AwakeningConfig } from './awakening-config.js';
import type { AwakeningDexMarket, AwakeningSignalResult } from './awakening-types.js';

function pos(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

type AwakeningSignalCfg = Pick<
  AwakeningConfig,
  | 'vol5mMinUsd'
  | 'minVol1hUsd'
  | 'maxVol24hUsd'
  | 'minPoolAgeMin'
  | 'volVelocityMin'
  | 'minMcapUsd'
  | 'minLiqUsd'
  | 'minBuyRatio'
  | 'maxPriceChangeH24Pct'
  | 'maxPriceChangeH6Pct'
  | 'minPriceChangeM5Pct'
  | 'minPriceChangeH24Pct'
  | 'minPriceChangeH6Pct'
  | 'minPriceChangeH1Pct'
  | 'minVol1hToVol6hRatio'
  | 'maxVol1hPerMcap'
>;

/**
 * Dormant-low awakening: first real volume on a previously quiet, aged coin —
 * NOT a one-shot pump that is already fading, NOT a multi-day downhill, and
 * NOT a cluster/wash spike. Pure function — no I/O.
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
    volVelocity,
    vol5mToVol1hRatio,
    vol1hToVol6hRatio,
    vol1hPerMcap,
    poolAgeMin,
    buyRatio,
  };

  // --- Coin must be aged (no fresh one-shot pump.fun launches) ---
  if (poolAgeMin == null || poolAgeMin < cfg.minPoolAgeMin) {
    reasons.push(`pool_age<${cfg.minPoolAgeMin}m`);
  }

  // --- Enough real volume, not a micro-blip ---
  if (vol5m < cfg.vol5mMinUsd) {
    reasons.push(`vol5m<${cfg.vol5mMinUsd}`);
  }
  if (vol1h < cfg.minVol1hUsd) {
    reasons.push(`vol1h<${cfg.minVol1hUsd}`);
  }

  // --- Was actually quiet over the last day (dormancy baseline) ---
  // NOTE: dormancy is measured on the 24h window. The prior-6h/vol1h micro
  // thresholds are kept only as journaled metrics; gating on them is impossible
  // alongside a real awakening (vol6h >= vol1h), so they are not pass/fail here.
  if (vol24h > cfg.maxVol24hUsd) {
    reasons.push(`vol24h>${cfg.maxVol24hUsd}`);
  }

  // --- Volume must still be live right now, not rolling off after a burst ---
  if (volVelocity < cfg.volVelocityMin) {
    reasons.push(`vol_velocity<${cfg.volVelocityMin}`);
  }
  if (vol1hToVol6hRatio != null && vol1hToVol6hRatio < cfg.minVol1hToVol6hRatio) {
    // vol1h tiny vs vol6h => the pump already happened and is fading.
    reasons.push(`vol1h/vol6h<${cfg.minVol1hToVol6hRatio}`);
  }

  // --- Wash/cluster proxy: absurd hourly turnover relative to mcap ---
  if (vol1hPerMcap != null && vol1hPerMcap > cfg.maxVol1hPerMcap) {
    reasons.push(`vol1h/mcap>${cfg.maxVol1hPerMcap}`);
  }

  // --- Basic market health ---
  if (mcap == null || mcap < cfg.minMcapUsd) {
    reasons.push(`mcap<${cfg.minMcapUsd}`);
  }
  if (liq == null || liq < cfg.minLiqUsd) {
    reasons.push(`liq<${cfg.minLiqUsd}`);
  }
  if (buyRatio == null || buyRatio < cfg.minBuyRatio) {
    reasons.push(`buy_ratio<${cfg.minBuyRatio}`);
  }

  // --- Not already at multi-day highs (chasing a top) ---
  const h24 = market.priceChangeH24;
  if (h24 != null && h24 > cfg.maxPriceChangeH24Pct) {
    reasons.push(`price_h24>${cfg.maxPriceChangeH24Pct}`);
  }
  const h6 = market.priceChangeH6;
  if (h6 != null && h6 > cfg.maxPriceChangeH6Pct) {
    reasons.push(`price_h6>${cfg.maxPriceChangeH6Pct}`);
  }

  // --- Not a multi-hour downhill / falling knife ---
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

  // --- Turning up right now ---
  const m5 = market.priceChangeM5;
  if (m5 != null && m5 < cfg.minPriceChangeM5Pct) {
    reasons.push(`price_m5<${cfg.minPriceChangeM5Pct}`);
  }

  return {
    pass: reasons.length === 0,
    reasons,
    metrics,
  };
}
