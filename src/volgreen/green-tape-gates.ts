/**
 * Leader-like green-tape / turnover entry (8zkg-style), not dormant awakening.
 *
 * Pass when the 5m candle is green with real buy pressure and pool turnover —
 * without requiring a quiet prior baseline.
 */
export type GreenTapeGates = {
  /** Exclusive lower bound for Dex priceChange.m5 (default 0 → must be green). */
  minPc5mPct: number;
  /** Inclusive upper bound — reject chase (default 15). */
  maxPc5mPct: number;
  minVolume5mUsd: number;
  minLiquidityUsd: number;
  minMarketCapUsd: number;
  maxMarketCapUsd: number;
  /** buys5m / sells5m (default 1.0). */
  minBuySellRatio5m: number;
  /** volume5m / liquidity (default 0.09). 0 = off. */
  minTurnover5m: number;
  minPairAgeHours: number;
  /** 0 = no max. */
  maxPairAgeHours: number;
  allowedDexIds: string[];
};

export type GreenTapeMetrics = {
  priceChange5mPct: number | null;
  volume5mUsd: number | null;
  liquidityUsd: number | null;
  marketCapUsd: number | null;
  pairAgeHours: number | null;
  dexId: string | null;
  buys5m: number | null;
  sells5m: number | null;
};

export type GreenTapeVerdict = {
  pass: boolean;
  reasons: string[];
  buySellRatio5m: number | null;
  turnover5m: number | null;
};

export function evaluateGreenTapeEntry(
  metrics: GreenTapeMetrics,
  gates: GreenTapeGates,
): GreenTapeVerdict {
  const reasons: string[] = [];
  const pc = metrics.priceChange5mPct;
  if (pc == null || !Number.isFinite(pc)) {
    reasons.push('missing_price_change_5m');
  } else if (!(pc > gates.minPc5mPct && pc <= gates.maxPc5mPct)) {
    reasons.push(`pc5m=${pc.toFixed(2)}_outside_(${gates.minPc5mPct},${gates.maxPc5mPct}]`);
  }

  if (gates.minVolume5mUsd > 0) {
    const v = metrics.volume5mUsd;
    if (v == null || !Number.isFinite(v)) reasons.push('missing_volume_5m');
    else if (v < gates.minVolume5mUsd) reasons.push(`vol5m=${v.toFixed(0)}<${gates.minVolume5mUsd}`);
  }

  if (gates.minLiquidityUsd > 0) {
    const liq = metrics.liquidityUsd;
    if (liq == null || !Number.isFinite(liq)) reasons.push('missing_liquidity');
    else if (liq < gates.minLiquidityUsd) reasons.push(`liq=${liq.toFixed(0)}<${gates.minLiquidityUsd}`);
  }

  if (gates.minMarketCapUsd > 0 || gates.maxMarketCapUsd > 0) {
    const mcap = metrics.marketCapUsd;
    if (mcap == null || !Number.isFinite(mcap) || mcap <= 0) {
      reasons.push('missing_mcap');
    } else {
      if (gates.minMarketCapUsd > 0 && mcap < gates.minMarketCapUsd) {
        reasons.push(`mcap=${mcap.toFixed(0)}<${gates.minMarketCapUsd}`);
      }
      if (gates.maxMarketCapUsd > 0 && mcap > gates.maxMarketCapUsd) {
        reasons.push(`mcap=${mcap.toFixed(0)}>${gates.maxMarketCapUsd}`);
      }
    }
  }

  let buySellRatio5m: number | null = null;
  if (gates.minBuySellRatio5m > 0) {
    const buys = metrics.buys5m;
    const sells = metrics.sells5m;
    if (buys == null || sells == null || !Number.isFinite(buys) || !Number.isFinite(sells)) {
      reasons.push('buy_sell_unknown');
    } else {
      buySellRatio5m = buys / Math.max(1, sells);
      if (buySellRatio5m < gates.minBuySellRatio5m) {
        reasons.push(`buy_sell_5m=${buySellRatio5m.toFixed(2)}<${gates.minBuySellRatio5m}`);
      }
    }
  }

  let turnover5m: number | null = null;
  if (gates.minTurnover5m > 0) {
    const vol = metrics.volume5mUsd;
    const liq = metrics.liquidityUsd;
    if (vol == null || liq == null || !(liq > 0)) {
      reasons.push('turnover_unknown');
    } else {
      turnover5m = vol / liq;
      if (turnover5m < gates.minTurnover5m) {
        reasons.push(`turnover_5m=${turnover5m.toFixed(3)}<${gates.minTurnover5m}`);
      }
    }
  }

  if (gates.minPairAgeHours > 0 || gates.maxPairAgeHours > 0) {
    const age = metrics.pairAgeHours;
    if (age == null || !Number.isFinite(age)) {
      reasons.push('missing_pair_age');
    } else {
      if (gates.minPairAgeHours > 0 && age < gates.minPairAgeHours) {
        reasons.push(`age_h=${age.toFixed(2)}<${gates.minPairAgeHours}`);
      }
      if (gates.maxPairAgeHours > 0 && age > gates.maxPairAgeHours) {
        reasons.push(`age_h=${age.toFixed(2)}>${gates.maxPairAgeHours}`);
      }
    }
  }

  if (gates.allowedDexIds.length > 0) {
    const dex = (metrics.dexId ?? '').toLowerCase();
    if (!dex || !gates.allowedDexIds.includes(dex)) {
      reasons.push(`dex=${metrics.dexId ?? 'null'}_not_allowed`);
    }
  }

  return { pass: reasons.length === 0, reasons, buySellRatio5m, turnover5m };
}
