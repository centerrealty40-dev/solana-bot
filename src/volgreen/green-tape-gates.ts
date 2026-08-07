/**
 * Leader-like green-tape entry (8zkg-style).
 *
 * Paths (OR), simple model first:
 * - **impulse** — ignore tiny greens; buy once 5m green is "large enough" (uncapped)
 * - **liquid** — calmer green with fat absolute vol + turnover (band-capped)
 * - **early** — thinner/faster green with strong buy/sell
 * - **rocket** — extreme vol/turnover vertical
 */
export type GreenTapeGates = {
  /** Shared structural floors. */
  minLiquidityUsd: number;
  minMarketCapUsd: number;
  maxMarketCapUsd: number;
  minPairAgeHours: number;
  /** 0 = no max. */
  maxPairAgeHours: number;
  allowedDexIds: string[];

  /**
   * Impulse — "large green candle → buy" (leader mental model).
   * 0 minPc = path disabled. maxPc 0 = uncapped.
   */
  impulseMinPc5mPct: number;
  impulseMaxPc5mPct: number;
  impulseMinVolume5mUsd: number;
  impulseMinBuySellRatio5m: number;
  impulseMinTurnover5m: number;

  /** Liquid path (fat tape). */
  liquidMinPc5mPct: number;
  liquidMaxPc5mPct: number;
  liquidMinVolume5mUsd: number;
  liquidMinBuySellRatio5m: number;
  liquidMinTurnover5m: number;
  /**
   * Mid-band liquid (pc5m in (lo, hi]) — 8h RCA: 10–25% was false-green noise.
   * When `liquidMidMinBuySellRatio5m` > 0, require stronger bs/turnover in-band.
   */
  liquidMidPc5mLo: number;
  liquidMidPc5mHi: number;
  liquidMidMinBuySellRatio5m: number;
  liquidMidMinTurnover5m: number;

  /** Early path (thin aggressive green). */
  earlyMinPc5mPct: number;
  earlyMaxPc5mPct: number;
  earlyMinVolume5mUsd: number;
  earlyMinBuySellRatio5m: number;
  earlyMinTurnover5m: number;
  earlyMinMarketCapUsd: number;

  /** Rocket path — catch leader entries into already-vertical candles. */
  rocketMinPc5mPct: number;
  /** 0 = no upper cap on pc5m for rockets. */
  rocketMaxPc5mPct: number;
  rocketMinVolume5mUsd: number;
  rocketMinBuySellRatio5m: number;
  rocketMinTurnover5m: number;
  rocketMinMarketCapUsd: number;

  /**
   * Extreme chase guard (4h RCA: pc5m 100%+ dumps −60…−97 without buy pressure).
   * When pc5m &gt; extremePc5mPct, require buy/sell ≥ extremeMinBuySellRatio5m.
   * Vol-green: 1.35 — lets leader-like E6cBb6 (bs≈1.39) through; still blocks ~1.0 noise.
   * 0 extremePc = off.
   */
  extremePc5mPct: number;
  extremeMinBuySellRatio5m: number;

  /**
   * liquid_tape — high-liq aged runners where Dex pc5m lags the chart/leader
   * (WW / 14doqPq: Dex +2.8% at leader buy). Ring-green enforced in discover.
   * 0 minLiquidity = path disabled.
   */
  liquidTapeMinLiquidityUsd: number;
  liquidTapeMinPairAgeHours: number;
  liquidTapeMinVolume5mUsd: number;
  /** Soft Dex floor (can be slightly negative — Dex lag). */
  liquidTapeMinPc5mPct: number;
  liquidTapeMaxPc5mPct: number;
  liquidTapeMinBuySellRatio5m: number;
  /** Local 5m ring floor (%) required in discover after path pass. */
  liquidTapeMinRingPc5mPct: number;
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

export type GreenTapePath = 'impulse' | 'liquid' | 'early' | 'rocket' | 'liquid_tape';

export type GreenTapeVerdict = {
  pass: boolean;
  reasons: string[];
  path?: GreenTapePath;
  buySellRatio5m: number | null;
  turnover5m: number | null;
};

type PathGates = {
  minPc: number;
  maxPc: number;
  minVol: number;
  minBs: number;
  minTurnover: number;
  minMcap: number;
};

function pathReasons(
  metrics: GreenTapeMetrics,
  g: PathGates,
  buySellRatio5m: number | null,
  turnover5m: number | null,
): string[] {
  const reasons: string[] = [];
  const pc = metrics.priceChange5mPct;
  if (pc == null || !Number.isFinite(pc)) reasons.push('missing_price_change_5m');
  else if (g.maxPc > 0) {
    if (!(pc > g.minPc && pc <= g.maxPc)) {
      reasons.push(`pc5m=${pc.toFixed(2)}_outside_(${g.minPc},${g.maxPc}]`);
    }
  } else if (!(pc > g.minPc)) {
    reasons.push(`pc5m=${pc.toFixed(2)}<=${g.minPc}`);
  }

  const v = metrics.volume5mUsd;
  if (v == null || !Number.isFinite(v)) reasons.push('missing_volume_5m');
  else if (v < g.minVol) reasons.push(`vol5m=${v.toFixed(0)}<${g.minVol}`);

  if (g.minBs > 0) {
    if (buySellRatio5m == null) reasons.push('buy_sell_unknown');
    else if (buySellRatio5m < g.minBs) {
      reasons.push(`buy_sell_5m=${buySellRatio5m.toFixed(2)}<${g.minBs}`);
    }
  }

  if (g.minTurnover > 0) {
    if (turnover5m == null) {
      // Dex often omits liq on vertical pumpswap → turnover unknown; allow when
      // absolute vol already clears this path's minVol (rocket / mid still gated by bs).
      const liqMissing = metrics.liquidityUsd == null || !Number.isFinite(metrics.liquidityUsd);
      const volOk = v != null && Number.isFinite(v) && v >= g.minVol;
      if (!(liqMissing && volOk)) reasons.push('turnover_unknown');
    } else if (turnover5m < g.minTurnover) {
      reasons.push(`turnover_5m=${turnover5m.toFixed(3)}<${g.minTurnover}`);
    }
  }

  const mcap = metrics.marketCapUsd;
  if (mcap == null || !Number.isFinite(mcap) || mcap <= 0) reasons.push('missing_mcap');
  else if (mcap < g.minMcap) reasons.push(`mcap=${mcap.toFixed(0)}<${g.minMcap}`);

  return reasons;
}

export function evaluateGreenTapeEntry(
  metrics: GreenTapeMetrics,
  gates: GreenTapeGates,
): GreenTapeVerdict {
  const structural: string[] = [];

  if (gates.minLiquidityUsd > 0) {
    const liq = metrics.liquidityUsd;
    const vol5m = metrics.volume5mUsd ?? 0;
    // Dex often omits liq on brand-new pumpswap pairs during the vertical
    // candle (CHiHkQx 02:18). Allow missing/low liq when vol already rocket-tier.
    const rocketVolOk = vol5m >= gates.rocketMinVolume5mUsd;
    if (liq == null || !Number.isFinite(liq)) {
      if (!rocketVolOk) structural.push('missing_liquidity');
    } else if (liq < gates.minLiquidityUsd && !rocketVolOk) {
      structural.push(`liq=${liq.toFixed(0)}<${gates.minLiquidityUsd}`);
    }
  }

  if (gates.maxMarketCapUsd > 0) {
    const mcap = metrics.marketCapUsd;
    if (mcap != null && Number.isFinite(mcap) && mcap > gates.maxMarketCapUsd) {
      structural.push(`mcap=${mcap.toFixed(0)}>${gates.maxMarketCapUsd}`);
    }
  }

  if (gates.minPairAgeHours > 0 || gates.maxPairAgeHours > 0) {
    const age = metrics.pairAgeHours;
    if (age == null || !Number.isFinite(age)) structural.push('missing_pair_age');
    else {
      // Rocket-tier vol on brand-new pumpswap: enter with leaders (~1–2 min age),
      // do not wait for structural minPairAgeHours (peanut 7BNaxx @ ~0.015h).
      const vol5m = metrics.volume5mUsd ?? 0;
      const rocketVolOk = vol5m >= gates.rocketMinVolume5mUsd;
      if (gates.minPairAgeHours > 0 && age < gates.minPairAgeHours && !rocketVolOk) {
        structural.push(`age_h=${age.toFixed(2)}<${gates.minPairAgeHours}`);
      }
      if (gates.maxPairAgeHours > 0 && age > gates.maxPairAgeHours) {
        structural.push(`age_h=${age.toFixed(2)}>${gates.maxPairAgeHours}`);
      }
    }
  }

  if (gates.allowedDexIds.length > 0) {
    const dex = (metrics.dexId ?? '').toLowerCase();
    if (!dex || !gates.allowedDexIds.includes(dex)) {
      structural.push(`dex=${metrics.dexId ?? 'null'}_not_allowed`);
    }
  }

  let buySellRatio5m: number | null = null;
  const buys = metrics.buys5m;
  const sells = metrics.sells5m;
  if (buys != null && sells != null && Number.isFinite(buys) && Number.isFinite(sells)) {
    buySellRatio5m = buys / Math.max(1, sells);
  }

  let turnover5m: number | null = null;
  const vol = metrics.volume5mUsd;
  const liq = metrics.liquidityUsd;
  if (vol != null && liq != null && liq > 0) turnover5m = vol / liq;

  // Don't chase exhausted verticals without buy pressure (BGKnxC/DLvKkk class).
  const extremePc = gates.extremePc5mPct > 0 ? gates.extremePc5mPct : 0;
  const extremeBs = gates.extremeMinBuySellRatio5m > 0 ? gates.extremeMinBuySellRatio5m : 0;
  const pc5m = metrics.priceChange5mPct;
  if (
    extremePc > 0 &&
    extremeBs > 0 &&
    pc5m != null &&
    Number.isFinite(pc5m) &&
    pc5m > extremePc
  ) {
    if (buySellRatio5m == null) {
      structural.push(`chase_extreme_pc5m=${pc5m.toFixed(0)}>_bs_unknown`);
    } else if (buySellRatio5m < extremeBs) {
      structural.push(
        `chase_extreme_pc5m=${pc5m.toFixed(0)}>_bs=${buySellRatio5m.toFixed(2)}<${extremeBs}`,
      );
    }
  }

  if (structural.length > 0) {
    return { pass: false, reasons: structural, buySellRatio5m, turnover5m };
  }

  const paths: Array<{ name: GreenTapePath; g: PathGates }> = [];
  // Impulse first — ignore small greens; buy when candle is large enough.
  if (gates.impulseMinPc5mPct > 0) {
    paths.push({
      name: 'impulse',
      g: {
        minPc: gates.impulseMinPc5mPct,
        maxPc: gates.impulseMaxPc5mPct,
        minVol: gates.impulseMinVolume5mUsd,
        minBs: gates.impulseMinBuySellRatio5m,
        minTurnover: gates.impulseMinTurnover5m,
        minMcap: gates.minMarketCapUsd,
      },
    });
  }
  if (gates.liquidMinPc5mPct > 0) {
    paths.push({
      name: 'liquid',
      g: {
        minPc: gates.liquidMinPc5mPct,
        maxPc: gates.liquidMaxPc5mPct,
        minVol: gates.liquidMinVolume5mUsd,
        minBs: gates.liquidMinBuySellRatio5m,
        minTurnover: gates.liquidMinTurnover5m,
        minMcap: gates.minMarketCapUsd,
      },
    });
  }
  // 0 minPc = early path disabled (vol-green: cut soft thin-tape noise).
  if (gates.earlyMinPc5mPct > 0) {
    paths.push({
      name: 'early',
      g: {
        minPc: gates.earlyMinPc5mPct,
        maxPc: gates.earlyMaxPc5mPct,
        minVol: gates.earlyMinVolume5mUsd,
        minBs: gates.earlyMinBuySellRatio5m,
        minTurnover: gates.earlyMinTurnover5m,
        minMcap: gates.earlyMinMarketCapUsd,
      },
    });
  }
  if (gates.rocketMinPc5mPct > 0) {
    paths.push({
      name: 'rocket',
      g: {
        minPc: gates.rocketMinPc5mPct,
        maxPc: gates.rocketMaxPc5mPct,
        minVol: gates.rocketMinVolume5mUsd,
        minBs: gates.rocketMinBuySellRatio5m,
        minTurnover: gates.rocketMinTurnover5m,
        minMcap: gates.rocketMinMarketCapUsd,
      },
    });
  }

  const failParts: string[] = [];
  for (const { name, g } of paths) {
    const fail = pathReasons(metrics, g, buySellRatio5m, turnover5m);
    if (fail.length === 0) {
      // Liquid mid-band (false-green zone): demand hotter tape, not just pc5m.
      if (name === 'liquid' && gates.liquidMidMinBuySellRatio5m > 0) {
        const pc = metrics.priceChange5mPct;
        const lo = gates.liquidMidPc5mLo;
        const hi =
          gates.liquidMidPc5mHi > 0 ? gates.liquidMidPc5mHi : gates.liquidMaxPc5mPct;
        if (pc != null && pc > lo && (hi <= 0 || pc <= hi)) {
          const midFail: string[] = [];
          if (buySellRatio5m == null) midFail.push('mid_buy_sell_unknown');
          else if (buySellRatio5m < gates.liquidMidMinBuySellRatio5m) {
            midFail.push(
              `mid_buy_sell_5m=${buySellRatio5m.toFixed(2)}<${gates.liquidMidMinBuySellRatio5m}`,
            );
          }
          if (gates.liquidMidMinTurnover5m > 0) {
            if (turnover5m == null) midFail.push('mid_turnover_unknown');
            else if (turnover5m < gates.liquidMidMinTurnover5m) {
              midFail.push(
                `mid_turnover_5m=${turnover5m.toFixed(3)}<${gates.liquidMidMinTurnover5m}`,
              );
            }
          }
          if (midFail.length > 0) {
            for (const r of midFail) failParts.push(`liquid:${r}`);
            continue;
          }
        }
      }
      return {
        pass: true,
        reasons: [],
        path: name,
        buySellRatio5m,
        turnover5m,
      };
    }
    for (const r of fail) failParts.push(`${name}:${r}`);
  }

  // liquid_tape last: fat/aged book where Dex pc5m lags (ring checked in discover).
  if (gates.liquidTapeMinLiquidityUsd > 0) {
    const ltFail: string[] = [];
    const liq = metrics.liquidityUsd;
    if (liq == null || !Number.isFinite(liq)) ltFail.push('missing_liquidity');
    else if (liq < gates.liquidTapeMinLiquidityUsd) {
      ltFail.push(`liq=${liq.toFixed(0)}<${gates.liquidTapeMinLiquidityUsd}`);
    }
    const age = metrics.pairAgeHours;
    if (gates.liquidTapeMinPairAgeHours > 0) {
      if (age == null || !Number.isFinite(age)) ltFail.push('missing_pair_age');
      else if (age < gates.liquidTapeMinPairAgeHours) {
        ltFail.push(`age_h=${age.toFixed(2)}<${gates.liquidTapeMinPairAgeHours}`);
      }
    }
    const v = metrics.volume5mUsd;
    if (v == null || !Number.isFinite(v)) ltFail.push('missing_volume_5m');
    else if (v < gates.liquidTapeMinVolume5mUsd) {
      ltFail.push(`vol5m=${v.toFixed(0)}<${gates.liquidTapeMinVolume5mUsd}`);
    }
    const pc = metrics.priceChange5mPct;
    if (pc == null || !Number.isFinite(pc)) ltFail.push('missing_price_change_5m');
    else {
      // Soft Dex band — allow slight red (lag); cap chase into already-vertical.
      if (!(pc > gates.liquidTapeMinPc5mPct)) {
        ltFail.push(`pc5m=${pc.toFixed(2)}<=${gates.liquidTapeMinPc5mPct}`);
      }
      if (gates.liquidTapeMaxPc5mPct > 0 && pc > gates.liquidTapeMaxPc5mPct) {
        ltFail.push(`pc5m=${pc.toFixed(2)}>${gates.liquidTapeMaxPc5mPct}`);
      }
    }
    if (gates.liquidTapeMinBuySellRatio5m > 0) {
      if (buySellRatio5m == null) ltFail.push('buy_sell_unknown');
      else if (buySellRatio5m < gates.liquidTapeMinBuySellRatio5m) {
        ltFail.push(
          `buy_sell_5m=${buySellRatio5m.toFixed(2)}<${gates.liquidTapeMinBuySellRatio5m}`,
        );
      }
    }
    const mcap = metrics.marketCapUsd;
    if (mcap == null || !Number.isFinite(mcap) || mcap <= 0) ltFail.push('missing_mcap');
    else if (mcap < gates.minMarketCapUsd) {
      ltFail.push(`mcap=${mcap.toFixed(0)}<${gates.minMarketCapUsd}`);
    }
    if (ltFail.length === 0) {
      return {
        pass: true,
        reasons: [],
        path: 'liquid_tape',
        buySellRatio5m,
        turnover5m,
      };
    }
    for (const r of ltFail) failParts.push(`liquid_tape:${r}`);
  }

  return {
    pass: false,
    reasons: [...new Set(failParts)],
    buySellRatio5m,
    turnover5m,
  };
}
