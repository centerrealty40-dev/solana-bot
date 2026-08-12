/**
 * Mild-dip branch gates (entry reverse-engineered from leader sessions).
 *
 * Entry: DexScreener priceChange5m ∈ (minDipPct, maxDipPct] — default (−25, −8].
 * Exit: W9.1 peak-giveback — arm on MFE, full exit on giveback from running peak.
 *        Never-armed branch (leaders 8zkg / 7BNax): same giveback width after
 *        patience, plus max-hold if trail never arms.
 *        Hard stop from entry (`hard_stop`) + cliff LP-pull floor.
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
  priceChange1hPct: number | null;
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
  /** Arm trail when MFE ≥ this % (default 5). */
  armPct: number;
  /**
   * After armed: sell `scaleOutFraction` when giveback from peak ≤ −this %
   * (default 3). 0 = no partial scale-out (full exit only at givebackPct).
   */
  partialGivebackPct: number;
  /** Fraction of bag to sell on partial giveback (default 0.5). */
  scaleOutFraction: number;
  /** Full exit when giveback from peak ≤ −this % after armed (default 8). */
  givebackPct: number;
  /**
   * 1.11.750 — MFE bank ladder (take-profit into strength) + runner sleeve.
   * When enabled, replaces the classic armed −3%/−8% giveback scale-out.
   * Template: +8%×40% → +15%×40% → remainder trails −sleeveGiveback from peak.
   */
  mfeBankEnabled: boolean;
  /** First bank: sell `mfeBank1Fraction` of original when MFE ≥ this % (default 8). */
  mfeBank1Pct: number;
  /** Fraction of original bag sold at bank1 (default 0.4). */
  mfeBank1Fraction: number;
  /** Second bank: sell `mfeBank2Fraction` of original when MFE ≥ this % (default 15). */
  mfeBank2Pct: number;
  /** Fraction of original bag sold at bank2 (default 0.4). */
  mfeBank2Fraction: number;
  /**
   * After ≥1 bank taken: full-exit remaining when giveback from peak ≤ −this %
   * (default 12). Wide sleeve so a 20% runner can still catch 50%+ moves.
   */
  mfeBankSleeveGivebackPct: number;
  /**
   * 1.11.849 — Live Oscar's unbounded take-profit ladder, ported to mild-dip.
   *
   * Rung `k` fires at MFE ≥ k × `tpGridStepPct` and sells `tpGridSellFraction`
   * of what is *left*, so the bag is never emptied by the ladder and a name that
   * keeps climbing keeps paying. The two-rung bank it replaces sold 40% at +6%
   * and the last 60% at +8%, which capped every winner near +7% while losers ran
   * to the −25% stop.
   *
   * Oscar reference: `PAPER_TP_GRID_STEP_PNL` with an uncapped `maxK` loop
   * (`tp-grid-effective.ts:42`) and `WAVE_B_FLAT_TP_HALF8_RUNNER` = +8% × 50%
   * (`exit-policy-wave-b.ts:74`).
   *
   * 0 = off, and the mfe-bank ladder owns the armed path as before.
   */
  tpGridStepPct: number;
  /**
   * 1.11.852 — a mark that moves more than this % from the last accepted one is
   * quarantined until a second mark confirms the level. 0 = off.
   */
  markJumpConfirmPct: number;
  /**
   * 1.11.868 — the same guard for a print that came off the stream, where it
   * has to be tighter. Reversion does not scale with jump size (10–15% at every
   * band), but it does scale with source: of stream prints jumping 5–10% in one
   * tick, 46.1% reverted on the next mark, against 37.0% at 10–15% and 26.5% at
   * 15–20%. And among upward jumps of 20–25% the stream share is 31.2%, the
   * highest of any band — CX2v7JSH was one of them at +23.56%, just under the
   * 25% guard, and it armed the trail and fired a ladder rung on a coin that
   * had not moved. 0 falls back to `markJumpConfirmPct`.
   */
  markJumpConfirmStreamPct: number;
  /**
   * 1.11.855 — once MFE has reached `breakevenArmPct`, close the whole bag if
   * P&L falls to `breakevenFloorPct`. 0 = off.
   */
  breakevenArmPct: number;
  breakevenFloorPct: number;
  /** Fraction of the *remaining* bag sold at each rung (Oscar half8: 0.5). */
  tpGridSellFraction: number;
  /**
   * 1.11.861 — the ladder is no longer unbounded. When the next rung would
   * leave less than this fraction of the original bag, that rung closes the
   * position instead of shaving it again.
   *
   * At a half-remainder step and a 0.20 floor the ladder is three rungs: +8%
   * takes half, +16% takes half of what is left, and +24% closes the last
   * quarter rather than trimming it to an eighth. That matches where the
   * leaders actually bank — 42.9% of their closes on the clean day landed in
   * 0..+25% and only 8.4% above it — and it stops the tail of the ladder from
   * managing crumbs the trail would handle anyway. 0 = unbounded.
   */
  tpGridMinRemainderFraction: number;
  /**
   * 1.11.821 — do not bank in the first N ms after entry; the SPL balance is
   * not settled yet and the sell just burns retries. 0 = off.
   */
  mfeBankMinHoldMs: number;
  /**
   * After this many ms still unarmed, allow the same giveback% from the
   * (sub-arm) peak. Live default **0** — early never_arm_giveback was the grind loss.
   * 0 = disabled.
   */
  neverArmPatienceMs: number;
  /**
   * Hard hold ceiling (default 15m):
   * - unarmed → `never_arm_timeout` (always)
   * - armed + pnl ≤ 0 → `max_hold_underwater` (1.11.782)
   * - armed + pnl > 0 → keep (trail / TP steps)
   * 0 = disabled (not recommended).
   */
  neverArmMaxHoldMs: number;
  /**
   * Never-armed deep-loss cut: after this many ms (live 30m), if pnl ≤ −neverArmDeadPnlPct,
   * full exit (`never_arm_dead`). Catches rugs before max-hold without the
   * early 5m −6% knife. 0 = disabled.
   */
  neverArmDeadMinMs: number;
  /** See neverArmDeadMinMs. Positive percent (e.g. 10 = exit at ≤ −10%). */
  neverArmDeadPnlPct: number;
  /**
   * Never-armed stagnation cut: after this many ms, if MFE never exceeded
   * `neverArmStaleMaxMfePct` AND pnl ≤ −neverArmStalePnlPct → `never_arm_stale`.
   * Catches dead-path names before they grind to the deep dead threshold.
   * 0 min = off.
   */
  neverArmStaleMinMs: number;
  /** Max MFE % still considered “never moved” for stale (default 2). */
  neverArmStaleMaxMfePct: number;
  /** Stale cut when pnl ≤ −this % (default 5). 0 = off. */
  neverArmStalePnlPct: number;
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
  /**
   * Close a remaining bag at or below this notional once held `dustCloseMinHoldMs`.
   * Not a strategy gate: at $1–2 no price move changes the outcome, but the bag
   * keeps consuming Dex marks. 0 = disabled.
   */
  dustCloseUsd: number;
  dustCloseMinHoldMs: number;
  /**
   * 1.11.765 / 1.11.791 — hard stop from entry when mark pnl ≤ −this %
   * (live default 25). Fires before soft exits; never deferred by leader-align
   * or oneshot dump grace. 0 = off. Distinct from cliff (second-stage −50%).
   */
  hardStopPnlPct: number;
  /**
   * 1.11.791 / 1.11.794 — when ∈ (0,1): sell this fraction at `hardStopPnlPct`.
   * If the runner is still ≤ −hardStop after that cut, full `hard_stop` (do not
   * park bags in the −25…−50 limbo until cliff). Gap straight past cliff →
   * full `cliff_dump`. 0 or ≥1 = legacy full hard_stop (hard before cliff).
   */
  hardStopPartialFraction: number;
  /**
   * 1.11.747 — never-armed bounce reclaim: after post-entry trough ≤ −minDump%,
   * if mark bounces ≥ bouncePct off that trough → exit (`never_arm_bounce`).
   * Hard (not recover-deferred) — we sell INTO the bounce. 0 bouncePct = off.
   * 1.11.750 — also require trough age + still red vs entry (kill stream-wick churn).
   * 1.11.759 — half-first: sell `neverArmBouncePartialFraction` at bouncePct,
   * remainder at `neverArmBounce2Pct` (bigger reclaim).
   */
  neverArmBounceMinDumpPct: number;
  neverArmBouncePct: number;
  /** Trough must be the low-water for at least this long before bounce counts. */
  neverArmBounceMinTroughAgeMs: number;
  /**
   * Only fire bounce exit while mark pnl ≤ −this % vs entry (default 3).
   * Blocks F1XdRe/AENK1Y-style near-flat stream-wick reclaim sells. 0 = off.
   */
  neverArmBounceRequireRedPct: number;
  /**
   * 1.11.851 — floor on P&L before a bounce may sell.
   *
   * `neverArmBounceRequireRedPct` is the opposite gate: it *demands* the bag be
   * at least N% red, so the rule was structurally forbidden from waiting for the
   * bounce to carry us back. 6SyrTP dumped to −21.8%, reclaimed 16% off the
   * trough, and the rule sold half at −7.42%; twenty seconds later the price was
   * above entry. Set to 0 to sell into a bounce only once it has repaid the dip.
   * −1000 = off.
   */
  neverArmBounceMinPnlPct: number;
  /**
   * 1.11.759 — first bounce cut fraction (default 0.5). 0 or ≥1 = full bag on
   * first bounce (legacy).
   */
  neverArmBouncePartialFraction: number;
  /**
   * 1.11.759 — second bounce cut for the runner (default 16). Must be > first
   * bouncePct; when unset/too low, defaults to 2× first bounce.
   */
  neverArmBounce2Pct: number;
  /**
   * 1.11.759 — underwater `mfe_bank_sleeve`: sell this fraction first (default
   * 0.5), hold runner for a bigger bounce reclaim. 0 = full sleeve (legacy).
   */
  mfeBankSleeveLossPartialFraction: number;
  /**
   * 1.11.747 — never-armed freefall floor: if still unarmed and pnl ≤ −this %
   * after min hold → full exit (`never_arm_freefall`). Covers endless dumps
   * that never print a bounce. 0 = off. Default 25 (between stale grind and cliff 50).
   */
  neverArmFreefallPnlPct: number;
  neverArmFreefallMinMs: number;
  /**
   * 1.11.755 — never-armed time-red cut: after this many ms unarmed, if mark
   * pnl ≤ −neverArmTimeRedPnlPct → full exit (`never_arm_time_red`).
   * Live (1.11.792): 5m / −15% / pc5m ≤ −5 (7BNax DOWN formula). 0 min = off.
   */
  neverArmTimeRedMinMs: number;
  /** See neverArmTimeRedMinMs. Positive percent (e.g. 15 = exit at ≤ −15%). 0 = off. */
  neverArmTimeRedPnlPct: number;
  /**
   * Optional Dex pc5m gate for time-red. Positive percent N → require
   * pc5m ≤ −N when the metric is present. **0** = no pc5m requirement.
   * 1.11.794 — when > 0 and pc5m is missing, time-red still fires on
   * held+pnl (fail open) so dead marks cannot pin an underwater bag forever.
   */
  neverArmTimeRedMaxPc5mPct: number;
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
 * Flat / chop micro-dip: small pullback (−5, −1.5] while the 1h tape is not a
 * fresh knife and not ripping green. Fills the gap below main mild (≤−5) and
 * past h1_red_shallow (≤−3) — e.g. fartdog prebuy_pc5m=−2.21 before leader buy.
 */
export function evaluateFlatMicroDip(args: {
  priceChange5mPct: number | null | undefined;
  priceChange1hPct: number | null | undefined;
  minDipPct: number;
  maxDipPct: number;
  h1MinPct: number;
  h1MaxPct: number;
}): MildDipGateVerdict {
  const reasons: string[] = [];
  const pc = args.priceChange5mPct;
  if (pc == null || !Number.isFinite(pc)) {
    reasons.push('flat_micro_missing_pc5m');
  } else if (!(pc > args.minDipPct && pc <= args.maxDipPct)) {
    reasons.push(
      `flat_micro_pc5m=${pc.toFixed(2)}_outside_(${args.minDipPct},${args.maxDipPct}]`,
    );
  }
  const h1 = args.priceChange1hPct;
  if (h1 == null || !Number.isFinite(h1)) {
    reasons.push('flat_micro_missing_pc1h');
  } else if (!(h1 >= args.h1MinPct && h1 <= args.h1MaxPct)) {
    reasons.push(
      `flat_micro_pc1h=${h1.toFixed(2)}_outside_[${args.h1MinPct},${args.h1MaxPct}]`,
    );
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
 * After a full exit (esp. loss): refuse rebuy when Dex liquidity has fallen
 * vs the last-exit snapshot. Stops “sell dump → dip rebuy → dump again” on
 * draining pools. Missing liq on either side → fail open (no block).
 */
export function evaluateRebuyLiquidityDrop(args: {
  currentLiquidityUsd: number | null | undefined;
  lastExitLiquidityUsd: number | null | undefined;
  lastExitAtMs: number | null | undefined;
  lastExitPnlPct: number | null | undefined;
  nowMs: number;
  enabled: boolean;
  /** Ignore exits older than this (ms). 0 = no age cap. */
  maxAgeMs: number;
  /** 0 = any decline blocks; e.g. 5 = need ≥5% drop to block. */
  minDropPct: number;
  /** When true, only apply after a losing exit (pnlPct < 0). */
  onlyAfterLoss: boolean;
}): MildDipGateVerdict {
  const reasons: string[] = [];
  if (!args.enabled) return { pass: true, reasons };
  const lastLiq = args.lastExitLiquidityUsd;
  const curLiq = args.currentLiquidityUsd;
  const at = args.lastExitAtMs;
  if (lastLiq == null || !(lastLiq > 0)) return { pass: true, reasons };
  if (at == null || !(at > 0)) return { pass: true, reasons };
  if (args.maxAgeMs > 0 && args.nowMs - at > args.maxAgeMs) return { pass: true, reasons };
  if (args.onlyAfterLoss) {
    const pnl = args.lastExitPnlPct;
    if (pnl == null || !Number.isFinite(pnl) || !(pnl < 0)) return { pass: true, reasons };
  }
  if (curLiq == null || !(curLiq > 0)) return { pass: true, reasons };

  const dropPct = (1 - curLiq / lastLiq) * 100;
  const need = Math.max(0, args.minDropPct);
  if (dropPct >= need && curLiq < lastLiq) {
    reasons.push(
      `rebuy_liq_drop=${dropPct.toFixed(1)}%` +
        `_now=$${curLiq.toFixed(0)}<exit=$${lastLiq.toFixed(0)}` +
        (need > 0 ? `_min=${need}` : ''),
    );
  }
  return { pass: reasons.length === 0, reasons };
}

/**
 * After a full exit: refuse rebuy unless mark is at least `minBelowExitPct`
 * cheaper than the exit fill (stream mark OK — no Dex). Stops “sell → buy the
 * same green reclaim candle” without waiting on DexScreener.
 */
export function evaluateRebuyBelowExit(args: {
  freshPriceUsd: number | null;
  lastExitPriceUsd: number | null | undefined;
  lastExitAtMs: number | null | undefined;
  nowMs: number;
  /** 0 = guard off. */
  minBelowExitPct: number;
  /** Ignore exits older than this (ms). 0 = no age cap. */
  maxAgeMs: number;
}): MildDipGateVerdict {
  const reasons: string[] = [];
  const { freshPriceUsd, lastExitPriceUsd, lastExitAtMs, nowMs, minBelowExitPct, maxAgeMs } =
    args;

  if (!(minBelowExitPct > 0)) return { pass: true, reasons };
  if (lastExitPriceUsd == null || !(lastExitPriceUsd > 0)) return { pass: true, reasons };
  if (lastExitAtMs == null || !(lastExitAtMs > 0)) return { pass: true, reasons };
  if (maxAgeMs > 0 && nowMs - lastExitAtMs > maxAgeMs) return { pass: true, reasons };

  if (freshPriceUsd == null || !(freshPriceUsd > 0)) {
    reasons.push('rebuy_below_exit_missing_price');
    return { pass: false, reasons };
  }

  const belowPct = (1 - freshPriceUsd / lastExitPriceUsd) * 100;
  if (!(belowPct >= minBelowExitPct)) {
    reasons.push(
      `rebuy_below_exit=${belowPct.toFixed(2)}%<min=${minBelowExitPct}` +
        `_exit=${lastExitPriceUsd}_ageMs=${Math.max(0, nowMs - lastExitAtMs)}`,
    );
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
  | 'mfe_bank_1'
  | 'mfe_bank_2'
  /** 1.11.849 — rung of the unbounded Oscar-style ladder. */
  | 'tp_grid'
  | 'mfe_bank_sleeve'
  | 'never_arm_giveback'
  | 'never_arm_bounce'
  | 'never_arm_freefall'
  | 'never_arm_time_red'
  | 'never_arm_stale'
  | 'never_arm_dead'
  | 'never_arm_vol_fade'
  | 'never_arm_timeout'
  /** 1.11.782 — held ≥ max-hold, armed, but mark pnl ≤ 0. */
  | 'max_hold_underwater'
  | 'cliff_dump'
  | 'hard_stop'
  /** 1.11.855 — was meaningfully green, came back to the floor. */
  | 'breakeven_stop'
  /** 1.11.832 — bank/bounce remnant too small to manage; frees mark bandwidth. */
  | 'dust_close'
  /** 1.11.860 — green lane: fixed target, tight stop, short ceiling. */
  | 'green_tp'
  | 'green_stop'
  | 'green_max_hold'
  | null;

/** True when MFE-bank ladder is configured and should own the armed exit path. */
export function isMfeBankEnabled(gates: MildDipExitGates): boolean {
  return (
    gates.mfeBankEnabled === true &&
    gates.mfeBank1Pct > 0 &&
    gates.mfeBank1Fraction > 0 &&
    gates.mfeBank1Fraction < 1
  );
}

/**
 * Fraction of *current* bag to sell so that `wantOriginal` of the original
 * bag is realized, given banks already taken.
 */
export function mfeBankSellFractionOfCurrent(args: {
  wantOriginal: number;
  stage: number;
  bank1Fraction: number;
  bank2Fraction: number;
}): number {
  const f1 = args.bank1Fraction > 0 ? args.bank1Fraction : 0;
  const f2 = args.bank2Fraction > 0 ? args.bank2Fraction : 0;
  let remainingOriginal = 1;
  if (args.stage >= 1) remainingOriginal -= f1;
  if (args.stage >= 2) remainingOriginal -= f2;
  if (!(remainingOriginal > 1e-9)) return 1;
  const want = args.wantOriginal > 0 ? args.wantOriginal : 0;
  return Math.min(1, Math.max(0, want / remainingOriginal));
}

export function givebackFromPeakPct(markPriceUsd: number, peakPriceUsd: number): number | null {
  if (!(markPriceUsd > 0) || !(peakPriceUsd > 0)) return null;
  return (markPriceUsd / peakPriceUsd - 1) * 100;
}

/** Bounce % off a local trough → mark (positive when reclaiming). */
export function bounceFromTroughPct(markPriceUsd: number, troughPriceUsd: number): number | null {
  if (!(markPriceUsd > 0) || !(troughPriceUsd > 0)) return null;
  return (markPriceUsd / troughPriceUsd - 1) * 100;
}

/**
 * True when mark has reclaimed ≥ minBouncePct off the recent trough.
 * Used to defer soft exits (stale/dead/giveback) into a green reclaim candle.
 */
export function isRecoveringFromTrough(args: {
  markPriceUsd: number;
  troughPriceUsd: number;
  minBouncePct: number;
}): boolean {
  const min = args.minBouncePct > 0 ? args.minBouncePct : 0;
  if (!(min > 0)) return false;
  const bounce = bounceFromTroughPct(args.markPriceUsd, args.troughPriceUsd);
  return bounce != null && bounce >= min - 1e-9;
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
 * - Arm when MFE ≥ armPct (live default +5%)
 * - When MFE-bank enabled (1.11.750): bank at MFE levels into strength, then
 *   wide sleeve giveback on the runner remainder. Classic −3%/−8% armed path off.
 * - Else armed scale-out: giveback ≤ −partialGivebackPct → sell scaleOutFraction
 *   (once); giveback ≤ −givebackPct → sell remainder / full
 * - Never-armed: bounce reclaim → freefall floor → optional soft giveback →
 *   time-red → stale / dead / vol-fade → max-hold ceiling
 * - Live default (1.11.755 option-2): bounce + time-red 15m/−5%; freefall /
 *   stale / dead / vol-fade / max-hold off; patience off
 */
export function evaluateMildDipPeakGiveback(args: {
  entryPriceUsd: number;
  /**
   * 1.11.848 — baseline for *movement* (arm, MFE bank levels, giveback).
   *
   * The Dex mark and our fill do not share a scale: a stale or different-pool
   * snapshot can sit well above the price Jupiter actually gave us. EUB1eZ
   * filled at 7.683e-05 while the mark held 8.492e-05 — unchanged from before
   * the buy and for twelve seconds after — so the position read +10.52% with
   * the price motionless, armed the trail, fired bank1 and sold into a loss.
   *
   * Movement is only meaningful within one series, so MFE is measured from the
   * first post-entry mark when that sits above the fill. `pnlPct` keeps the
   * fill basis: the stop must answer for real money.
   */
  mfeBasisPriceUsd?: number | null;
  markPriceUsd: number;
  peakPriceUsd: number;
  armed: boolean;
  gates: MildDipExitGates;
  /** True after a successful partial scale-out on this position. */
  scaleOutDone?: boolean;
  /**
   * MFE-bank progress: 0 = none, 1 = bank1 filled, 2 = bank2 filled.
   * When omitted, falls back to `scaleOutDone ? 1 : 0` for live migration.
   */
  mfeBankStage?: number;
  /** Elapsed ms since entry; required for never-arm exits. */
  heldMs?: number;
  /** Live Dex/stream pc5m % — required when neverArmTimeRedMaxPc5mPct > 0. */
  pc5mPct?: number | null;
  /** Current 5m volume (Dex) — used to extend the spaced sample ring. */
  volume5mUsd?: number | null;
  /** 5m volume captured at entry — the fade baseline. */
  entryVolume5mUsd?: number | null;
  /** Prior spaced vol5m samples on this position (mutated via return value). */
  volFadeSamples?: readonly MildDipVolFadeSample[] | null;
  /** Wall clock for spacing samples; defaults to held-relative when omitted. */
  nowMs?: number;
  /**
   * Running post-entry trough (low-water mark). When omitted, uses
   * min(entry, mark) for this tick only.
   */
  postEntryTroughPriceUsd?: number | null;
  /** Wall clock when post-entry trough was last deepened. */
  postEntryTroughAtMs?: number | null;
  /**
   * When true, defer peak_giveback / peak_giveback_partial / never_arm_giveback
   * / mfe_bank_sleeve (one-shot emptied-bag dump grace). cliff_dump / hard_stop
   * and MFE banks (sell into strength) still fire.
   */
  oneshotDumpGraceActive?: boolean;
  /** 1.11.849 — rungs of the unbounded ladder already filled on this bag. */
  tpRungsDone?: number | null;
}): {
  peakPriceUsd: number;
  mfePct: number;
  givebackPct: number;
  armed: boolean;
  justArmed: boolean;
  shouldExit: boolean;
  /** 1 = full / remainder; (0,1) = scale-out; 0 = no sell. */
  fraction: number;
  reason: MildDipExitReason;
  /** Rung index this decision fills; null unless the reason is `tp_grid`. */
  tpRungIndex: number | null;
  pnlPct: number;
  volFadeSamples: MildDipVolFadeSample[];
  /** Updated post-entry trough (caller persists). */
  postEntryTroughPriceUsd: number;
  postEntryTroughAtMs: number;
} {
  const { entryPriceUsd, markPriceUsd, gates } = args;
  const scaleOutDone = args.scaleOutDone === true;
  const mfeBankStageRaw = Number(args.mfeBankStage);
  const mfeBankStage = Number.isFinite(mfeBankStageRaw)
    ? Math.max(0, Math.min(2, Math.floor(mfeBankStageRaw)))
    : scaleOutDone
      ? 1
      : 0;
  const heldMs = Number.isFinite(args.heldMs) ? Math.max(0, Number(args.heldMs)) : 0;
  const nowMs =
    Number.isFinite(args.nowMs) && Number(args.nowMs) > 0
      ? Number(args.nowMs)
      : heldMs;
  const oneshotGrace = args.oneshotDumpGraceActive === true;
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
  const troughPrev =
    args.postEntryTroughPriceUsd != null &&
    Number.isFinite(args.postEntryTroughPriceUsd) &&
    args.postEntryTroughPriceUsd > 0
      ? args.postEntryTroughPriceUsd
      : entryPriceUsd;
  const troughAtPrev =
    args.postEntryTroughAtMs != null &&
    Number.isFinite(args.postEntryTroughAtMs) &&
    args.postEntryTroughAtMs > 0
      ? Number(args.postEntryTroughAtMs)
      : nowMs;
  const markDeepensTrough =
    markPriceUsd > 0 && markPriceUsd < troughPrev - 1e-15;
  const postEntryTroughPriceUsd = Math.min(
    troughPrev,
    markPriceUsd > 0 ? markPriceUsd : troughPrev,
  );
  const postEntryTroughAtMs = markDeepensTrough ? nowMs : troughAtPrev;
  const troughAgeMs = Math.max(0, nowMs - postEntryTroughAtMs);
  // Movement is measured inside the mark series; P&L keeps the fill basis.
  const mfeBasis =
    args.mfeBasisPriceUsd != null &&
    Number.isFinite(args.mfeBasisPriceUsd) &&
    args.mfeBasisPriceUsd > entryPriceUsd
      ? Number(args.mfeBasisPriceUsd)
      : entryPriceUsd;
  const mfePct = mfeFromEntryPct(peakPriceUsd, mfeBasis) ?? 0;
  const givebackPct = givebackFromPeakPct(markPriceUsd, peakPriceUsd) ?? 0;
  const pnlPct =
    entryPriceUsd > 0 && markPriceUsd > 0 ? ((markPriceUsd / entryPriceUsd - 1) * 100) : 0;
  const troughDumpPct =
    entryPriceUsd > 0 && postEntryTroughPriceUsd > 0
      ? ((postEntryTroughPriceUsd / entryPriceUsd - 1) * 100)
      : 0;
  const bounceOffTroughPct =
    bounceFromTroughPct(markPriceUsd, postEntryTroughPriceUsd) ?? 0;

  let armed = args.armed === true;
  let justArmed = false;
  if (!armed && gates.armPct > 0 && mfePct >= gates.armPct) {
    armed = true;
    justArmed = true;
  }

  const hold = {
    peakPriceUsd,
    mfePct,
    givebackPct,
    armed,
    justArmed,
    shouldExit: false as const,
    fraction: 0,
    reason: null as MildDipExitReason,
    tpRungIndex: null as number | null,
    pnlPct,
    volFadeSamples,
    postEntryTroughPriceUsd,
    postEntryTroughAtMs,
  };

  // Loss floors from entry — fire before soft exits / grace / leader-align.
  const hardStop = gates.hardStopPnlPct > 0 ? gates.hardStopPnlPct : 0;
  const cliff = gates.cliffDumpPnlPct > 0 ? gates.cliffDumpPnlPct : 0;
  const hardPartial =
    gates.hardStopPartialFraction > 0 && gates.hardStopPartialFraction < 1
      ? gates.hardStopPartialFraction
      : 0;

  if (hardPartial > 0) {
    // 1.11.791 / 1.11.794 — staged: half @ hardStop; if still ≤ −hardStop after
    // that cut → full hard_stop (no −25…−50 runner limbo). Gap past cliff →
    // full cliff_dump.
    if (cliff > 0 && pnlPct <= -cliff) {
      return { ...hold, shouldExit: true, fraction: 1, reason: 'cliff_dump' };
    }
    if (hardStop > 0 && pnlPct <= -hardStop) {
      if (!scaleOutDone) {
        return {
          ...hold,
          shouldExit: true,
          fraction: hardPartial,
          reason: 'hard_stop',
        };
      }
      return { ...hold, shouldExit: true, fraction: 1, reason: 'hard_stop' };
    }
  } else {
    // Legacy: full hard_stop before cliff (tighter floor wins first).
    if (hardStop > 0 && pnlPct <= -hardStop) {
      return { ...hold, shouldExit: true, fraction: 1, reason: 'hard_stop' };
    }
    if (cliff > 0 && pnlPct <= -cliff) {
      return { ...hold, shouldExit: true, fraction: 1, reason: 'cliff_dump' };
    }
  }

  /**
   * 1.11.855 — once a bag has been meaningfully green, the trail may not hand
   * it back as a loss.
   *
   * A proportional trail on a small peak is arithmetically bound to exit under
   * water: a +13.5% peak with a 30% giveback lands at 1.135 × 0.70 = −20.5%,
   * which is exactly how 2iKmjMW3 went from +13.5% to −25.53%. The leaders'
   * peaks are far higher (median +28.75% on winners), so the same trail leaves
   * them green; ours do not have that room.
   *
   * Measured on 355 leader paths: adding this floor moves the median outcome
   * from −5.44% to 0.00% and costs 1.4 points of mean (+14.92 → +13.53). Of
   * their positions that armed at +8% and later traded back through zero, only
   * 5.4% went on to finish above +100%, so the tail barely notices.
   */
  const beArm = gates.breakevenArmPct > 0 ? gates.breakevenArmPct : 0;
  if (beArm > 0 && mfePct >= beArm && pnlPct <= gates.breakevenFloorPct + 1e-9) {
    return { ...hold, shouldExit: true, fraction: 1, reason: 'breakeven_stop' };
  }

  // 1.11.782 — hard hold ceiling for underwater armed bags (before soft trail /
  // peak_giveback_partial). Past this age only green armed runners may wait
  // for TP / trail steps. Unarmed timeout stays in the never-arm branch below.
  const maxHoldCeil = gates.neverArmMaxHoldMs > 0 ? gates.neverArmMaxHoldMs : 0;
  if (armed && maxHoldCeil > 0 && heldMs >= maxHoldCeil && pnlPct <= 0) {
    return { ...hold, shouldExit: true, fraction: 1, reason: 'max_hold_underwater' };
  }

  const fullGivebackHit =
    gates.givebackPct > 0 &&
    // epsilon: 103.5/115 is −9.999…% in IEEE float
    givebackPct <= -gates.givebackPct + 1e-9;

  const partialPct = gates.partialGivebackPct > 0 ? gates.partialGivebackPct : 0;
  const scaleFrac =
    gates.scaleOutFraction > 0 && gates.scaleOutFraction < 1 ? gates.scaleOutFraction : 0;
  const partialGivebackHit =
    partialPct > 0 &&
    scaleFrac > 0 &&
    !scaleOutDone &&
    givebackPct <= -partialPct + 1e-9;

  /**
   * Unbounded ladder (Oscar half8_runner). Owns the take-profit path when on,
   * and the sleeve below still trails whatever is left — the ladder never
   * empties the bag, so a name that keeps climbing keeps paying.
   */
  const gridStep = gates.tpGridStepPct > 0 ? gates.tpGridStepPct : 0;
  const rungsDone =
    args.tpRungsDone != null && Number.isFinite(args.tpRungsDone)
      ? Math.max(0, Math.floor(Number(args.tpRungsDone)))
      : 0;
  if (gridStep > 0) {
    const gridFrac =
      gates.tpGridSellFraction > 0 && gates.tpGridSellFraction < 1
        ? gates.tpGridSellFraction
        : 0.5;
    const gridMinHold = gates.mfeBankMinHoldMs > 0 ? gates.mfeBankMinHoldMs : 0;
    const gridReady = gridMinHold <= 0 || heldMs >= gridMinHold;
    /**
     * Rungs answer to the *current* price, as Oscar's do (`pnlFrac = xAvg − 1`,
     * `tracker.ts:5541`), not to the peak. Measuring from the peak would leave
     * every rung under a spent high still owed, and the ladder would dribble the
     * bag out on the way down at prices the peak never represented.
     *
     * No upper rung. One rung per tick, as with the bank ladder, so a gap up
     * does not fire several sells at once.
     */
    const gainPct = mfeBasis > 0 && markPriceUsd > 0 ? (markPriceUsd / mfeBasis - 1) * 100 : 0;
    const maxK = Math.floor((gainPct + 1e-9) / gridStep);
    if (gridReady && maxK > rungsDone) {
      // Remaining share of the original bag, exactly, because every rung takes
      // the same fraction of what is left.
      const remainingBefore = Math.pow(1 - gridFrac, rungsDone);
      const remainingAfter = remainingBefore * (1 - gridFrac);
      const floor =
        gates.tpGridMinRemainderFraction > 0 ? gates.tpGridMinRemainderFraction : 0;
      const closeOut = floor > 0 && remainingAfter < floor - 1e-9;
      return {
        ...hold,
        shouldExit: true,
        fraction: closeOut ? 1 : gridFrac,
        reason: 'tp_grid',
        tpRungIndex: rungsDone + 1,
      };
    }
  }

  const bankOn = gridStep <= 0 && isMfeBankEnabled(gates);
  // The sleeve trails the remainder for both ladders, so the block is shared.
  if (bankOn || gridStep > 0) {
    const f1 = gates.mfeBank1Fraction;
    const f2 =
      gates.mfeBank2Fraction > 0 && gates.mfeBank2Fraction < 1 - f1 + 1e-9
        ? gates.mfeBank2Fraction
        : 0;
    const lvl1 = gates.mfeBank1Pct;
    const lvl2 = gates.mfeBank2Pct > lvl1 ? gates.mfeBank2Pct : 0;
    const sleeveGb =
      gates.mfeBankSleeveGivebackPct > 0 ? gates.mfeBankSleeveGivebackPct : 0;

    // Bank into strength (not deferred by oneshot grace — this is take-profit).
    // One level per mark tick (same half-first discipline as classic scale-out).
    //
    // 1.11.821 — but not in the first seconds: the SPL balance is not readable
    // yet, so the sell answers `no_token_balance` and retries. Live 12h: bank1
    // fired under 10s after entry on 19% of positions, and 429 sell legs failed
    // on `no_token_balance`. `6tfuqq` banked at +8% two seconds in, spent 30s
    // retrying, and the name went on to +32%.
    const bankMinHold = gates.mfeBankMinHoldMs > 0 ? gates.mfeBankMinHoldMs : 0;
    const bankReady = bankMinHold <= 0 || heldMs >= bankMinHold;
    if (bankOn && bankReady && mfeBankStage < 1 && mfePct >= lvl1 - 1e-9) {
      return {
        ...hold,
        shouldExit: true,
        fraction: mfeBankSellFractionOfCurrent({
          wantOriginal: f1,
          stage: 0,
          bank1Fraction: f1,
          bank2Fraction: f2,
        }),
        reason: 'mfe_bank_1',
      };
    }
    if (bankOn && bankReady && mfeBankStage < 2 && f2 > 0 && lvl2 > 0 && mfePct >= lvl2 - 1e-9) {
      return {
        ...hold,
        shouldExit: true,
        fraction: mfeBankSellFractionOfCurrent({
          wantOriginal: f2,
          stage: 1,
          bank1Fraction: f1,
          bank2Fraction: f2,
        }),
        reason: 'mfe_bank_2',
      };
    }

    // Wide sleeve / pre-bank armed giveback — soft, grace-deferred.
    if (!oneshotGrace && sleeveGb > 0 && givebackPct <= -sleeveGb + 1e-9) {
      // After any profit taken: trail the remainder. Before the first rung but
      // armed: protect the full bag if the early spike already gave back sleeve
      // width.
      const tookProfit = gridStep > 0 ? rungsDone >= 1 : mfeBankStage >= 1;
      if (tookProfit || armed) {
        const lossPartial =
          gates.mfeBankSleeveLossPartialFraction > 0 &&
          gates.mfeBankSleeveLossPartialFraction < 1
            ? gates.mfeBankSleeveLossPartialFraction
            : 0;
        // EjD5Y9 / 4aWQZP…: full sleeve at −11% cut the bag into a later bounce.
        // Underwater: half first; runner waits for bounce reclaim (below), not
        // another continuous sleeve tick.
        if (pnlPct < 0 && !scaleOutDone && lossPartial > 0) {
          return {
            ...hold,
            shouldExit: true,
            fraction: lossPartial,
            reason: 'mfe_bank_sleeve',
          };
        }
        if (!(pnlPct < 0 && scaleOutDone && lossPartial > 0)) {
          return {
            ...hold,
            shouldExit: true,
            fraction: 1,
            reason: 'mfe_bank_sleeve',
          };
        }
        // else: underwater runner after sleeve-loss partial — fall through to bounce
      }
    }
  } else if (!oneshotGrace) {
    // Classic W9.1 armed giveback path (MFE-bank off).
    // One-shot emptied-bag dump: defer soft giveback knives; hard exits remain.
    // Half-first (1.11.741): when scale-out is configured (partialPct>0) and not
    // yet taken, never dump the full bag on the first giveback hit — even when
    // mark gaps past full −givebackPct (phantom stream / reclaim). Runner exits
    // later only after scaleOutDone + another full giveback hit.
    const scaleOutEnabled = partialPct > 0 && scaleFrac > 0;
    if (
      armed &&
      scaleOutEnabled &&
      !scaleOutDone &&
      (partialGivebackHit || fullGivebackHit)
    ) {
      return {
        ...hold,
        shouldExit: true,
        fraction: scaleFrac,
        reason: 'peak_giveback_partial',
      };
    }
    if (armed && fullGivebackHit) {
      return { ...hold, shouldExit: true, fraction: 1, reason: 'peak_giveback' };
    }
  }

  // Bounce reclaim (sell into bounce) — never-arm first/second cut, and armed
  // runner after underwater sleeve-loss partial (hope for a bigger reclaim).
  const givebackHit = fullGivebackHit;
  const bounceNeed = gates.neverArmBouncePct > 0 ? gates.neverArmBouncePct : 0;
  const bounceDumpNeed =
    gates.neverArmBounceMinDumpPct > 0 ? gates.neverArmBounceMinDumpPct : 0;
  const bounceTroughAge =
    gates.neverArmBounceMinTroughAgeMs > 0 ? gates.neverArmBounceMinTroughAgeMs : 0;
  const bounceRequireRed =
    gates.neverArmBounceRequireRedPct > 0 ? gates.neverArmBounceRequireRedPct : 0;
  // Absent means off, so callers predating the floor keep their behaviour.
  const bounceMinPnl = Number.isFinite(gates.neverArmBounceMinPnlPct)
    ? Number(gates.neverArmBounceMinPnlPct)
    : -1000;
  const bouncePartialFrac =
    gates.neverArmBouncePartialFraction > 0 && gates.neverArmBouncePartialFraction < 1
      ? gates.neverArmBouncePartialFraction
      : 0;
  const bounce2Need =
    gates.neverArmBounce2Pct > bounceNeed
      ? gates.neverArmBounce2Pct
      : bounceNeed > 0
        ? bounceNeed * 2
        : 0;
  const bounceBaseOk =
    bounceNeed > 0 &&
    bounceDumpNeed > 0 &&
    troughDumpPct <= -bounceDumpNeed + 1e-9 &&
    troughAgeMs >= bounceTroughAge &&
    (bounceRequireRed <= 0 || pnlPct <= -bounceRequireRed + 1e-9) &&
    pnlPct >= bounceMinPnl - 1e-9;

  if (!armed && bounceBaseOk) {
    if (!scaleOutDone && bounceOffTroughPct >= bounceNeed - 1e-9) {
      return {
        ...hold,
        shouldExit: true,
        fraction: bouncePartialFrac > 0 ? bouncePartialFrac : 1,
        reason: 'never_arm_bounce',
      };
    }
    if (
      scaleOutDone &&
      bounce2Need > 0 &&
      bounceOffTroughPct >= bounce2Need - 1e-9
    ) {
      return { ...hold, shouldExit: true, fraction: 1, reason: 'never_arm_bounce' };
    }
  }
  // Armed runner after underwater sleeve half: sell remainder on bounce reclaim.
  if (
    armed &&
    scaleOutDone &&
    pnlPct < 0 &&
    bounceBaseOk &&
    bounceOffTroughPct >= bounceNeed - 1e-9
  ) {
    return { ...hold, shouldExit: true, fraction: 1, reason: 'never_arm_bounce' };
  }

  // Never-armed branch — must always have a finite exit (no infinite hold).
  // Order: freefall floor (no bounce) → optional soft giveback → time-red →
  // stale → dead → vol fade → max-hold.
  if (!armed) {
    const freefallPnl = gates.neverArmFreefallPnlPct > 0 ? gates.neverArmFreefallPnlPct : 0;
    const freefallMin = gates.neverArmFreefallMinMs > 0 ? gates.neverArmFreefallMinMs : 0;
    if (
      freefallPnl > 0 &&
      heldMs >= freefallMin &&
      pnlPct <= -freefallPnl + 1e-9
    ) {
      return { ...hold, shouldExit: true, fraction: 1, reason: 'never_arm_freefall' };
    }
    const patience = gates.neverArmPatienceMs > 0 ? gates.neverArmPatienceMs : 0;
    if (!oneshotGrace && patience > 0 && heldMs >= patience && givebackHit) {
      return { ...hold, shouldExit: true, fraction: 1, reason: 'never_arm_giveback' };
    }
    const timeRedMin = gates.neverArmTimeRedMinMs > 0 ? gates.neverArmTimeRedMinMs : 0;
    const timeRedPnl = gates.neverArmTimeRedPnlPct > 0 ? gates.neverArmTimeRedPnlPct : 0;
    const timeRedPc =
      gates.neverArmTimeRedMaxPc5mPct > 0 ? gates.neverArmTimeRedMaxPc5mPct : 0;
    if (timeRedMin > 0 && timeRedPnl > 0 && heldMs >= timeRedMin && pnlPct <= -timeRedPnl + 1e-9) {
      let pcOk = true;
      if (timeRedPc > 0) {
        const pc =
          args.pc5mPct != null && Number.isFinite(args.pc5mPct) ? Number(args.pc5mPct) : null;
        // 1.11.794 — fail open when pc5m missing; when present require ≤ −N.
        pcOk = pc == null || pc <= -timeRedPc + 1e-9;
      }
      if (pcOk) {
        return { ...hold, shouldExit: true, fraction: 1, reason: 'never_arm_time_red' };
      }
    }
    const staleMin = gates.neverArmStaleMinMs > 0 ? gates.neverArmStaleMinMs : 0;
    const stalePnl = gates.neverArmStalePnlPct > 0 ? gates.neverArmStalePnlPct : 0;
    const staleMaxMfe =
      gates.neverArmStaleMaxMfePct >= 0 ? gates.neverArmStaleMaxMfePct : 0;
    if (
      staleMin > 0 &&
      stalePnl > 0 &&
      heldMs >= staleMin &&
      mfePct <= staleMaxMfe + 1e-9 &&
      pnlPct <= -stalePnl
    ) {
      return { ...hold, shouldExit: true, fraction: 1, reason: 'never_arm_stale' };
    }
    const deadMin = gates.neverArmDeadMinMs > 0 ? gates.neverArmDeadMinMs : 0;
    const deadPnl = gates.neverArmDeadPnlPct > 0 ? gates.neverArmDeadPnlPct : 0;
    if (deadMin > 0 && deadPnl > 0 && heldMs >= deadMin && pnlPct <= -deadPnl) {
      return { ...hold, shouldExit: true, fraction: 1, reason: 'never_arm_dead' };
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
        return { ...hold, shouldExit: true, fraction: 1, reason: 'never_arm_vol_fade' };
      }
    }
    const maxHold = gates.neverArmMaxHoldMs > 0 ? gates.neverArmMaxHoldMs : 0;
    if (maxHold > 0 && heldMs >= maxHold) {
      return { ...hold, shouldExit: true, fraction: 1, reason: 'never_arm_timeout' };
    }
  }

  return hold;
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

/** Thick-name size-up gates (liq / mcap / age) — larger clip on structural names. */
export type MildDipThickSizeGates = {
  /** Target clip when thick; ≤0 or ≤ base → size-up off. */
  positionUsd: number;
  minMarketCapUsd: number;
  minLiquidityUsd: number;
  minPairAgeHours: number;
};

/** Micro-cap size-down: smaller clip in a mcap band (e.g. $15k–$50k → $5). */
export type MildDipMicroSizeGates = {
  /** Target clip when in band; ≤0 → micro tier off. */
  positionUsd: number;
  minMarketCapUsd: number;
  /** Inclusive upper bound. */
  maxMarketCapUsd: number;
};

/**
 * 1.11.746 — micro size band applies only to knife_stabilize (post-knife bounce).
 * Other dipSources always size base/thick.
 */
export function mildDipMicroSizeGatesForSource(
  micro: MildDipMicroSizeGates | null | undefined,
  dipSource: string,
): MildDipMicroSizeGates | null {
  if (dipSource !== 'knife_stabilize') return null;
  if (!micro || !(micro.positionUsd > 0)) return null;
  return micro;
}

/**
 * When micro tier is on, knife watches may arm down to microMin mcap
 * while the global entry floor stays higher (e.g. historically $50k).
 */
export function knifeStabilizeMinMarketCapUsd(args: {
  entryMinMarketCapUsd: number;
  microPositionUsd: number;
  microMinMarketCapUsd: number;
}): number {
  if (args.microPositionUsd > 0 && args.microMinMarketCapUsd > 0) {
    return args.microMinMarketCapUsd;
  }
  return args.entryMinMarketCapUsd;
}

/**
 * Wanted entry notional:
 * - thick clip when mcap/liq/age all clear
 * - else micro clip when mcap ∈ [microMin, microMax]
 * - else base
 * Missing metrics never size up (fail closed); micro needs mcap only.
 */
export function resolveMildDipWantedSizeUsd(args: {
  basePositionUsd: number;
  thick: MildDipThickSizeGates;
  micro?: MildDipMicroSizeGates | null;
  metrics: Pick<MildDipCandidateMetrics, 'liquidityUsd' | 'marketCapUsd' | 'pairAgeHours'>;
}): { sizeUsd: number; tier: 'base' | 'thick' | 'micro' } {
  const base = args.basePositionUsd;
  const thickUsd = args.thick.positionUsd;
  const liq = args.metrics.liquidityUsd;
  const mcap = args.metrics.marketCapUsd;
  const age = args.metrics.pairAgeHours;

  // 1.11.754 — allow thick/micro when size == base (flat $30 book).
  if (
    thickUsd > 0 &&
    liq != null &&
    Number.isFinite(liq) &&
    liq >= args.thick.minLiquidityUsd &&
    mcap != null &&
    Number.isFinite(mcap) &&
    mcap >= args.thick.minMarketCapUsd &&
    age != null &&
    Number.isFinite(age) &&
    age >= args.thick.minPairAgeHours
  ) {
    return { sizeUsd: thickUsd, tier: 'thick' };
  }

  const micro = args.micro;
  const microUsd = micro?.positionUsd ?? 0;
  if (
    micro &&
    microUsd > 0 &&
    mcap != null &&
    Number.isFinite(mcap) &&
    micro.minMarketCapUsd > 0 &&
    micro.maxMarketCapUsd >= micro.minMarketCapUsd &&
    mcap >= micro.minMarketCapUsd &&
    mcap <= micro.maxMarketCapUsd
  ) {
    return { sizeUsd: microUsd, tier: 'micro' };
  }

  return { sizeUsd: base, tier: 'base' };
}
