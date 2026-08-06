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
  /** DexScreener m5 buy count — journaled; optional entry use. */
  buys5m: number | null;
  /** DexScreener m5 sell count — journaled; optional entry use. */
  sells5m: number | null;
  volume1hUsd: number | null;
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
  /** Full exit when giveback from peak ≤ −this % after armed (default 8). */
  givebackPct: number;
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
   * start evaluating sustained volume fade across spaced 5m windows. A single
   * weak Dex reading must NOT sell — need `neverArmVolFadeWeakWindows` consecutive
   * weak samples spaced ≥ `neverArmVolFadeSampleMs` apart. 0 = disabled.
   */
  neverArmVolFadeMinMs: number;
  /** A window is weak when vol5m ≤ this fraction of entry vol5m (e.g. 0.25). 0 = off. */
  neverArmVolFadeRatio: number;
  /** A window is weak when vol5m ≤ this absolute USD floor. 0 = off. */
  neverArmVolFadeFloorUsd: number;
  /**
   * Min spacing between vol5m samples that count as distinct 5m windows
   * (default 300_000 = 5m). Dex rolling m5 is autocorrelated on every mark tick.
   */
  neverArmVolFadeSampleMs: number;
  /**
   * Require this many consecutive weak 5m windows before `never_arm_vol_fade`
   * (default 3 ≈ 15m of sustained fade). 1 = legacy one-shot (not recommended).
   */
  neverArmVolFadeWeakWindows: number;
  /**
   * Immediate cliff exit when mark pnl ≤ −this % (default 50). Catches LP-pull
   * rugs without waiting for never_arm_dead min-hold. 0 = off.
   */
  cliffDumpPnlPct: number;
};

/** One spaced Dex vol5m reading used by the sustained fade exit. */
export type MildDipVolFadeSample = {
  ts: number;
  vol: number;
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
  | 'never_arm_dead'
  | 'never_arm_vol_fade'
  | 'never_arm_timeout'
  | 'cliff_dump'
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

/** True when a single 5m vol reading is weak vs entry baseline / floor. */
export function isVolFadeWeak(
  vol5mUsd: number,
  entryVolume5mUsd: number | null | undefined,
  ratio: number,
  floorUsd: number,
): boolean {
  if (!(vol5mUsd >= 0) || !Number.isFinite(vol5mUsd)) return false;
  const entryVol = numOrNull(entryVolume5mUsd);
  const fadedVsEntry =
    ratio > 0 && entryVol != null && entryVol > 0 && vol5mUsd <= entryVol * ratio;
  const belowFloor = floorUsd > 0 && vol5mUsd <= floorUsd;
  return fadedVsEntry || belowFloor;
}

/**
 * Append a Dex vol5m reading at most once per `sampleMs` (distinct 5m windows).
 * Null/non-finite volumes are ignored so data gaps do not count as fade.
 */
export function recordVolFadeSample(
  prev: readonly MildDipVolFadeSample[] | null | undefined,
  nowMs: number,
  volume5mUsd: number | null | undefined,
  sampleMs: number,
  keep: number,
): MildDipVolFadeSample[] {
  const out = Array.isArray(prev)
    ? prev.filter((s) => s && Number.isFinite(s.ts) && Number.isFinite(s.vol) && s.vol >= 0)
    : [];
  const vol = numOrNull(volume5mUsd);
  const spacing = sampleMs > 0 ? sampleMs : 300_000;
  if (vol != null) {
    const last = out.length > 0 ? out[out.length - 1]! : null;
    if (!last || nowMs - last.ts >= spacing) {
      out.push({ ts: nowMs, vol });
    }
  }
  const maxKeep = Math.max(2, keep > 0 ? keep + 2 : 8);
  return out.length > maxKeep ? out.slice(-maxKeep) : out;
}

/** Last `weakWindows` spaced samples are all weak → sustained fade. */
export function sustainedVolFade(
  samples: readonly MildDipVolFadeSample[] | null | undefined,
  weakWindows: number,
  entryVolume5mUsd: number | null | undefined,
  ratio: number,
  floorUsd: number,
): boolean {
  const need = weakWindows > 0 ? Math.floor(weakWindows) : 0;
  if (need <= 0) return false;
  if (!Array.isArray(samples) || samples.length < need) return false;
  const recent = samples.slice(-need);
  return recent.every((s) => isVolFadeWeak(s.vol, entryVolume5mUsd, ratio, floorUsd));
}

/**
 * W9.1 peak-giveback («flow») exit — pure decision, no network.
 *
 * - Update running peak from entry
 * - Arm when MFE ≥ armPct
 * - Full exit when armed and giveback ≤ −givebackPct
 * - Never-armed: optional soft giveback after patienceMs (0 = off), deep-loss
 *   dead cut, sustained activity fade (`never_arm_vol_fade` over N×5m windows),
 *   then the max-hold ceiling
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
  /** Current 5m volume (Dex) — used to extend the spaced sample ring. */
  volume5mUsd?: number | null;
  /** 5m volume captured at entry — the fade baseline. */
  entryVolume5mUsd?: number | null;
  /** Prior spaced vol5m samples on this position (mutated via return value). */
  volFadeSamples?: readonly MildDipVolFadeSample[] | null;
  /** Wall clock for spacing samples; defaults to held-relative when omitted. */
  nowMs?: number;
}): {
  peakPriceUsd: number;
  mfePct: number;
  givebackPct: number;
  armed: boolean;
  justArmed: boolean;
  shouldExit: boolean;
  reason: MildDipExitReason;
  pnlPct: number;
  volFadeSamples: MildDipVolFadeSample[];
} {
  const { entryPriceUsd, markPriceUsd, gates } = args;
  const heldMs = Number.isFinite(args.heldMs) ? Math.max(0, Number(args.heldMs)) : 0;
  const nowMs =
    Number.isFinite(args.nowMs) && Number(args.nowMs) > 0
      ? Number(args.nowMs)
      : heldMs;
  const sampleMs = gates.neverArmVolFadeSampleMs > 0 ? gates.neverArmVolFadeSampleMs : 300_000;
  const weakWindows =
    gates.neverArmVolFadeWeakWindows > 0 ? Math.floor(gates.neverArmVolFadeWeakWindows) : 0;
  const volFadeSamples = recordVolFadeSample(
    args.volFadeSamples,
    nowMs,
    args.volume5mUsd,
    sampleMs,
    weakWindows > 0 ? weakWindows : 3,
  );
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

  // Cliff LP-pull / instant rug — fire before trail patience / dead min-hold.
  const cliff = gates.cliffDumpPnlPct > 0 ? gates.cliffDumpPnlPct : 0;
  if (cliff > 0 && pnlPct <= -cliff) {
    return {
      peakPriceUsd,
      mfePct,
      givebackPct,
      armed,
      justArmed,
      shouldExit: true,
      reason: 'cliff_dump',
      pnlPct,
      volFadeSamples,
    };
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
      volFadeSamples,
    };
  }

  // Never-armed branch — must always have a finite exit (no infinite hold).
  // Order: optional soft giveback (usually OFF) → deep-loss dead cut →
  // sustained vol fade (N consecutive weak 5m windows) → max-hold ceiling.
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
        volFadeSamples,
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
        volFadeSamples,
      };
    }
    const volFadeMin = gates.neverArmVolFadeMinMs > 0 ? gates.neverArmVolFadeMinMs : 0;
    if (volFadeMin > 0 && heldMs >= volFadeMin && weakWindows > 0) {
      const floor = gates.neverArmVolFadeFloorUsd > 0 ? gates.neverArmVolFadeFloorUsd : 0;
      const ratio = gates.neverArmVolFadeRatio > 0 ? gates.neverArmVolFadeRatio : 0;
      if (
        sustainedVolFade(
          volFadeSamples,
          weakWindows,
          args.entryVolume5mUsd,
          ratio,
          floor,
        )
      ) {
        return {
          peakPriceUsd,
          mfePct,
          givebackPct,
          armed,
          justArmed,
          shouldExit: true,
          reason: 'never_arm_vol_fade',
          pnlPct,
          volFadeSamples,
        };
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
        volFadeSamples,
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
    volFadeSamples,
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
