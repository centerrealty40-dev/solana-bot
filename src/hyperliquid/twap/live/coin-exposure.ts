import type { TwapWatchState } from '../detect.js';
import { crossingImpactDecision } from '../detect.js';
import type { NormalizedTwapSignal, TwapSide } from '../types.js';
import type { HlTwapLiveOpen } from './types.js';

export type LiveEntryDecision = {
  allow: boolean;
  reason: string;
};

/** Active TWAP on same coin, opposite side (any whale). */
export function oppositeActiveTwapForCoin(
  state: TwapWatchState,
  sig: NormalizedTwapSignal,
): NormalizedTwapSignal | null {
  const want: TwapSide = sig.side === 'buy' ? 'sell' : 'buy';
  for (const active of state.activeByHash.values()) {
    if (active.coin !== sig.coin) continue;
    if (active.side !== want) continue;
    return active;
  }
  return null;
}

/**
 * Opposite TWAP while in position: hold if impact diff > minPct (dominant side keeps seat).
 */
export function shouldHoldOnOppositeTwap(
  _posSide: TwapSide,
  posImpactPct: number | null,
  oppositeImpactPct: number | null,
  minDiffPct: number,
): boolean {
  if (posImpactPct == null || oppositeImpactPct == null) return true;
  return Math.abs(posImpactPct - oppositeImpactPct) > minDiffPct;
}

/** One live position per coin — long OR short, never both. */
export function canScheduleLiveEntry(
  coin: string,
  side: TwapSide,
  impactPct: number | null,
  openByCoin: Map<string, HlTwapLiveOpen>,
  oppositeTwap: NormalizedTwapSignal | null,
  minImpactPct: number,
): LiveEntryDecision {
  if (minImpactPct > 0 && (impactPct == null || impactPct < minImpactPct)) {
    return { allow: false, reason: 'impact_below_min' };
  }

  const existing = openByCoin.get(coin);
  if (!existing) {
    if (oppositeTwap) {
      const buyPct = side === 'buy' ? impactPct : oppositeTwap.volumeSharePct;
      const sellPct = side === 'sell' ? impactPct : oppositeTwap.volumeSharePct;
      const { allow, dominant } = crossingImpactDecision(buyPct, sellPct, minImpactPct);
      if (!allow || !dominant || dominant !== side) {
        return { allow: false, reason: 'crossing_impact_no_edge' };
      }
    }
    return { allow: true, reason: 'ok' };
  }

  if (existing.side === side) {
    return { allow: false, reason: 'coin_already_open_same_side' };
  }

  const oppositeImpact = impactPct;
  if (shouldHoldOnOppositeTwap(existing.side, existing.impactPct, oppositeImpact, minImpactPct)) {
    return { allow: false, reason: 'opposite_twap_hold_dominant' };
  }

  return { allow: false, reason: 'opposite_twap_no_flip' };
}

export function indexOpensByCoin(opens: Map<string, HlTwapLiveOpen>): Map<string, HlTwapLiveOpen> {
  const byCoin = new Map<string, HlTwapLiveOpen>();
  for (const pos of opens.values()) {
    byCoin.set(pos.coin, pos);
  }
  return byCoin;
}
