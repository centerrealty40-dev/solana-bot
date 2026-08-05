/**
 * Mild-dip branch gates (reverse-engineered from leader 7BNax sessions).
 *
 * Entry: DexScreener priceChange5m ∈ (minDipPct, maxDipPct] — default (−20, 0].
 * Exit: TP ≥ tpGainPct OR trail giveback from peak OR volume fade OR time-stop.
 */

export type MildDipCandidateMetrics = {
  priceChange5mPct: number | null;
  volume5mUsd: number | null;
  liquidityUsd: number | null;
  marketCapUsd: number | null;
  pairAgeHours: number | null;
  dexId: string | null;
};

export type MildDipEntryGates = {
  /** Exclusive lower bound for 5m change, percent (default −20). */
  minDipPct: number;
  /** Inclusive upper bound for 5m change, percent (default 0). */
  maxDipPct: number;
  minVolume5mUsd: number;
  minLiquidityUsd: number;
  minMarketCapUsd: number;
  maxMarketCapUsd: number;
  minPairAgeHours: number;
  maxPairAgeHours: number;
  /** Empty = any dex. */
  allowedDexIds: string[];
};

export type MildDipExitGates = {
  tpGainPct: number;
  /** Giveback from peak %, e.g. 6 → exit when mark ≤ peak * (1 − 0.06). 0 = off. */
  trailGivebackPct: number;
  timeStopMs: number;
  /** Drop vs entry vol5m %, e.g. 30 → exit when recent vol ≤ entry * 0.70. 0 = off. */
  volFadeDropPct: number;
  /** Absolute vol5m floor (0 = off). */
  volFadeMinVolume5mUsd: number;
  /** How many recent vol samples form the window. */
  volFadeSampleWindow: number;
  /** Sell when at least this many samples in the window look weak. */
  volFadeMinWeakSamples: number;
  /** Do not vol-fade exit before this hold age. */
  volFadeMinHoldMs: number;
};

export type MildDipGateVerdict = {
  pass: boolean;
  reasons: string[];
};

export function evaluateMildDipEntry(
  metrics: MildDipCandidateMetrics,
  gates: MildDipEntryGates,
): MildDipGateVerdict {
  const reasons: string[] = [];
  const pc = metrics.priceChange5mPct;
  if (pc == null || !Number.isFinite(pc)) {
    reasons.push('missing_price_change_5m');
  } else if (!(pc > gates.minDipPct && pc <= gates.maxDipPct)) {
    reasons.push(`pc5m=${pc.toFixed(2)}_outside_(${gates.minDipPct},${gates.maxDipPct}]`);
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

  return { pass: reasons.length === 0, reasons };
}

/**
 * Immediate pre-send check: DexScreener snapshot can go stale while we enrich
 * dozens of mints / wait on funding RPC. Abort if the 5m dip is gone or the
 * mark already bounced above the signal price by more than `maxChasePct`.
 */
export function evaluateMildDipPreBuy(args: {
  signalPriceUsd: number;
  freshPriceUsd: number | null;
  freshPc5mPct: number | null;
  entryGates: Pick<MildDipEntryGates, 'minDipPct' | 'maxDipPct'>;
  /** 0 = chase check off (pc5m revalidate still runs). */
  maxChasePct: number;
}): MildDipGateVerdict {
  const reasons: string[] = [];
  const { signalPriceUsd, freshPriceUsd, freshPc5mPct, entryGates, maxChasePct } = args;

  if (freshPriceUsd == null || !(freshPriceUsd > 0)) {
    reasons.push('prebuy_missing_price');
  }

  const pc = freshPc5mPct;
  if (pc == null || !Number.isFinite(pc)) {
    reasons.push('prebuy_missing_pc5m');
  } else if (!(pc > entryGates.minDipPct && pc <= entryGates.maxDipPct)) {
    reasons.push(
      `prebuy_pc5m=${pc.toFixed(2)}_outside_(${entryGates.minDipPct},${entryGates.maxDipPct}]`,
    );
  }

  if (
    maxChasePct > 0 &&
    signalPriceUsd > 0 &&
    freshPriceUsd != null &&
    freshPriceUsd > 0
  ) {
    const chasePct = (freshPriceUsd / signalPriceUsd - 1) * 100;
    if (chasePct > maxChasePct) {
      reasons.push(`prebuy_chase=${chasePct.toFixed(2)}%>max=${maxChasePct}`);
    }
  }

  return { pass: reasons.length === 0, reasons };
}

export type MildDipExitReason =
  | 'take_profit'
  | 'trail_giveback'
  | 'volume_fade'
  | 'time_stop'
  | null;

export function givebackFromPeakPct(markPriceUsd: number, peakPriceUsd: number): number | null {
  if (!(markPriceUsd > 0) || !(peakPriceUsd > 0)) return null;
  return (markPriceUsd / peakPriceUsd - 1) * 100;
}

/**
 * Pure exit decision. Priority: TP → trail giveback → volume fade → time-stop.
 * Trail arms only after peak has printed above entry (not a hard −6% stop from entry).
 */
export function evaluateMildDipExit(args: {
  entryPriceUsd: number;
  markPriceUsd: number;
  peakPriceUsd: number;
  openedAtMs: number;
  nowMs: number;
  gates: MildDipExitGates;
  /** True when multi-window vol samples already look faded. */
  volumeFaded?: boolean;
}): { shouldExit: boolean; reason: MildDipExitReason; pnlPct: number; givebackPct: number | null } {
  const { entryPriceUsd, markPriceUsd, peakPriceUsd, openedAtMs, nowMs, gates } = args;
  const pnlPct =
    entryPriceUsd > 0 && markPriceUsd > 0 ? ((markPriceUsd / entryPriceUsd - 1) * 100) : 0;
  const givebackPct = givebackFromPeakPct(markPriceUsd, peakPriceUsd);

  if (gates.tpGainPct > 0 && pnlPct >= gates.tpGainPct) {
    return { shouldExit: true, reason: 'take_profit', pnlPct, givebackPct };
  }

  const trailArmed = peakPriceUsd > entryPriceUsd + 1e-12;
  if (
    trailArmed &&
    gates.trailGivebackPct > 0 &&
    givebackPct != null &&
    givebackPct <= -gates.trailGivebackPct
  ) {
    return { shouldExit: true, reason: 'trail_giveback', pnlPct, givebackPct };
  }

  const holdMs = nowMs - openedAtMs;
  if (
    args.volumeFaded === true &&
    gates.volFadeDropPct > 0 &&
    holdMs >= Math.max(0, gates.volFadeMinHoldMs)
  ) {
    return { shouldExit: true, reason: 'volume_fade', pnlPct, givebackPct };
  }

  if (gates.timeStopMs > 0 && holdMs >= gates.timeStopMs) {
    return { shouldExit: true, reason: 'time_stop', pnlPct, givebackPct };
  }
  return { shouldExit: false, reason: null, pnlPct, givebackPct };
}
