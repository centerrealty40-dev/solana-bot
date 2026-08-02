/**
 * Self-managed exit for `COPY_TRADER_EXIT_MODE=trail_runner`.
 *
 * Modelled on live-oscar `half8_runner`: ladder of partial take-profits, then a
 * defensive trail that peels the runner on pullbacks from peak. No hard ceiling
 * that banks the whole bag at +25% — a +200% candle keeps riding under the trail.
 * Leader sells are not mirrored here (separate `mirror` lane).
 */
import type { CopyTraderConfig } from './config.js';
import type { CopyPosition, CopyTraderState } from './state.js';
import { hasPendingSellForMint } from './state.js';

export type TrailExitReason = 'tp_rung' | 'trail_giveback' | 'kill' | 'take_profit' | 'time_cap';

export type TrailExitDecision = {
  action: 'hold' | 'sell';
  reason?: TrailExitReason;
  /** Fraction of the *current* wallet balance to sell. */
  fraction: number;
  armed: boolean;
  peakPriceUsd: number;
  gainPct: number;
  tpRungsTaken: number;
  trailGivebackStepsTaken: number;
};

export type TrailExitConfig = Pick<
  CopyTraderConfig,
  | 'trailArmPct'
  | 'trailGivebackPct'
  | 'trailTakeProfitPct'
  | 'trailTpStepPct'
  | 'trailTpSellFraction'
  | 'trailTrailSellFraction'
  | 'trailKillPct'
  | 'trailTimeCapMs'
>;

export type TrailExitInput = {
  entryPriceUsd: number;
  currentPriceUsd: number;
  peakPriceUsd?: number;
  entryTs: number;
  trailArmedAt?: number;
  tpRungsTaken?: number;
  trailGivebackStepsTaken?: number;
  /** Deployed cost — only used to decide when the remainder is dust. */
  sizeUsd?: number;
  nowMs: number;
};

/** Remainder under this USD estimate is flushed in full (Oscar ~$100; we size $100). */
const DUST_USD = 20;

export function decideTrailExit(cfg: TrailExitConfig, input: TrailExitInput): TrailExitDecision {
  const entry = input.entryPriceUsd;
  const price = input.currentPriceUsd;
  const prevPeak = input.peakPriceUsd ?? 0;
  let tpRungsTaken = Math.max(0, Math.floor(input.tpRungsTaken ?? 0));
  let trailSteps = Math.max(0, Math.floor(input.trailGivebackStepsTaken ?? 0));

  if (!(entry > 0) || !(price > 0)) {
    return {
      action: 'hold',
      fraction: 0,
      armed: input.trailArmedAt != null,
      peakPriceUsd: prevPeak,
      gainPct: 0,
      tpRungsTaken,
      trailGivebackStepsTaken: trailSteps,
    };
  }

  const peak = Math.max(prevPeak, entry, price);
  /** New high resets the giveback ladder from that peak (Oscar trail re-anchors). */
  if (peak > prevPeak + entry * 1e-12) trailSteps = 0;

  const gainPct = (price / entry - 1) * 100;
  const armed =
    input.trailArmedAt != null || gainPct >= cfg.trailArmPct || tpRungsTaken > 0;

  const remEst = estimateRemainderUsd(input.sizeUsd ?? 0, tpRungsTaken, trailSteps, cfg);
  const flush = remEst > 0 && remEst <= DUST_USD;

  if (cfg.trailKillPct > 0 && gainPct <= -cfg.trailKillPct) {
    return {
      action: 'sell',
      reason: 'kill',
      fraction: 1,
      armed,
      peakPriceUsd: peak,
      gainPct,
      tpRungsTaken,
      trailGivebackStepsTaken: trailSteps,
    };
  }

  /** Oscar half8 ladder: each +step% vs entry peels trailTpSellFraction of remainder. */
  if (cfg.trailTpStepPct > 0 && cfg.trailTpSellFraction > 0) {
    const nextRung = (tpRungsTaken + 1) * cfg.trailTpStepPct;
    if (gainPct + 1e-9 >= nextRung) {
      return {
        action: 'sell',
        reason: 'tp_rung',
        fraction: flush ? 1 : clampFrac(cfg.trailTpSellFraction),
        armed: true,
        peakPriceUsd: peak,
        gainPct,
        tpRungsTaken: tpRungsTaken + 1,
        trailGivebackStepsTaken: trailSteps,
      };
    }
  } else if (cfg.trailTakeProfitPct > 0 && gainPct >= cfg.trailTakeProfitPct) {
    /** Legacy hard full TP — only when the ladder is off. */
    return {
      action: 'sell',
      reason: 'take_profit',
      fraction: 1,
      armed: true,
      peakPriceUsd: peak,
      gainPct,
      tpRungsTaken,
      trailGivebackStepsTaken: trailSteps,
    };
  }

  if (armed && cfg.trailGivebackPct > 0) {
    const nextLevel = peak * (1 - (cfg.trailGivebackPct / 100) * (trailSteps + 1));
    if (price <= nextLevel) {
      const frac =
        flush || cfg.trailTrailSellFraction <= 0 || cfg.trailTrailSellFraction >= 1
          ? 1
          : clampFrac(cfg.trailTrailSellFraction);
      return {
        action: 'sell',
        reason: 'trail_giveback',
        fraction: frac,
        armed,
        peakPriceUsd: peak,
        gainPct,
        tpRungsTaken,
        trailGivebackStepsTaken: trailSteps + 1,
      };
    }
  }

  if (cfg.trailTimeCapMs > 0 && input.nowMs - input.entryTs >= cfg.trailTimeCapMs) {
    return {
      action: 'sell',
      reason: 'time_cap',
      fraction: 1,
      armed,
      peakPriceUsd: peak,
      gainPct,
      tpRungsTaken,
      trailGivebackStepsTaken: trailSteps,
    };
  }

  return {
    action: 'hold',
    fraction: 0,
    armed,
    peakPriceUsd: peak,
    gainPct,
    tpRungsTaken,
    trailGivebackStepsTaken: trailSteps,
  };
}

function clampFrac(f: number): number {
  if (!(f > 0)) return 1;
  return Math.min(1, f);
}

function estimateRemainderUsd(
  sizeUsd: number,
  tpRungs: number,
  trailSteps: number,
  cfg: TrailExitConfig,
): number {
  if (!(sizeUsd > 0)) return 0;
  const tpKeep = cfg.trailTpStepPct > 0 ? 1 - clampFrac(cfg.trailTpSellFraction) : 1;
  const trailKeep =
    cfg.trailTrailSellFraction > 0 && cfg.trailTrailSellFraction < 1
      ? 1 - cfg.trailTrailSellFraction
      : 0;
  let rem = sizeUsd;
  for (let i = 0; i < tpRungs; i++) rem *= tpKeep;
  for (let i = 0; i < trailSteps; i++) rem *= trailKeep > 0 ? trailKeep : 0;
  return rem;
}

export type TrailExitEvent = {
  pos: CopyPosition;
  reason: TrailExitReason;
  fraction: number;
  priceUsd: number;
  peakPriceUsd: number;
  gainPct: number;
  heldMs: number;
  tpRungsTaken: number;
  trailGivebackStepsTaken: number;
};

export type TrailExitDeps = {
  resolvePriceUsd: (mint: string) => Promise<number>;
  scheduleExit: (event: TrailExitEvent) => void;
};

const MARK_SANITY_MULTIPLE = 50;

export function isSaneTrailMark(entryPriceUsd: number, priceUsd: number): boolean {
  if (!(entryPriceUsd > 0) || !(priceUsd > 0)) return false;
  return priceUsd <= entryPriceUsd * MARK_SANITY_MULTIPLE && priceUsd >= entryPriceUsd / MARK_SANITY_MULTIPLE;
}

/** Returns the number of exits scheduled on this pass. */
export async function processTrailingExits(
  cfg: CopyTraderConfig,
  state: CopyTraderState,
  deps: TrailExitDeps,
  nowMs = Date.now(),
): Promise<number> {
  let scheduled = 0;

  for (const pos of Object.values(state.positions)) {
    if (pos.oscarPromotedAt != null) continue;
    if (!(pos.entryPriceUsd > 0)) continue;
    if (hasPendingSellForMint(state, pos.mint)) continue;

    const price = await deps.resolvePriceUsd(pos.mint);
    const heldMs = Math.max(0, nowMs - pos.entryTs);
    const capReached = cfg.trailTimeCapMs > 0 && heldMs >= cfg.trailTimeCapMs;

    if (!isSaneTrailMark(pos.entryPriceUsd, price)) {
      if (!capReached) continue;
      deps.scheduleExit({
        pos,
        reason: 'time_cap',
        fraction: 1,
        priceUsd: price > 0 ? price : pos.entryPriceUsd,
        peakPriceUsd: pos.peakPriceUsd ?? pos.entryPriceUsd,
        gainPct: 0,
        heldMs,
        tpRungsTaken: pos.trailTpRungsTaken ?? 0,
        trailGivebackStepsTaken: pos.trailGivebackStepsTaken ?? 0,
      });
      scheduled += 1;
      continue;
    }

    const decision = decideTrailExit(cfg, {
      entryPriceUsd: pos.entryPriceUsd,
      currentPriceUsd: price,
      peakPriceUsd: pos.peakPriceUsd,
      entryTs: pos.entryTs,
      trailArmedAt: pos.trailArmedAt,
      tpRungsTaken: pos.trailTpRungsTaken,
      trailGivebackStepsTaken: pos.trailGivebackStepsTaken,
      sizeUsd: pos.sizeUsd,
      nowMs,
    });

    pos.peakPriceUsd = decision.peakPriceUsd;
    if (decision.armed && pos.trailArmedAt == null) pos.trailArmedAt = nowMs;
    /** Persist step counters even on hold so a peak reset sticks. */
    pos.trailGivebackStepsTaken = decision.trailGivebackStepsTaken;

    if (decision.action !== 'sell' || !decision.reason) continue;

    pos.trailTpRungsTaken = decision.tpRungsTaken;
    pos.trailGivebackStepsTaken = decision.trailGivebackStepsTaken;

    deps.scheduleExit({
      pos,
      reason: decision.reason,
      fraction: decision.fraction,
      priceUsd: price,
      peakPriceUsd: decision.peakPriceUsd,
      gainPct: decision.gainPct,
      heldMs,
      tpRungsTaken: decision.tpRungsTaken,
      trailGivebackStepsTaken: decision.trailGivebackStepsTaken,
    });
    scheduled += 1;
  }

  return scheduled;
}
