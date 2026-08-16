/**
 * Mild-dip branch gates (entry reverse-engineered from leader sessions).
 *
 * Entry: DexScreener priceChange5m ∈ (minDipPct, maxDipPct] — default (−25, −8].
 * Exit: W9.1 peak-giveback — arm on MFE, full exit on giveback from running peak.
 *        Never-armed branch (leaders 8zkg / 7BNax): same giveback width after
 *        patience, plus max-hold if trail never arms.
 *        Optional hard stop from entry (`hard_stop`) + cliff LP-pull floor,
 *        both timed by the bounce off the trough (1.11.933).
 */
import { computeMarkLiquidityTelemetry } from './open-mark-metrics.js';

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
  /**
   * 1.11.895 — the five minutes must actually be trading.
   *
   * `minVolume5mUsd` is absolute, so a coin with a busy hour and a dead last
   * five minutes clears it. EkcTa8n1 came in on $619 of 5m volume against
   * $34,662 for the hour: 21% of the hourly pace, a drift with nobody in it
   * rather than a flush. It fell 24% over the next ten minutes and the leader
   * bought the actual flush 21 seconds after our stop.
   *
   * Ratio of 5m volume to the hourly pace (`vol1h / 12`). 0 = off.
   */
  minVolume5mPaceRatio: number;
  /**
   * 1.11.904 — 5m volume against pool liquidity: is the name still being traded
   * relative to its own size.
   *
   * GCa9TZ is the case. While both leaders were taking it, its turnover ran 0.209
   * and its 5m volume $14,090; after they stopped it ran 0.038 on $4,307, and its
   * liquidity had barely moved ($118.5k to $113.7k) — so nothing about the pool
   * broke, the name simply stopped changing hands. We kept buying it for another
   * twelve hours, nine more positions, −2.80 USD.
   *
   * The pace gate does not see this: 5m and 1h volume fell together, so the ratio
   * between them stayed healthy. Only the comparison against liquidity moves.
   * 0 = off.
   */
  minTurnover5mLiq: number;
  /**
   * 1.11.907 — upper bound on the same ratio. Above it the name is inside an
   * event rather than trading: 731 positions past 0.25 returned −0.1145 each
   * across the journal, the worst band by dollars, and negative in every window.
   * 0 = off.
   */
  maxTurnover5mLiq: number;
  /**
   * 1.11.870 — upper bound at entry. A name doing more than this in five
   * minutes is inside an event: over 499 closed bags, the 19% above $40k
   * carried 42% of the whole loss at a 0.298 win rate. 0 = off.
   */
  maxVolume5mUsd: number;
  minLiquidityUsd: number;
  minMarketCapUsd: number;
  maxMarketCapUsd: number;
  minPairAgeHours: number;
  /**
   * 1.11.905 — the age floor for a name a leader is buying, which only ever
   * lowers it. A young pair is usually unformed, but two leaders actively taking
   * one is evidence about that specific pair which the clock does not carry.
   * 0 = no exception.
   */
  minPairAgeHoursLeaderSeen: number;
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
   * Fraction of a green bag sold at the sleeve giveback before any scale-out.
   * 0 or an omitted value preserves the historical full-bag exit.
   */
  mfeBankSleeveGreenPartialFraction?: number;
  /**
   * Wide giveback trail for the green remainder after the sleeve partial.
   * 0 or an omitted value preserves the current no-op runner behavior.
   */
  mfeBankSleeveRunnerGivebackPct?: number;
  /** 1.11.957 — max quote slip below a profit decision; 0 = off. */
  profitFillMaxSlipPct?: number;
  /** 1.11.961 — max quote slip below a bounce-based loss decision; 0 = off. */
  lossFillMaxSlipPct?: number;
  /** 1.11.969 — price-adjusted liquidity drain threshold; 0 = off. */
  liqDrainRatio?: number;
  /** Minimum hold before liquidity-drain exits; 0 = off. */
  liqDrainMinAgeMs?: number;
  /** Consecutive accepted marks required for liquidity-drain exit; 0 = off. */
  liqDrainConfirmTicks?: number;
  /** Skip liquidity-drain exits for armed profitable runners. */
  liqDrainSkipArmedRunner?: boolean;
  /** Absolute current-liquidity floor; 0 = off. */
  liqAbsFloorUsd?: number;
  /** 1.11.959 — green armed quarantine blind window; 0 = off. */
  markQuarantineGreenMaxMs?: number;
  /**
   * 1.11.849 — Live Oscar's unbounded take-profit ladder, ported to mild-dip.
   *
   * Rung 1 fires at `tpGridFirstRungPct` (or `tpGridStepPct` when unset), and
   * later rungs keep spacing by `tpGridStepPct`; each sells `tpGridSellFraction`
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
  /** First TP-grid rung in gain %, 0/unset = the existing step-sized first rung. */
  tpGridFirstRungPct?: number;
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
   * 1.11.882 — measured gap between the mark and what a sell actually fills at,
   * taken off the gain side so a money threshold clears on a price we can get.
   */
  markSellHaircutPct: number;
  /**
   * 1.11.910 — the dead-set exit, which replaces a fixed loss floor.
   *
   * A stop at a number leaves on a red candle, which is the worst moment: a whale
   * emptying a position takes the price through our level and it comes back
   * without us. Instead, three things have to have gone at once - the volume, the
   * turnover and the price - and only then do we wait for the price to lift off
   * its own low before selling. The bag is condemned by the conjunction; the exit
   * is timed by the bounce.
   *
   * 0 on either fraction, or on the bounce, disables it.
   */
  deadSetVolFadeFrac: number;
  deadSetTurnFadeFrac: number;
  deadSetMinDropPct: number;
  deadSetBouncePct: number;
  deadSetMinHoldMs: number;
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
   * Cliff exit when mark pnl ≤ −this % (default 50). Catches LP-pull rugs
   * without waiting for never_arm_dead min-hold. 1.11.933 — like every other
   * loss exit it waits for the bounce off the trough (`mayFireSoftLossExit`);
   * it no longer sells into the dump itself. 0 = off.
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
   * (default 25; production may disable it). Fires before soft exits; never deferred by leader-align
   * or oneshot dump grace. 0 = off. Distinct from cliff (second-stage −50%).
   */
  hardStopPnlPct: number;
  /**
   * 1.11.791 / 1.11.794 — when ∈ (0,1): sell this fraction at `hardStopPnlPct`.
   * If the runner is still ≤ −hardStop after that cut, full `hard_stop` (do not
   * park bags in the −25…−50 limbo until cliff). Gap straight past cliff →
   * full `cliff_dump` on the bounce. 0 or ≥1 = legacy full hard_stop (hard
   * before cliff).
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
   * Armed scaled-out runners may use the never-arm bounce reclaim. Defaults on
   * for backward compatibility; production can disable this competing loss exit.
   */
  neverArmBounceArmedRunner?: boolean;
  /**
   * Only fire bounce exit while money-basis mark pnl ≤ −this % vs entry
   * (default 3).
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
   * 1.11.759 — optional underwater `mfe_bank_sleeve` fraction. 0 = sell the
   * full bag in one decision after the qualifying reclaim.
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
  /**
   * 1.11.920 — soft loss exits sell into a bounce, not on the red candle itself.
   * When gain is underwater, require mark to lift ≥ this % off the post-entry
   * trough before `mfe_bank_sleeve`, never_arm_* cuts, breakeven_stop, etc.
   * 0 = off (legacy sell on the dump tick). Uses `neverArmBounceMinTroughAgeMs`
   * for trough age before the bounce may release the sell.
   */
  lossExitMinBouncePct: number;
  /**
   * Loss-bounce drawdown safety cap. Reads the underwater `gainPct` basis,
   * whereas `hard_stop` compares `pnlPct`; staged/averaged entries can make
   * those bases differ. At or below this loss, the bounce wait is released.
   * 0 = off.
   */
  lossExitMaxDrawdownPct: number;
  /**
   * Loss-bounce time safety cap. When positive, a trough with no newer low for
   * at least this age releases the bounce wait. Trough age is measured from
   * the latest minimum, which is reset whenever a new minimum is recorded.
   * 0 = off.
   */
  lossExitMaxTroughAgeMs: number;
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

export function evaluateMildDipEntryRisk(args: {
  pairAgeHours: number | null | undefined;
  volume5mUsd: number | null | undefined;
  liquidityUsd: number | null | undefined;
  minPairAgeHours: number;
  maxVol5mToLiq: number;
}): MildDipGateVerdict {
  const reasons: string[] = [];
  if (
    args.minPairAgeHours > 0 &&
    args.pairAgeHours != null &&
    Number.isFinite(args.pairAgeHours) &&
    args.pairAgeHours < args.minPairAgeHours
  ) {
    reasons.push(
      `pair_too_young=${args.pairAgeHours.toFixed(2)}<${args.minPairAgeHours}`,
    );
  }
  if (
    args.maxVol5mToLiq > 0 &&
    args.volume5mUsd != null &&
    Number.isFinite(args.volume5mUsd) &&
    args.liquidityUsd != null &&
    Number.isFinite(args.liquidityUsd) &&
    args.liquidityUsd > 0
  ) {
    const ratio = args.volume5mUsd / args.liquidityUsd;
    if (ratio >= args.maxVol5mToLiq) {
      reasons.push(
        `vol_liq_churn_too_high=${ratio.toFixed(2)}>=${args.maxVol5mToLiq}`,
      );
    }
  }
  return { pass: reasons.length === 0, reasons };
}

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

  if (gates.minTurnover5mLiq > 0) {
    const v5 = metrics.volume5mUsd;
    const liq = metrics.liquidityUsd;
    if (v5 != null && Number.isFinite(v5) && liq != null && Number.isFinite(liq) && liq > 0) {
      const turn = v5 / liq;
      if (turn < gates.minTurnover5mLiq) {
        reasons.push(`turn=${turn.toFixed(4)}<${gates.minTurnover5mLiq}`);
      }
      if (gates.maxTurnover5mLiq > 0 && turn > gates.maxTurnover5mLiq) {
        reasons.push(`turn=${turn.toFixed(4)}>${gates.maxTurnover5mLiq}`);
      }
    }
  }

  if (gates.minVolume5mPaceRatio > 0) {
    const v5 = metrics.volume5mUsd;
    const v1 = metrics.volume1hUsd;
    // No hourly reading is not evidence of a dead window; the absolute floor
    // above still applies.
    if (v5 != null && Number.isFinite(v5) && v1 != null && Number.isFinite(v1) && v1 > 0) {
      const pace = v5 / (v1 / 12);
      if (pace < gates.minVolume5mPaceRatio) {
        reasons.push(`vol5m_pace=${pace.toFixed(2)}<${gates.minVolume5mPaceRatio}`);
      }
    }
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
  /** 1.11.910 — volume, turnover and price all gone, sold into a bounce. */
  | 'dead_set_bounce'
  /** 1.11.969 — liquidity drained faster than price. */
  | 'liq_drain'
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

/**
 * Soft loss exits must wait for lift off the trough — never sell on the red
 * candle itself (same timing idea as dead_set_bounce / never_arm_bounce).
 */
export type MildDipLossExitBounceCap = 'drawdown' | 'trough_age';

export type MildDipSoftLossExitDecision = {
  allowed: boolean;
  /** Why the cap released the bounce wait; null means legacy logic. */
  reason: MildDipLossExitBounceCap | null;
};

function lossExitBounceCapFor(args: {
  gates: MildDipExitGates;
  gainPct: number;
  troughAgeMs: number;
}): MildDipLossExitBounceCap | null {
  const maxDrawdown =
    args.gates.lossExitMaxDrawdownPct > 0 ? args.gates.lossExitMaxDrawdownPct : 0;
  if (maxDrawdown > 0 && args.gainPct <= -maxDrawdown + 1e-9) return 'drawdown';
  const maxTroughAge =
    args.gates.lossExitMaxTroughAgeMs > 0 ? args.gates.lossExitMaxTroughAgeMs : 0;
  if (maxTroughAge > 0 && args.troughAgeMs >= maxTroughAge) return 'trough_age';
  return null;
}

export function decideSoftLossExit(args: {
  gates: MildDipExitGates;
  gainPct: number;
  bounceOffTroughPct: number;
  troughAgeMs: number;
}): MildDipSoftLossExitDecision {
  const minBounce = args.gates.lossExitMinBouncePct > 0 ? args.gates.lossExitMinBouncePct : 0;
  if (!(minBounce > 0)) return { allowed: true, reason: null };
  if (args.gainPct >= 0) return { allowed: true, reason: null };
  const minAge =
    args.gates.neverArmBounceMinTroughAgeMs > 0 ? args.gates.neverArmBounceMinTroughAgeMs : 0;
  const legacyAllowed =
    (minAge <= 0 || args.troughAgeMs >= minAge) &&
    args.bounceOffTroughPct >= minBounce - 1e-9;
  if (legacyAllowed) return { allowed: true, reason: null };
  const cap = lossExitBounceCapFor(args);
  return cap != null ? { allowed: true, reason: cap } : { allowed: false, reason: null };
}

export function mayFireSoftLossExit(args: {
  gates: MildDipExitGates;
  gainPct: number;
  bounceOffTroughPct: number;
  troughAgeMs: number;
}): boolean {
  return decideSoftLossExit(args).allowed;
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
   * 1.11.873 — the mark standing next to the fill; basis for *every* threshold.
   *
   * Our fill and the Dex mark are not the same quantity. We pay the ask plus
   * price impact and fees; the mark is the pool mid. On a motionless coin a 3%
   * entry overpay therefore reads as a permanent −3%, and thresholds that mixed
   * the two bases fired on that alone: `breakeven_stop` asked for MFE (mark
   * basis) ≥ arm and P&L (fill basis) ≤ floor, which any 2% market tick
   * satisfies at once — buy, "profit", sell, lose. `never_arm_time_red` had the
   * same read on a flat coin.
   *
   * Keeping mark against mark-at-entry puts arm, ladder, trail and the loss
   * floors in one series, so each one measures a price move and nothing else.
   * Entry overpay is a sunk execution cost, answered at the entry gate
   * (slippage/chase caps), not by the exit engine.
   */
  entryMarketPriceUsd?: number | null;
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
  /** 1.11.910 — turnover now and at entry, for the dead-set conjunction. */
  turnover5mLiq?: number | null;
  entryTurnover5mLiq?: number | null;
  /** 1.11.969 — current liquidity used by the drain exit. */
  liquidityUsd?: number | null;
  /** Entry liquidity baseline used by the drain ratio. */
  entryLiquidityUsd?: number | null;
  /** Freshness of the current liquidity reading; stale metrics fail closed. */
  liquidityMetricsFresh?: boolean;
  /** Timestamp of the current open-mark metrics sample. */
  liquidityMetricsTsMs?: number | null;
  /** Prior confirmed liquidity-drain marks on this position. */
  liquidityDrainConfirmTicks?: number | null;
  /** Timestamp of the last liquidity sample counted by the confirmer. */
  liquidityDrainSampleTsMs?: number | null;
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
   * / mfe_bank_sleeve (one-shot emptied-bag dump grace). Configured cliff_dump /
   * hard_stop and MFE banks (sell into strength) still fire.
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
  /** Move measured on the loss basis — what the stops and cuts answered to. */
  pnlPct: number;
  /** Gain measured on the profit basis — what the ladder and banks answered to. */
  gainPct: number;
  /** Move since the fill: real money, for logging and P&L only. */
  pnlPctVsFill: number;
  /** Safety cap that released the soft-loss bounce wait, if one did. */
  lossExitBounceCap?: MildDipLossExitBounceCap;
  volFadeSamples: MildDipVolFadeSample[];
  /** Updated post-entry trough (caller persists). */
  postEntryTroughPriceUsd: number;
  postEntryTroughAtMs: number;
  /** Current mark lift from the updated post-entry trough. */
  bounceOffTroughPct: number;
  /** Elapsed time since the updated post-entry trough. */
  troughAgeMs: number;
  /** Updated liquidity-drain confirmation count. */
  liquidityDrainConfirmTicks?: number;
  /** Last counted liquidity sample timestamp. */
  liquidityDrainSampleTsMs?: number;
  liquidityUsd?: number | null;
  liqRatio?: number | null;
  depthDrainRatio?: number | null;
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
    entryPriceUsd,
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
  // troughAgeMs is time since the latest post-entry minimum; every new lower
  // mark resets postEntryTroughAtMs, so the age cap means no newer low arrived.
  const troughAgeMs = Math.max(0, nowMs - postEntryTroughAtMs);
  /**
   * 1.11.878 — two bases, because a gain and a loss are not the same question.
   *
   * The mark at entry and the fill disagree in both directions, and a single
   * basis manufactures a signal out of whichever gap it faces:
   *
   * - mark **above** the fill (stale or other-pool snapshot, EUB1eZ: fill
   *   7.683e-05, mark 8.492e-05 unmoved for twelve seconds). On the fill basis a
   *   motionless price read +10.52%, armed and banked into a loss.
   * - mark **below** the fill (a `wait_dip` chase: the ring records the trough
   *   the seat waited for, Jupiter fills up to `chase` above it — 5nZMRL: mark
   *   2.1971e-04, fill 2.3773e-04). On the mark basis MFE opened at +8.2%, so
   *   the +8% ladder rung fired at once and sold at −1.59%. Bought and sold at
   *   the same price, which is exactly what it looks like on chain.
   *
   * So each side takes the basis that cannot invent its own signal:
   *
   * - **taking profit** (arm, MFE banks, ladder rungs, breakeven arm) measures
   *   from `max(fill, mark)`. We never bank a gain we do not have.
   * - **loss floors** (stop, cliff, trough, the never-arm cuts) measure from
   *   `min(fill, mark)`. Entry overpay is a sunk cost, not a fall.
   *
   * Both reduce to the fill when no mark was captured beside it.
   */
  const entryMarkBasis =
    args.entryMarketPriceUsd != null &&
    Number.isFinite(args.entryMarketPriceUsd) &&
    Number(args.entryMarketPriceUsd) > 0
      ? Number(args.entryMarketPriceUsd)
      : entryPriceUsd;
  const gainBasisPriceUsd = Math.max(entryPriceUsd, entryMarkBasis);
  const lossBasisPriceUsd = Math.min(entryPriceUsd, entryMarkBasis);
  /**
   * 1.11.882 — the mark is a mid; we sell into the bid.
   *
   * Over 2009 live sells the fill landed a median 0.99% below the mark that
   * decided it, p25 −3.59%, with half of them more than 1% below. So every
   * money threshold measured on the raw mark was optimistic by about a percent,
   * which is the whole of the "sold 1% under what we paid" complaint: the rung,
   * the bounce floor and breakeven all cleared on a price we could not get.
   *
   * Oscar compares an achievable sell price against what it paid
   * (`xAvg = marketSell / ot.avgEntry`, `tracker.ts:2545`). A quote per mark
   * would cost a Jupiter call per tick, so the measured haircut stands in for
   * it. Applied to the gain only: taking a percent off the loss floors would
   * invent stops.
   */
  const sellHaircut =
    gates.markSellHaircutPct > 0 ? Math.min(gates.markSellHaircutPct, 10) / 100 : 0;
  const sellableMarkPriceUsd = markPriceUsd > 0 ? markPriceUsd * (1 - sellHaircut) : markPriceUsd;
  /**
   * Never below zero. MFE is the best the bag has been; a negative reading only
   * means the basis sits above the peak, which is a basis fault, not a price
   * move. It used to leak straight into the ladder and the arm check: a
   * `wait_dip` bag opened at MFE −11% and could not reach a rung until the
   * price climbed all the way back.
   */
  const mfePct = Math.max(
    0,
    mfeFromEntryPct(peakPriceUsd * (1 - sellHaircut), gainBasisPriceUsd) ?? 0,
  );
  /** What the ladder rungs answer to: the gain standing right now, in money. */
  const gainPct =
    gainBasisPriceUsd > 0 && sellableMarkPriceUsd > 0
      ? (sellableMarkPriceUsd / gainBasisPriceUsd - 1) * 100
      : 0;
  const givebackPct = givebackFromPeakPct(markPriceUsd, peakPriceUsd) ?? 0;
  const pnlPct =
    lossBasisPriceUsd > 0 && markPriceUsd > 0 ? (markPriceUsd / lossBasisPriceUsd - 1) * 100 : 0;
  /** Money P&L against the fill — reported, never a threshold input. */
  const pnlPctVsFill =
    entryPriceUsd > 0 && markPriceUsd > 0 ? (markPriceUsd / entryPriceUsd - 1) * 100 : 0;
  const troughDumpPct =
    lossBasisPriceUsd > 0 && postEntryTroughPriceUsd > 0
      ? (postEntryTroughPriceUsd / lossBasisPriceUsd - 1) * 100
      : 0;
  const bounceOffTroughPct =
    bounceFromTroughPct(markPriceUsd, postEntryTroughPriceUsd) ?? 0;
  const lossExitMin = gates.lossExitMinBouncePct > 0 ? gates.lossExitMinBouncePct : 0;
  let lossExitBounceCap: MildDipLossExitBounceCap | null = null;

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
    gainPct,
    pnlPctVsFill,
    bounceOffTroughPct,
    troughAgeMs,
    volFadeSamples,
    postEntryTroughPriceUsd,
    postEntryTroughAtMs,
    liquidityDrainConfirmTicks: 0,
    liquidityDrainSampleTsMs: undefined as number | undefined,
    liquidityUsd: null as number | null,
    liqRatio: null as number | null,
    depthDrainRatio: null as number | null,
  };
  const liqDrainRatio = gates.liqDrainRatio ?? 0;
  const liqDrainMinAgeMs = gates.liqDrainMinAgeMs ?? 0;
  const liqDrainConfirmTicksRequired = gates.liqDrainConfirmTicks ?? 0;
  const liqDrainSkipArmedRunner = gates.liqDrainSkipArmedRunner === true;
  const liqAbsFloorUsd = gates.liqAbsFloorUsd ?? 0;
  const priorLiqDrainTicks =
    args.liquidityDrainConfirmTicks != null &&
    Number.isFinite(args.liquidityDrainConfirmTicks) &&
    args.liquidityDrainConfirmTicks > 0
      ? Math.floor(args.liquidityDrainConfirmTicks)
      : 0;
  const liqTelemetry =
    args.liquidityUsd != null &&
    Number.isFinite(args.liquidityUsd) &&
    args.entryLiquidityUsd != null &&
    Number.isFinite(args.entryLiquidityUsd) &&
    args.entryLiquidityUsd > 0
      ? computeMarkLiquidityTelemetry({
          liquidityUsd: args.liquidityUsd,
          entryLiquidityUsd: args.entryLiquidityUsd,
          priceUsd: markPriceUsd,
          entryPriceUsd,
        })
      : { liqRatio: null, depthDrainRatio: null };
  const liqSampleTsMs =
    args.liquidityMetricsTsMs != null &&
    Number.isFinite(args.liquidityMetricsTsMs) &&
    args.liquidityMetricsTsMs > 0
      ? args.liquidityMetricsTsMs
      : null;
  const liqDrainEligible =
    (liqDrainRatio > 0 || liqAbsFloorUsd > 0) &&
    liqDrainConfirmTicksRequired > 0 &&
    heldMs >= liqDrainMinAgeMs &&
    args.liquidityMetricsFresh === true &&
    liqSampleTsMs != null &&
    args.liquidityUsd != null &&
    Number.isFinite(args.liquidityUsd) &&
    args.liquidityUsd > 0 &&
    args.entryLiquidityUsd != null &&
    Number.isFinite(args.entryLiquidityUsd) &&
    args.entryLiquidityUsd > 0 &&
    gainPct < 0 &&
    !(liqDrainSkipArmedRunner && armed && gainPct > 0);
  const ratioHit =
    liqDrainRatio > 0 &&
    liqTelemetry.depthDrainRatio != null &&
    liqTelemetry.depthDrainRatio < liqDrainRatio;
  const absFloorHit =
    liqAbsFloorUsd > 0 &&
    args.liquidityUsd != null &&
    args.liquidityUsd < liqAbsFloorUsd;
  const liqDrainHit = liqDrainEligible && (ratioHit || absFloorHit);
  const priorLiqSampleTsMs =
    args.liquidityDrainSampleTsMs != null &&
    Number.isFinite(args.liquidityDrainSampleTsMs) &&
    args.liquidityDrainSampleTsMs > 0
      ? args.liquidityDrainSampleTsMs
      : null;
  const sameLiqSample = liqSampleTsMs != null && liqSampleTsMs === priorLiqSampleTsMs;
  const liquidityDrainConfirmTicks = liqDrainHit
    ? sameLiqSample
      ? priorLiqDrainTicks
      : priorLiqDrainTicks + 1
    : 0;
  const liquidityDrainSampleTsMs = liqDrainHit && liquidityDrainConfirmTicks > 0
    ? liqSampleTsMs ?? undefined
    : undefined;
  hold.liquidityDrainConfirmTicks = liquidityDrainConfirmTicks;
  hold.liquidityDrainSampleTsMs = liquidityDrainSampleTsMs;
  hold.liquidityUsd = args.liquidityUsd ?? null;
  hold.liqRatio = liqTelemetry.liqRatio;
  hold.depthDrainRatio = liqTelemetry.depthDrainRatio;
  if (liqDrainHit && liquidityDrainConfirmTicks >= liqDrainConfirmTicksRequired) {
    return {
      ...hold,
      shouldExit: true,
      fraction: 1,
      reason: 'liq_drain',
      liquidityDrainConfirmTicks,
    };
  }
  const softLossOk = () => {
    const decision = decideSoftLossExit({ gates, gainPct, bounceOffTroughPct, troughAgeMs });
    if (decision.reason != null) lossExitBounceCap = decision.reason;
    return decision.allowed;
  };
  const withLossExitCap = <T extends object>(decision: T): T & {
    lossExitBounceCap?: MildDipLossExitBounceCap;
  } =>
    lossExitBounceCap != null ? { ...decision, lossExitBounceCap } : decision;

  /**
   * 1.11.910 — condemned by the conjunction, timed by the bounce.
   *
   * All three have to have gone: the 5m volume against what it was at entry, the
   * turnover against what it was at entry, and the price. Only then does the
   * bounce off the running low release the sell, so we are not the ones handing
   * a whale the bottom tick.
   */
  const dsVol = gates.deadSetVolFadeFrac;
  const dsTurn = gates.deadSetTurnFadeFrac;
  const dsBounce = gates.deadSetBouncePct;
  if (dsVol > 0 && dsTurn > 0 && dsBounce > 0 && heldMs >= gates.deadSetMinHoldMs) {
    const v = args.volume5mUsd;
    const v0 = args.entryVolume5mUsd;
    const t = args.turnover5mLiq;
    const t0 = args.entryTurnover5mLiq;
    const volGone = v != null && v0 != null && v0 > 0 && v <= v0 * dsVol;
    const turnGone = t != null && t0 != null && t0 > 0 && t <= t0 * dsTurn;
    const priceGone = gainPct <= -gates.deadSetMinDropPct;
    if (volGone && turnGone && priceGone && bounceOffTroughPct >= dsBounce - 1e-9) {
      return withLossExitCap({ ...hold, shouldExit: true, fraction: 1, reason: 'dead_set_bounce' });
    }
  }

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
    if (cliff > 0 && pnlPct <= -cliff && softLossOk()) {
      return withLossExitCap({ ...hold, shouldExit: true, fraction: 1, reason: 'cliff_dump' });
    }
    if (hardStop > 0 && pnlPct <= -hardStop && softLossOk()) {
      if (!scaleOutDone) {
        return withLossExitCap({
          ...hold,
          shouldExit: true,
          fraction: hardPartial,
          reason: 'hard_stop',
        });
      }
      return withLossExitCap({ ...hold, shouldExit: true, fraction: 1, reason: 'hard_stop' });
    }
  } else {
    // Legacy: full hard_stop before cliff (tighter floor wins first).
    // 1.11.932 — hard_stop waits for bounce off trough (minute-candle reclaim),
    // same as mfe_bank_sleeve / never_arm_giveback.
    // 1.11.933 — cliff_dump waits for the same bounce: no loss exit sells into
    // the dump, we never hand a whale the bottom tick.
    if (hardStop > 0 && pnlPct <= -hardStop && softLossOk()) {
      return withLossExitCap({ ...hold, shouldExit: true, fraction: 1, reason: 'hard_stop' });
    }
    if (cliff > 0 && pnlPct <= -cliff && softLossOk()) {
      return withLossExitCap({ ...hold, shouldExit: true, fraction: 1, reason: 'cliff_dump' });
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
  // Both halves are about money: it was green and it came back (1.11.878).
  if (beArm > 0 && mfePct >= beArm && gainPct <= gates.breakevenFloorPct + 1e-9) {
    if (softLossOk()) {
      return withLossExitCap({ ...hold, shouldExit: true, fraction: 1, reason: 'breakeven_stop' });
    }
  }

  // 1.11.782 — hard hold ceiling for underwater armed bags (before soft trail /
  // peak_giveback_partial). Past this age only green armed runners may wait
  // for TP / trail steps. Unarmed timeout stays in the never-arm branch below.
  const maxHoldCeil = gates.neverArmMaxHoldMs > 0 ? gates.neverArmMaxHoldMs : 0;
  // "Underwater" is money, so it reads the gain basis (1.11.881).
  if (armed && maxHoldCeil > 0 && heldMs >= maxHoldCeil && gainPct <= 0) {
    if (softLossOk()) {
      return withLossExitCap({ ...hold, shouldExit: true, fraction: 1, reason: 'max_hold_underwater' });
    }
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
     * No upper rung. A gap can owe several rungs, but they settle in one sell:
     * 7bHZ8M reached +18.31%, sold rung 1, then sold rung 2 fourteen seconds
     * later at +16.75%. Catching up in one leg avoids selling the same bag twice
     * while the price is already moving down.
     */
    const firstRung =
      gates.tpGridFirstRungPct != null && gates.tpGridFirstRungPct > 0
        ? gates.tpGridFirstRungPct
        : gridStep;
    const maxK =
      gainPct >= firstRung - 1e-9
        ? Math.floor((gainPct - firstRung + 1e-9) / gridStep) + 1
        : 0;
    if (gridReady && maxK > rungsDone) {
      // Remaining share of the original bag, exactly, because every rung takes
      // the same fraction of what is left.
      const remainingBefore = Math.pow(1 - gridFrac, rungsDone);
      const floor =
        gates.tpGridMinRemainderFraction > 0 ? gates.tpGridMinRemainderFraction : 0;
      const owedRungs = maxK - rungsDone;
      let settledRungs = owedRungs;
      let remainingAfter =
        remainingBefore * Math.pow(1 - gridFrac, settledRungs);
      /**
       * 1.11.942 — settle all owed rungs in one sell. Clamp the catch-up to the
       * largest number of rungs that stays at or above the floor; if even the
       * first rung breaches it, preserve the old full-close / trail behavior.
       */
      while (floor > 0 && remainingAfter < floor - 1e-9 && settledRungs > 0) {
        settledRungs -= 1;
        remainingAfter = remainingBefore * Math.pow(1 - gridFrac, settledRungs);
      }
      if (settledRungs === 0) {
        if (rungsDone === 0) {
          return {
            ...hold,
            shouldExit: true,
            fraction: 1,
            reason: 'tp_grid',
            tpRungIndex: rungsDone + 1,
          };
        }
        // fall through to the trail
      } else {
        return {
          ...hold,
          shouldExit: true,
          fraction: 1 - Math.pow(1 - gridFrac, settledRungs),
          reason: 'tp_grid',
          tpRungIndex: rungsDone + settledRungs,
        };
      }
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
    const runnerGb =
      gates.mfeBankSleeveRunnerGivebackPct != null &&
      gates.mfeBankSleeveRunnerGivebackPct > 0
        ? gates.mfeBankSleeveRunnerGivebackPct
        : 0;

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
    const sleeveGivebackAtTroughPct =
      peakPriceUsd > 0 && postEntryTroughPriceUsd > 0
        ? (postEntryTroughPriceUsd / peakPriceUsd - 1) * 100
        : givebackPct;
    const sleeveTroughHit = sleeveGivebackAtTroughPct <= -sleeveGb + 1e-9;
    const sleeveLiveHit = givebackPct <= -sleeveGb + 1e-9;
    // Green trails measure retracement from peak; trough path remains for losses.
    const sleeveHit =
      gainPct >= 0
        ? sleeveLiveHit
        : lossExitMin > 0
          ? sleeveTroughHit
          : sleeveLiveHit;
    const greenPartial =
      (gates.mfeBankSleeveGreenPartialFraction ?? 0) > 0 &&
      (gates.mfeBankSleeveGreenPartialFraction ?? 0) < 1
        ? (gates.mfeBankSleeveGreenPartialFraction ?? 0)
        : 0;
    const greenRunnerWidth = Math.max(sleeveGb, runnerGb);
    const greenRunnerHit =
      gainPct >= 0 &&
      scaleOutDone &&
      greenPartial > 0 &&
      runnerGb > 0 &&
      greenRunnerWidth > 0 &&
      givebackPct <= -greenRunnerWidth + 1e-9;
    if (!oneshotGrace && ((sleeveGb > 0 && sleeveHit) || greenRunnerHit)) {
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
        const bounceOk =
          gainPct >= 0 ||
          lossExitMin <= 0 ||
          mayFireSoftLossExit({ gates, gainPct, bounceOffTroughPct, troughAgeMs });
        if (!bounceOk) {
          // 1.11.920 — condemned at the trough, timed by the bounce.
        } else if (gainPct < 0 && !scaleOutDone && lossPartial > 0) {
          return {
            ...hold,
            shouldExit: true,
            fraction: lossPartial,
            reason: 'mfe_bank_sleeve',
          };
        } else if (gainPct >= 0 && !scaleOutDone && greenPartial > 0) {
          return {
            ...hold,
            shouldExit: true,
            fraction: greenPartial,
            reason: 'mfe_bank_sleeve',
          };
        } else if (gainPct >= 0 && scaleOutDone && greenPartial > 0) {
          if (greenRunnerHit) {
            return {
              ...hold,
              shouldExit: true,
              fraction: 1,
              reason: 'peak_giveback',
            };
          }
          // Green runners belong to the TP grid after the sleeve partial; the
          // runner trail above is optional and wide by design.
        } else if (!(gainPct < 0 && scaleOutDone && lossPartial > 0)) {
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
      if (softLossOk()) {
        return {
          ...hold,
          shouldExit: true,
          fraction: scaleFrac,
          reason: 'peak_giveback_partial',
        };
      }
    }
    if (armed && fullGivebackHit) {
      if (softLossOk()) {
        return withLossExitCap({ ...hold, shouldExit: true, fraction: 1, reason: 'peak_giveback' });
      }
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
    /**
     * 1.11.881 — the PnL floor remains on the gain basis, while the red
     * requirement protects the money basis from green sells.
     *
     * `bounceMinPnl` says "do not sell while we are losing", and on the loss
     * basis that sentence is not true: 7ZgRjHSn filled at 7.0630e-05 with the
     * mark at 6.9050e-05, so a floor of 0 cleared at 6.9050e-05 — which is
     * −2.24% of our money. It sold at −2.38%.
     */
    (bounceRequireRed <= 0 || pnlPct <= -bounceRequireRed + 1e-9) &&
    gainPct >= bounceMinPnl - 1e-9;

  if (!armed && bounceBaseOk) {
    if (!scaleOutDone && bounceOffTroughPct >= bounceNeed - 1e-9) {
      if (bounce2Need > 0 && bounceOffTroughPct >= bounce2Need - 1e-9) {
        return withLossExitCap({ ...hold, shouldExit: true, fraction: 1, reason: 'never_arm_bounce' });
      }
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
      return withLossExitCap({ ...hold, shouldExit: true, fraction: 1, reason: 'never_arm_bounce' });
    }
  }
  // Armed runner after underwater sleeve half: sell remainder on bounce reclaim.
  if (
    armed &&
    gates.neverArmBounceArmedRunner !== false &&
    scaleOutDone &&
    pnlPct < 0 &&
    bounceBaseOk &&
    bounceOffTroughPct >= bounceNeed - 1e-9
  ) {
    return withLossExitCap({ ...hold, shouldExit: true, fraction: 1, reason: 'never_arm_bounce' });
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
      return withLossExitCap({ ...hold, shouldExit: true, fraction: 1, reason: 'never_arm_freefall' });
    }
    const patience = gates.neverArmPatienceMs > 0 ? gates.neverArmPatienceMs : 0;
    if (!oneshotGrace && patience > 0 && heldMs >= patience && givebackHit) {
      if (softLossOk()) {
        return withLossExitCap({ ...hold, shouldExit: true, fraction: 1, reason: 'never_arm_giveback' });
      }
    }
    const timeRedMin = gates.neverArmTimeRedMinMs > 0 ? gates.neverArmTimeRedMinMs : 0;
    const timeRedPnl = gates.neverArmTimeRedPnlPct > 0 ? gates.neverArmTimeRedPnlPct : 0;
    const timeRedPc =
      gates.neverArmTimeRedMaxPc5mPct > 0 ? gates.neverArmTimeRedMaxPc5mPct : 0;
    const timeRedTroughHit =
      lossBasisPriceUsd > 0 && postEntryTroughPriceUsd > 0
        ? (postEntryTroughPriceUsd / lossBasisPriceUsd - 1) * 100 <= -timeRedPnl + 1e-9
        : false;
    const timeRedLiveHit = pnlPct <= -timeRedPnl + 1e-9;
    const timeRedNeed = lossExitMin > 0 ? timeRedTroughHit : timeRedLiveHit;
    if (timeRedMin > 0 && timeRedPnl > 0 && heldMs >= timeRedMin && timeRedNeed) {
      let pcOk = true;
      if (timeRedPc > 0) {
        const pc =
          args.pc5mPct != null && Number.isFinite(args.pc5mPct) ? Number(args.pc5mPct) : null;
        // 1.11.794 — fail open when pc5m missing; when present require ≤ −N.
        pcOk = pc == null || pc <= -timeRedPc + 1e-9;
      }
      if (pcOk && softLossOk()) {
        return withLossExitCap({ ...hold, shouldExit: true, fraction: 1, reason: 'never_arm_time_red' });
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
      if (softLossOk()) {
        return withLossExitCap({ ...hold, shouldExit: true, fraction: 1, reason: 'never_arm_stale' });
      }
    }
    const deadMin = gates.neverArmDeadMinMs > 0 ? gates.neverArmDeadMinMs : 0;
    const deadPnl = gates.neverArmDeadPnlPct > 0 ? gates.neverArmDeadPnlPct : 0;
    if (deadMin > 0 && deadPnl > 0 && heldMs >= deadMin && pnlPct <= -deadPnl) {
      if (softLossOk()) {
        return withLossExitCap({ ...hold, shouldExit: true, fraction: 1, reason: 'never_arm_dead' });
      }
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
        if (softLossOk()) {
          return withLossExitCap({ ...hold, shouldExit: true, fraction: 1, reason: 'never_arm_vol_fade' });
        }
      }
    }
    const maxHold = gates.neverArmMaxHoldMs > 0 ? gates.neverArmMaxHoldMs : 0;
    if (maxHold > 0 && heldMs >= maxHold) {
      if (gainPct >= 0 || softLossOk()) {
        return withLossExitCap({ ...hold, shouldExit: true, fraction: 1, reason: 'never_arm_timeout' });
      }
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

/** Leader-fit liquidity power law, rescaled to our clip book (see ecosystem comments). */
export type MildDipLiquidityPowerLawSize = {
  /** Multiplier k in k × liq^exp. ≤0 disables power law (flat tiers). */
  coef: number;
  /** Exponent (leader fit ≈ 0.866). */
  exp: number;
  minUsd: number;
  maxUsd: number;
};

/**
 * sizeUsd = clamp(minUsd, maxUsd, coef × liquidityUsd^exp).
 * Leader reference: 0.0387 × liq^0.866 — we use ~1.08% of that scale for $1–$30 clips.
 */
export function mildDipLiquidityPowerLawSizeUsd(
  liquidityUsd: number,
  law: MildDipLiquidityPowerLawSize,
): number {
  const { coef, exp, minUsd, maxUsd } = law;
  if (!(coef > 0) || !(exp > 0) || !(liquidityUsd > 0)) {
    return Math.min(maxUsd, Math.max(minUsd, minUsd));
  }
  const raw = coef * liquidityUsd ** exp;
  if (!Number.isFinite(raw) || raw <= 0) {
    return Math.min(maxUsd, Math.max(minUsd, minUsd));
  }
  return Math.min(maxUsd, Math.max(minUsd, raw));
}

function mildDipResolveSizeTier(args: {
  thick: MildDipThickSizeGates;
  micro?: MildDipMicroSizeGates | null;
  metrics: Pick<MildDipCandidateMetrics, 'liquidityUsd' | 'marketCapUsd' | 'pairAgeHours'>;
}): 'base' | 'thick' | 'micro' {
  const liq = args.metrics.liquidityUsd;
  const mcap = args.metrics.marketCapUsd;
  const age = args.metrics.pairAgeHours;
  const thickUsd = args.thick.positionUsd;

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
    return 'thick';
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
    return 'micro';
  }

  return 'base';
}

/**
 * Wanted entry notional:
 * - when `liqPowerLaw.coef > 0` and liq known: clamp(min, max, coef × liq^exp)
 * - else flat tier clip: thick / micro / base
 * Tier labels (thick/micro/base) are kept for telemetry either way.
 * Missing metrics never size up (fail closed); micro needs mcap only.
 */
export function resolveMildDipWantedSizeUsd(args: {
  basePositionUsd: number;
  thick: MildDipThickSizeGates;
  micro?: MildDipMicroSizeGates | null;
  liqPowerLaw?: MildDipLiquidityPowerLawSize | null;
  metrics: Pick<MildDipCandidateMetrics, 'liquidityUsd' | 'marketCapUsd' | 'pairAgeHours'>;
}): { sizeUsd: number; tier: 'base' | 'thick' | 'micro' } {
  const base = args.basePositionUsd;
  const thickUsd = args.thick.positionUsd;
  const liq = args.metrics.liquidityUsd;
  const tier = mildDipResolveSizeTier(args);

  const law = args.liqPowerLaw;
  if (law && law.coef > 0 && liq != null && Number.isFinite(liq) && liq > 0) {
    return { sizeUsd: mildDipLiquidityPowerLawSizeUsd(liq, law), tier };
  }

  if (tier === 'thick') {
    return { sizeUsd: thickUsd, tier };
  }
  if (tier === 'micro') {
    return { sizeUsd: args.micro!.positionUsd, tier };
  }

  return { sizeUsd: base, tier: 'base' };
}
