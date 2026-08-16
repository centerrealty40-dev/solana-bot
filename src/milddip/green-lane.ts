/**
 * Green lane — momentum entries, the class the leaders label `green`.
 *
 * This is not the dip strategy with a different threshold. It is the opposite
 * trade and it needs the opposite exit, so it lives apart.
 *
 * ## Entry, from the sampler
 *
 * 566_828 sampler rows over 678 mints were labelled by whether a leader bought
 * that mint within ten minutes. Base rate 5.52%. Ranking each feature by how it
 * moves the odds (bottom fifth vs top fifth against that base):
 *
 * | feature          | bottom fifth | top fifth |
 * |------------------|--------------|-----------|
 * | `vol5m / liq`    | ×0.22        | **×3.18** |
 * | `vol1h`          | ×0.15        | ×2.46     |
 * | `buys5m`         | ×0.17        | ×2.45     |
 * | `pc5m`           | ×0.23        | ×2.10     |
 * | `pc1h`           | ×1.22        | ×2.07     |
 * | `buyShare5m`     | ×0.55        | **×0.23** |
 *
 * Two of those are not obvious. They avoid a one-sided tape — a buy share above
 * 0.85 *lowers* the odds to ×0.23 — and they enter on a micro-pullback: with
 * pc5m at +10.7% their last minute is a median −0.51%.
 *
 * The combination below scores precision 0.275 against a 0.055 base, ×4.97.
 *
 * ## Exit, from the forward tape
 *
 * Green entries spike and then die: median −14.4% fifteen minutes out and
 * −43.6% at an hour, while 63.2% touch +10% inside fifteen minutes. A trail is
 * therefore the wrong instrument. Grid over 156 deduped signals:
 *
 * | tp   | stop | max hold | mean  | win   |
 * |------|------|----------|-------|-------|
 * | +30% | −6%  | 10m      | +4.91 | 0.316 |
 * | +30% | −8%  | 15m      | +3.89 | 0.323 |
 * | +20% | −6%  | 5m       | +3.04 | 0.374 |
 * | +6%  | −15% | 5m       | −2.20 | 0.581 |
 *
 * Cut fast, let the rare one run. The last row is what a dip-style exit does
 * here, and it loses.
 */

export type GreenLaneGates = {
  enabled: boolean;
  /** 5m volume over liquidity. The single strongest feature. */
  minTurnover5mLiq: number;
  minVolume5mUsd: number;
  minVolume1hUsd: number;
  minPc5mPct: number;
  /** 0 disables the upper bound; reject vertical moves at or above this value. */
  maxPc5mPct: number;
  /** Keep the historical fail-closed behavior for missing 1h change by default. */
  requirePc1h: boolean;
  minPc1hPct: number;
  minBuys5m: number;
  /** Reject a one-sided tape: buys / (buys + sells) above this. */
  maxBuyShare5m: number;
  minLiquidityUsd: number;
  /**
   * Own floor, separate from the dip lane's. Green signals are young — median
   * pair age 0.67h against the dip lane's 6h floor, which would keep only 18%
   * of them — and the lane's ten-minute ceiling bounds the exposure that floor
   * was protecting against.
   */
  minPairAgeHours: number;
  /**
   * Require the last minute to be flat or down — they buy the pullback inside
   * the green move. Only applied when a 1-minute return is available; the Dex
   * snapshot does not carry one, so this stays optional rather than blocking
   * the lane on a field we may not have.
   */
  maxRet1mPct: number;
};

export type GreenLaneInput = {
  pc5mPct: number | null | undefined;
  pc1hPct: number | null | undefined;
  volume5mUsd: number | null | undefined;
  volume1hUsd: number | null | undefined;
  liquidityUsd: number | null | undefined;
  buys5m: number | null | undefined;
  sells5m: number | null | undefined;
  pairAgeHours: number | null | undefined;
  /** Optional; skipped when absent. */
  ret1mPct?: number | null;
};

export type GreenLaneVerdict = {
  pass: boolean;
  /** Why it failed, or the qualifying numbers when it passed. */
  reasons: string[];
  turnover: number | null;
  buyShare: number | null;
};

export function greenExposureCapReason(args: {
  openGreen: number;
  maxOpen: number;
  buysInHour: number;
  maxBuysPerHour: number;
}): 'green_max_open' | 'green_max_buys_per_hour' | null {
  if (args.maxOpen > 0 && args.openGreen >= args.maxOpen) return 'green_max_open';
  if (args.maxBuysPerHour > 0 && args.buysInHour >= args.maxBuysPerHour) {
    return 'green_max_buys_per_hour';
  }
  return null;
}

function num(v: number | null | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export function greenTurnover(
  volume5mUsd: number | null | undefined,
  liquidityUsd: number | null | undefined,
): number | null {
  const v = num(volume5mUsd);
  const l = num(liquidityUsd);
  return v != null && l != null && l > 0 ? v / l : null;
}

export function greenBuyShare(
  buys5m: number | null | undefined,
  sells5m: number | null | undefined,
): number | null {
  const b = num(buys5m);
  const s = num(sells5m);
  if (b == null || s == null) return null;
  const t = b + s;
  return t > 0 ? b / t : null;
}

export function evaluateGreenLane(
  input: GreenLaneInput,
  gates: GreenLaneGates,
): GreenLaneVerdict {
  const turnover = greenTurnover(input.volume5mUsd, input.liquidityUsd);
  const buyShare = greenBuyShare(input.buys5m, input.sells5m);
  const fail: string[] = [];

  if (!gates.enabled) return { pass: false, reasons: ['disabled'], turnover, buyShare };

  const pc5m = num(input.pc5mPct);
  const pc1h = num(input.pc1hPct);
  const vol5m = num(input.volume5mUsd);
  const vol1h = num(input.volume1hUsd);
  const liq = num(input.liquidityUsd);
  const buys = num(input.buys5m);
  const ret1m = num(input.ret1mPct);

  // A missing field is a fail, not a pass: the lane must know what it is buying.
  if (pc5m == null || pc5m < gates.minPc5mPct) fail.push(`pc5m=${pc5m ?? 'null'}`);
  // Vertical moves (imp5 >= +40%) were the worst tape subset (median 60m
  // return −21%); keep the ceiling opt-in so existing defaults do not change.
  if (gates.maxPc5mPct > 0 && pc5m != null && pc5m >= gates.maxPc5mPct) {
    fail.push(`pc5m_max=${pc5m}`);
  }
  if (
    pc1h == null
      ? gates.requirePc1h
      : pc1h < gates.minPc1hPct
  ) {
    fail.push(`pc1h=${pc1h ?? 'null'}`);
  }
  if (vol5m == null || vol5m < gates.minVolume5mUsd) fail.push(`vol5m=${vol5m ?? 'null'}`);
  if (gates.minVolume1hUsd > 0 && (vol1h == null || vol1h < gates.minVolume1hUsd)) {
    fail.push(`vol1h=${vol1h ?? 'null'}`);
  }
  if (liq == null || liq < gates.minLiquidityUsd) fail.push(`liq=${liq ?? 'null'}`);
  const ageH = num(input.pairAgeHours);
  if (gates.minPairAgeHours > 0 && (ageH == null || ageH < gates.minPairAgeHours)) {
    fail.push(`ageH=${ageH == null ? 'null' : ageH.toFixed(2)}`);
  }
  if (gates.minBuys5m > 0 && (buys == null || buys < gates.minBuys5m)) {
    fail.push(`buys5m=${buys ?? 'null'}`);
  }
  if (turnover == null || turnover < gates.minTurnover5mLiq) {
    fail.push(`turnover=${turnover == null ? 'null' : turnover.toFixed(3)}`);
  }
  if (gates.maxBuyShare5m > 0 && buyShare != null && buyShare > gates.maxBuyShare5m) {
    fail.push(`buyShare=${buyShare.toFixed(3)}`);
  }
  if (ret1m != null && ret1m > gates.maxRet1mPct) fail.push(`ret1m=${ret1m.toFixed(2)}`);

  if (fail.length > 0) return { pass: false, reasons: fail, turnover, buyShare };
  return {
    pass: true,
    reasons: [
      `pc5m=${pc5m!.toFixed(1)}`,
      ...(pc1h == null ? [] : [`pc1h=${pc1h.toFixed(1)}`]),
      `turnover=${turnover!.toFixed(2)}`,
    ],
    turnover,
    buyShare,
  };
}

export type GreenExitGates = {
  takeProfitPct: number;
  /** Positive number; the stop fires at −this. */
  stopPct: number;
  maxHoldMs: number;
  trailEnabled?: boolean;
  armPct?: number;
  trailPct?: number;
};

export type GreenExitReason =
  | 'green_tp'
  | 'green_stop'
  | 'green_max_hold'
  | 'green_trail'
  | null;

/**
 * The whole green exit. No ladder, no trail, no breakeven — the tape says the
 * move is over within minutes either way.
 */
export function decideGreenExit(
  pnlPct: number,
  heldMs: number,
  gates: GreenExitGates,
  peakPnlPct = 0,
): { shouldExit: boolean; reason: GreenExitReason } {
  if (!Number.isFinite(pnlPct)) return { shouldExit: false, reason: null };
  const trailEnabled = gates.trailEnabled === true;
  const armed = trailEnabled && peakPnlPct >= (gates.armPct ?? 10);
  if (gates.stopPct > 0 && pnlPct <= -gates.stopPct) {
    return { shouldExit: true, reason: 'green_stop' };
  }
  if (
    trailEnabled &&
    armed &&
    gates.trailPct != null &&
    gates.trailPct > 0 &&
    pnlPct <= peakPnlPct - gates.trailPct
  ) {
    return { shouldExit: true, reason: 'green_trail' };
  }
  if (gates.takeProfitPct > 0 && pnlPct >= gates.takeProfitPct) {
    return { shouldExit: true, reason: 'green_tp' };
  }
  if (gates.maxHoldMs > 0 && heldMs >= gates.maxHoldMs) {
    return { shouldExit: true, reason: 'green_max_hold' };
  }
  return { shouldExit: false, reason: null };
}
