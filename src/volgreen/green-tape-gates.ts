/**
 * Leader-like green-tape entry (8zkg-style).
 *
 * Three paths (OR):
 * - **liquid** — calmer green with fat absolute vol + turnover
 * - **early** — thinner/faster green with strong buy/sell
 * - **rocket** — already-huge 5m candle with extreme vol/turnover (goon / 3c32HTE)
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

  /** Liquid path (fat tape). */
  liquidMinPc5mPct: number;
  liquidMaxPc5mPct: number;
  liquidMinVolume5mUsd: number;
  liquidMinBuySellRatio5m: number;
  liquidMinTurnover5m: number;

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

export type GreenTapePath = 'liquid' | 'early' | 'rocket';

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
    if (turnover5m == null) reasons.push('turnover_unknown');
    else if (turnover5m < g.minTurnover) {
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
    if (liq == null || !Number.isFinite(liq)) structural.push('missing_liquidity');
    else if (liq < gates.minLiquidityUsd) {
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
      if (gates.minPairAgeHours > 0 && age < gates.minPairAgeHours) {
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

  if (structural.length > 0) {
    return { pass: false, reasons: structural, buySellRatio5m, turnover5m };
  }

  const paths: Array<{ name: GreenTapePath; g: PathGates }> = [
    {
      name: 'liquid',
      g: {
        minPc: gates.liquidMinPc5mPct,
        maxPc: gates.liquidMaxPc5mPct,
        minVol: gates.liquidMinVolume5mUsd,
        minBs: gates.liquidMinBuySellRatio5m,
        minTurnover: gates.liquidMinTurnover5m,
        minMcap: gates.minMarketCapUsd,
      },
    },
    {
      name: 'early',
      g: {
        minPc: gates.earlyMinPc5mPct,
        maxPc: gates.earlyMaxPc5mPct,
        minVol: gates.earlyMinVolume5mUsd,
        minBs: gates.earlyMinBuySellRatio5m,
        minTurnover: gates.earlyMinTurnover5m,
        minMcap: gates.earlyMinMarketCapUsd,
      },
    },
    {
      name: 'rocket',
      g: {
        minPc: gates.rocketMinPc5mPct,
        maxPc: gates.rocketMaxPc5mPct,
        minVol: gates.rocketMinVolume5mUsd,
        minBs: gates.rocketMinBuySellRatio5m,
        minTurnover: gates.rocketMinTurnover5m,
        minMcap: gates.rocketMinMarketCapUsd,
      },
    },
  ];

  const failParts: string[] = [];
  for (const { name, g } of paths) {
    const fail = pathReasons(metrics, g, buySellRatio5m, turnover5m);
    if (fail.length === 0) {
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

  return {
    pass: false,
    reasons: [...new Set(failParts)],
    buySellRatio5m,
    turnover5m,
  };
}
