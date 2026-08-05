/**
 * Mild-dip branch gates (entry reverse-engineered from leader sessions).
 *
 * Entry: DexScreener priceChange5m ∈ (minDipPct, maxDipPct] — default (−20, 0].
 * Exit: W9.1 peak-giveback — arm on MFE, full exit on giveback from running peak.
 *        Never-armed branch (leaders 8zkg / 7BNax): same giveback width after
 *        patience, plus max-hold if trail never arms. No SL% from entry.
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

/** W9.1 peak-giveback exit parameters (+ never-armed dead-trade). */
export type MildDipExitGates = {
  /** Arm trail when MFE ≥ this % (default 8). */
  armPct: number;
  /** Full exit when giveback from peak ≤ −this % after armed (default 6). */
  givebackPct: number;
  /**
   * After this many ms still unarmed, allow the same giveback% from the
   * (sub-arm) peak — matches 8zkg quick-cut / 7BNax never-arm cluster (~5m).
   * 0 = disabled.
   */
  neverArmPatienceMs: number;
  /**
   * If still unarmed after this many ms → full exit (8zkg never-arm grind
   * tail ~15–45m; default 40m). 0 = disabled.
   */
  neverArmMaxHoldMs: number;
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

/**
 * After mint cooldown: refuse rebuy if mark already bounced too far off the
 * trough we observed (stream/Dex samples) during the cooldown lookback window.
 */
export function evaluateCooldownBounce(args: {
  freshPriceUsd: number | null;
  troughPriceUsd: number | null;
  /** 0 = bounce check off. */
  maxBouncePct: number;
  /** Require a trough sample; if missing and requireTrough, fail closed or open? */
  requireTrough?: boolean;
}): MildDipGateVerdict {
  const reasons: string[] = [];
  const { freshPriceUsd, troughPriceUsd, maxBouncePct } = args;

  if (!(maxBouncePct > 0)) {
    return { pass: true, reasons };
  }

  if (freshPriceUsd == null || !(freshPriceUsd > 0)) {
    reasons.push('cooldown_bounce_missing_price');
    return { pass: false, reasons };
  }

  if (troughPriceUsd == null || !(troughPriceUsd > 0)) {
    if (args.requireTrough) {
      reasons.push('cooldown_bounce_missing_trough');
      return { pass: false, reasons };
    }
    // No samples yet — allow (Dex/prebuy still apply).
    return { pass: true, reasons };
  }

  const bouncePct = (freshPriceUsd / troughPriceUsd - 1) * 100;
  if (bouncePct > maxBouncePct) {
    reasons.push(
      `cooldown_bounce=${bouncePct.toFixed(2)}%>max=${maxBouncePct}` +
        `_from_trough=${troughPriceUsd}`,
    );
  }

  return { pass: reasons.length === 0, reasons };
}

export type MildDipExitReason =
  | 'peak_giveback'
  | 'never_arm_giveback'
  | 'never_arm_timeout'
  | null;

export function givebackFromPeakPct(markPriceUsd: number, peakPriceUsd: number): number | null {
  if (!(markPriceUsd > 0) || !(peakPriceUsd > 0)) return null;
  return (markPriceUsd / peakPriceUsd - 1) * 100;
}

export function mfeFromEntryPct(peakPriceUsd: number, entryPriceUsd: number): number | null {
  if (!(peakPriceUsd > 0) || !(entryPriceUsd > 0)) return null;
  return (peakPriceUsd / entryPriceUsd - 1) * 100;
}

/**
 * W9.1 peak-giveback («flow») exit — pure decision, no network.
 *
 * - Update running peak from entry
 * - Arm when MFE ≥ armPct
 * - Full exit when armed and giveback ≤ −givebackPct
 * - Never-armed: after patienceMs, same giveback from sub-arm peak; else max-hold
 * - Loss-by-flow (realized < 0) is a valid outcome of the same rule
 */
export function evaluateMildDipPeakGiveback(args: {
  entryPriceUsd: number;
  markPriceUsd: number;
  peakPriceUsd: number;
  armed: boolean;
  gates: MildDipExitGates;
  /** Elapsed ms since entry; required for never-arm exits. */
  heldMs?: number;
}): {
  peakPriceUsd: number;
  mfePct: number;
  givebackPct: number;
  armed: boolean;
  justArmed: boolean;
  shouldExit: boolean;
  reason: MildDipExitReason;
  pnlPct: number;
} {
  const { entryPriceUsd, markPriceUsd, gates } = args;
  const heldMs = Number.isFinite(args.heldMs) ? Math.max(0, Number(args.heldMs)) : 0;
  const peakPriceUsd = Math.max(
    args.peakPriceUsd > 0 ? args.peakPriceUsd : entryPriceUsd,
    markPriceUsd > 0 ? markPriceUsd : 0,
  );
  const mfePct = mfeFromEntryPct(peakPriceUsd, entryPriceUsd) ?? 0;
  const givebackPct = givebackFromPeakPct(markPriceUsd, peakPriceUsd) ?? 0;
  const pnlPct =
    entryPriceUsd > 0 && markPriceUsd > 0 ? ((markPriceUsd / entryPriceUsd - 1) * 100) : 0;

  let armed = args.armed === true;
  let justArmed = false;
  if (!armed && gates.armPct > 0 && mfePct >= gates.armPct) {
    armed = true;
    justArmed = true;
  }

  const givebackHit =
    gates.givebackPct > 0 &&
    // epsilon: 103.5/115 is −9.999…% in IEEE float
    givebackPct <= -gates.givebackPct + 1e-9;

  if (armed && givebackHit) {
    return {
      peakPriceUsd,
      mfePct,
      givebackPct,
      armed,
      justArmed,
      shouldExit: true,
      reason: 'peak_giveback',
      pnlPct,
    };
  }

  // Never-armed dump branch (leaders do exit — not infinite hold).
  if (!armed) {
    const patience = gates.neverArmPatienceMs > 0 ? gates.neverArmPatienceMs : 0;
    if (patience > 0 && heldMs >= patience && givebackHit) {
      return {
        peakPriceUsd,
        mfePct,
        givebackPct,
        armed,
        justArmed,
        shouldExit: true,
        reason: 'never_arm_giveback',
        pnlPct,
      };
    }
    const maxHold = gates.neverArmMaxHoldMs > 0 ? gates.neverArmMaxHoldMs : 0;
    if (maxHold > 0 && heldMs >= maxHold) {
      return {
        peakPriceUsd,
        mfePct,
        givebackPct,
        armed,
        justArmed,
        shouldExit: true,
        reason: 'never_arm_timeout',
        pnlPct,
      };
    }
  }

  return {
    peakPriceUsd,
    mfePct,
    givebackPct,
    armed,
    justArmed,
    shouldExit: false,
    reason: null,
    pnlPct,
  };
}

/** @deprecated Use evaluateMildDipPeakGiveback — kept name alias for call sites. */
export function evaluateMildDipExit(args: {
  entryPriceUsd: number;
  markPriceUsd: number;
  peakPriceUsd: number;
  armed: boolean;
  gates: MildDipExitGates;
  heldMs?: number;
}): ReturnType<typeof evaluateMildDipPeakGiveback> {
  return evaluateMildDipPeakGiveback(args);
}
