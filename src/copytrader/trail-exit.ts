/**
 * Self-managed exit for `COPY_TRADER_EXIT_MODE=trail_runner`.
 *
 * Hard take-profit, peak trail after arm, then time cap. Leader sells are not
 * mirrored here — that is a separate `mirror` lane.
 */
import type { CopyTraderConfig } from './config.js';
import type { CopyPosition, CopyTraderState } from './state.js';
import { hasPendingSellForMint } from './state.js';

export type TrailExitReason = 'take_profit' | 'trail_giveback' | 'time_cap';

export type TrailExitDecision = {
  action: 'hold' | 'exit';
  reason?: TrailExitReason;
  armed: boolean;
  peakPriceUsd: number;
  gainPct: number;
};

export type TrailExitConfig = Pick<
  CopyTraderConfig,
  'trailArmPct' | 'trailGivebackPct' | 'trailTakeProfitPct' | 'trailTimeCapMs'
>;

export type TrailExitInput = {
  entryPriceUsd: number;
  currentPriceUsd: number;
  peakPriceUsd?: number;
  entryTs: number;
  trailArmedAt?: number;
  nowMs: number;
};

export function decideTrailExit(cfg: TrailExitConfig, input: TrailExitInput): TrailExitDecision {
  const entry = input.entryPriceUsd;
  const price = input.currentPriceUsd;
  const prevPeak = input.peakPriceUsd ?? 0;

  if (!(entry > 0) || !(price > 0)) {
    return { action: 'hold', armed: input.trailArmedAt != null, peakPriceUsd: prevPeak, gainPct: 0 };
  }

  const peak = Math.max(prevPeak, entry, price);
  const gainPct = (price / entry - 1) * 100;
  const armed = input.trailArmedAt != null || gainPct >= cfg.trailArmPct;

  if (cfg.trailTakeProfitPct > 0 && gainPct >= cfg.trailTakeProfitPct) {
    return { action: 'exit', reason: 'take_profit', armed: true, peakPriceUsd: peak, gainPct };
  }

  if (armed && cfg.trailGivebackPct > 0) {
    const stop = peak * (1 - cfg.trailGivebackPct / 100);
    if (price <= stop) {
      return { action: 'exit', reason: 'trail_giveback', armed, peakPriceUsd: peak, gainPct };
    }
  }

  if (cfg.trailTimeCapMs > 0 && input.nowMs - input.entryTs >= cfg.trailTimeCapMs) {
    return { action: 'exit', reason: 'time_cap', armed, peakPriceUsd: peak, gainPct };
  }

  return { action: 'hold', armed, peakPriceUsd: peak, gainPct };
}

export type TrailExitEvent = {
  pos: CopyPosition;
  reason: TrailExitReason;
  priceUsd: number;
  peakPriceUsd: number;
  gainPct: number;
  heldMs: number;
};

export type TrailExitDeps = {
  resolvePriceUsd: (mint: string) => Promise<number>;
  scheduleExit: (event: TrailExitEvent) => void;
};

/**
 * Marks outside this band of our entry are a wrong-pair quote, not a move, and
 * must not arm or trip the trail. Wide enough to keep real memecoin runs.
 */
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
    // A queued mirror sell already owns this exit; if it expires the trail re-fires.
    if (hasPendingSellForMint(state, pos.mint)) continue;

    const price = await deps.resolvePriceUsd(pos.mint);
    const heldMs = Math.max(0, nowMs - pos.entryTs);
    const capReached = cfg.trailTimeCapMs > 0 && heldMs >= cfg.trailTimeCapMs;

    if (!isSaneTrailMark(pos.entryPriceUsd, price)) {
      // A quoteless or wrong-pair mark must not strand the position past the cap.
      if (!capReached) continue;
      deps.scheduleExit({
        pos,
        reason: 'time_cap',
        priceUsd: price > 0 ? price : pos.entryPriceUsd,
        peakPriceUsd: pos.peakPriceUsd ?? pos.entryPriceUsd,
        gainPct: 0,
        heldMs,
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
      nowMs,
    });

    pos.peakPriceUsd = decision.peakPriceUsd;
    if (decision.armed && pos.trailArmedAt == null) pos.trailArmedAt = nowMs;

    if (decision.action !== 'exit' || !decision.reason) continue;

    deps.scheduleExit({
      pos,
      reason: decision.reason,
      priceUsd: price,
      peakPriceUsd: decision.peakPriceUsd,
      gainPct: decision.gainPct,
      heldMs,
    });
    scheduled += 1;
  }

  return scheduled;
}
