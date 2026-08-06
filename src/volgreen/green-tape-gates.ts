/**
 * Leader-like green-tape entry (8zkg-style).
 *
 * Two paths (OR):
 * - **liquid** — calmer green with fat absolute vol + turnover (our earlier default)
 * - **early** — thinner/faster green with strong buy/sell pressure (leader ignition)
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

export type GreenTapePath = 'liquid' | 'early';

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
  else if (!(pc > g.minPc && pc <= g.maxPc)) {
    reasons.push(`pc5m=${pc.toFixed(2)}_outside_(${g.minPc},${g.maxPc}]`);
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

  const liquidGates: PathGates = {
    minPc: gates.liquidMinPc5mPct,
    maxPc: gates.liquidMaxPc5mPct,
    minVol: gates.liquidMinVolume5mUsd,
    minBs: gates.liquidMinBuySellRatio5m,
    minTurnover: gates.liquidMinTurnover5m,
    minMcap: gates.minMarketCapUsd,
  };
  const earlyGates: PathGates = {
    minPc: gates.earlyMinPc5mPct,
    maxPc: gates.earlyMaxPc5mPct,
    minVol: gates.earlyMinVolume5mUsd,
    minBs: gates.earlyMinBuySellRatio5m,
    minTurnover: gates.earlyMinTurnover5m,
    minMcap: gates.earlyMinMarketCapUsd,
  };

  const liquidFail = pathReasons(metrics, liquidGates, buySellRatio5m, turnover5m);
  if (liquidFail.length === 0) {
    return {
      pass: true,
      reasons: [],
      path: 'liquid',
      buySellRatio5m,
      turnover5m,
    };
  }

  const earlyFail = pathReasons(metrics, earlyGates, buySellRatio5m, turnover5m);
  if (earlyFail.length === 0) {
    return {
      pass: true,
      reasons: [],
      path: 'early',
      buySellRatio5m,
      turnover5m,
    };
  }

  // Surface both path failures for journal RCA (dedupe, keep short).
  const reasons = [...new Set([...liquidFail.map((r) => `liquid:${r}`), ...earlyFail.map((r) => `early:${r}`)])];
  return { pass: false, reasons, buySellRatio5m, turnover5m };
}
