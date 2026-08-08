/**
 * Pre-buy revalidation for Volume Awakening / green-tape entries.
 * Unlike mild-dip, we do NOT require pc5m to stay in a dump band —
 * we require the tape is still not red and the mark has not chased away.
 */
export type AwakeningPreBuyVerdict = {
  pass: boolean;
  reasons: string[];
};

export function evaluateAwakeningPreBuy(args: {
  signalPriceUsd: number;
  freshPriceUsd: number | null;
  freshPc5mPct: number | null;
  /** 0 = chase check off. */
  maxChasePct: number;
  /** Fresh 5m change must be ≥ this (default 0 = not red). */
  minFreshPc5mPct: number;
  /**
   * Local ring % over ~60s (1m-red proxy). When set and ≤0, block — Dex pc5m
   * can still read green on a dump (goon 16:29).
   */
  shortRingPc?: number | null;
}): AwakeningPreBuyVerdict {
  const reasons: string[] = [];
  const {
    signalPriceUsd,
    freshPriceUsd,
    freshPc5mPct,
    maxChasePct,
    minFreshPc5mPct,
    shortRingPc,
  } = args;

  if (freshPriceUsd == null || !(freshPriceUsd > 0)) {
    reasons.push('prebuy_missing_price');
  }

  const pc = freshPc5mPct;
  if (pc == null || !Number.isFinite(pc)) {
    reasons.push('prebuy_missing_pc5m');
  } else if (pc < minFreshPc5mPct) {
    reasons.push(`prebuy_pc5m=${pc.toFixed(2)}<min=${minFreshPc5mPct}`);
  }

  if (shortRingPc != null && Number.isFinite(shortRingPc) && shortRingPc <= -1) {
    reasons.push(`prebuy_short_red:ring60=${shortRingPc.toFixed(2)}<=-1`);
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
