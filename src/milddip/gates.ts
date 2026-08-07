/**
 * Mild-dip branch gates (entry reverse-engineered from leader sessions).
 *
 * Entry: DexScreener priceChange5m ∈ (minDipPct, maxDipPct] — default (−20, −4].
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
  /**
   * First armed giveback threshold (%). With `partialSellFraction` in (0,1)
   * this peels a partial; otherwise full exit. Default 8.
   */
  givebackPct: number;
  /**
   * Sell this fraction of the bag on the first armed giveback (e.g. 0.5).
   * 0 or ≥1 = legacy full exit on first giveback (Oscar default).
   */
  partialSellFraction: number;
  /**
   * After a partial peel, full-exit remaining when giveback ≤ −this %.
   * 0 = reuse `givebackPct` for the rest. Vol-green: 5.
   */
  secondGivebackPct: number;
  /**
   * After this many ms still unarmed, allow the same giveback% from the
   * (sub-arm) peak. Live default **0** — early never_arm_giveback was the grind loss.
   * 0 = disabled.
   */
  neverArmPatienceMs: number;
  /**
   * If still unarmed after this many ms → full exit (hard ceiling; default 40m).
   * 0 = disabled (not recommended — can hold forever if trail never arms).
   */
  neverArmMaxHoldMs: number;
  /**
   * Never-armed deep-loss cut: after this many ms, if pnl ≤ −neverArmDeadPnlPct,
   * full exit (`never_arm_dead`). Catches rugs before max-hold without the
   * early 5m −6% knife. 0 = disabled.
   */
  neverArmDeadMinMs: number;
  /** See neverArmDeadMinMs. Positive percent (e.g. 15 = exit at ≤ −15%). */
  neverArmDeadPnlPct: number;
  /**
   * Activity-based never-armed exit (`never_arm_vol_fade`): once held this long,
   * exit when the 5m volume has faded relative to entry. Leaders leave a mint
   * when the tape dies, not on a clock — a flat mint that still trades can still
   * run (see `diag-leader-exit-policy.json`). 0 = disabled.
   */
  neverArmVolFadeMinMs: number;
  /** Exit when vol5m ≤ this fraction of entry vol5m (e.g. 0.35). 0 = disabled. */
  neverArmVolFadeRatio: number;
  /** Exit when vol5m ≤ this absolute USD floor regardless of ratio. 0 = disabled. */
  neverArmVolFadeFloorUsd: number;
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
  | 'peak_giveback_partial'
  | 'never_arm_giveback'
  | 'never_arm_dead'
  | 'never_arm_vol_fade'
  | 'never_arm_timeout'
  | null;

export function givebackFromPeakPct(markPriceUsd: number, peakPriceUsd: number): number | null {
  if (!(markPriceUsd > 0) || !(peakPriceUsd > 0)) return null;
  return (markPriceUsd / peakPriceUsd - 1) * 100;
}

function numOrNull(x: number | null | undefined): number | null {
  return typeof x === 'number' && Number.isFinite(x) ? x : null;
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
 * - Armed ladder: first giveback → optional partial; second giveback → full rest
 * - Never-armed: optional soft giveback after patienceMs (0 = off), deep-loss
 *   dead cut, activity fade (`never_arm_vol_fade`), then the max-hold ceiling
 * - Live default: patience off — early never_arm_giveback was cutting before pumps
 * - Loss-by-flow (realized < 0) is a valid outcome of the armed trail
 */
export function evaluateMildDipPeakGiveback(args: {
  entryPriceUsd: number;
  markPriceUsd: number;
  peakPriceUsd: number;
  armed: boolean;
  gates: MildDipExitGates;
  /** Elapsed ms since entry; required for never-arm exits. */
  heldMs?: number;
  /** Current 5m volume (Dex) — enables the activity-fade exit. */
  volume5mUsd?: number | null;
  /** 5m volume captured at entry — the fade baseline. */
  entryVolume5mUsd?: number | null;
  /** True after a successful first-rung partial peel. */
  partialTaken?: boolean;
}): {
  peakPriceUsd: number;
  mfePct: number;
  givebackPct: number;
  armed: boolean;
  justArmed: boolean;
  shouldExit: boolean;
  reason: MildDipExitReason;
  pnlPct: number;
  /** 0..1 — fraction of bag to sell when shouldExit. */
  sellFraction: number;
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
  const partialTaken = args.partialTaken === true;
  const partialFrac =
    gates.partialSellFraction > 0 && gates.partialSellFraction < 1
      ? gates.partialSellFraction
      : 0;

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
  const secondThr =
    gates.secondGivebackPct > 0 ? gates.secondGivebackPct : gates.givebackPct;
  const secondHit =
    secondThr > 0 && givebackPct <= -secondThr + 1e-9;

  if (armed && !partialTaken && givebackHit) {
    if (partialFrac > 0) {
      return {
        peakPriceUsd,
        mfePct,
        givebackPct,
        armed,
        justArmed,
        shouldExit: true,
        reason: 'peak_giveback_partial',
        pnlPct,
        sellFraction: partialFrac,
      };
    }
    return {
      peakPriceUsd,
      mfePct,
      givebackPct,
      armed,
      justArmed,
      shouldExit: true,
      reason: 'peak_giveback',
      pnlPct,
      sellFraction: 1,
    };
  }

  if (armed && partialTaken && secondHit) {
    return {
      peakPriceUsd,
      mfePct,
      givebackPct,
      armed,
      justArmed,
      shouldExit: true,
      reason: 'peak_giveback',
      pnlPct,
      sellFraction: 1,
    };
  }

  // Never-armed branch — must always have a finite exit (no infinite hold).
  // Order: optional soft giveback (usually OFF) → deep-loss dead cut → max-hold ceiling.
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
        sellFraction: 1,
      };
    }
    const deadMin = gates.neverArmDeadMinMs > 0 ? gates.neverArmDeadMinMs : 0;
    const deadPnl = gates.neverArmDeadPnlPct > 0 ? gates.neverArmDeadPnlPct : 0;
    if (deadMin > 0 && deadPnl > 0 && heldMs >= deadMin && pnlPct <= -deadPnl) {
      return {
        peakPriceUsd,
        mfePct,
        givebackPct,
        armed,
        justArmed,
        shouldExit: true,
        reason: 'never_arm_dead',
        pnlPct,
        sellFraction: 1,
      };
    }
    const volFadeMin = gates.neverArmVolFadeMinMs > 0 ? gates.neverArmVolFadeMinMs : 0;
    if (volFadeMin > 0 && heldMs >= volFadeMin) {
      const vol = numOrNull(args.volume5mUsd);
      if (vol != null) {
        const floor = gates.neverArmVolFadeFloorUsd > 0 ? gates.neverArmVolFadeFloorUsd : 0;
        const entryVol = numOrNull(args.entryVolume5mUsd);
        const ratio = gates.neverArmVolFadeRatio > 0 ? gates.neverArmVolFadeRatio : 0;
        const fadedVsEntry = ratio > 0 && entryVol != null && entryVol > 0 && vol <= entryVol * ratio;
        const belowFloor = floor > 0 && vol <= floor;
        if (fadedVsEntry || belowFloor) {
          return {
            peakPriceUsd,
            mfePct,
            givebackPct,
            armed,
            justArmed,
            shouldExit: true,
            reason: 'never_arm_vol_fade',
            pnlPct,
            sellFraction: 1,
          };
        }
      }
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
        sellFraction: 1,
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
    sellFraction: 1,
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
