import { computeTwapSchedule } from './twap-schedule.js';
import type { NormalizedTwapSignal, TwapSide } from './types.js';

export type CrossingImpactDecision = {
  allow: boolean;
  dominant: TwapSide | null;
  diffPct: number | null;
};

/**
 * Перекрёстные TWAP на монете: доминирующая сторона ≥ min и |buy − sell| > min.
 */
export function crossingImpactDecision(
  buyPct: number | null | undefined,
  sellPct: number | null | undefined,
  minPct: number,
): CrossingImpactDecision {
  const buy = buyPct ?? 0;
  const sell = sellPct ?? 0;
  if (minPct <= 0) {
    const dominant = buy > sell ? 'buy' : sell > buy ? 'sell' : null;
    return { allow: true, dominant, diffPct: Math.abs(buy - sell) };
  }
  const diffPct = Math.abs(buy - sell);
  if (diffPct <= minPct) {
    return { allow: false, dominant: null, diffPct };
  }
  const dominant: TwapSide = buy > sell ? 'buy' : 'sell';
  const dominantPct = dominant === 'buy' ? buy : sell;
  if (dominantPct < minPct) {
    return { allow: false, dominant: null, diffPct };
  }
  return { allow: true, dominant, diffPct };
}

export type ActiveTwapLookup = {
  activeByHash: Map<string, NormalizedTwapSignal>;
};

/** Sum impact % from all active TWAPs on each side (same coin, same 24h vol basis per TWAP). */
export function aggregateCoinImpacts(twaps: NormalizedTwapSignal[]): { buyPct: number; sellPct: number } {
  let buyPct = 0;
  let sellPct = 0;
  for (const t of twaps) {
    const pct = t.volumeSharePct ?? 0;
    if (t.side === 'buy') buyPct += pct;
    else sellPct += pct;
  }
  return { buyPct, sellPct };
}

export function activeTwapsForCoin(state: ActiveTwapLookup, coin: string): NormalizedTwapSignal[] {
  return [...state.activeByHash.values()].filter((t) => t.coin === coin);
}

export type CoinEntryPlan = {
  allow: boolean;
  reason: string;
  buyPct: number;
  sellPct: number;
  diffPct: number | null;
  dominant: TwapSide | null;
  /** When to open (after 1st cycle and/or when opposing TWAPs no longer block). */
  openAtMs: number;
  /** If deferred, when the last blocking opposite TWAP ends. */
  waitForOppositeEndsMs: number | null;
};

function twapsIncludingSig(
  activeOnCoin: NormalizedTwapSignal[],
  sig: NormalizedTwapSignal,
): NormalizedTwapSignal[] {
  return activeOnCoin.some((t) => t.hash === sig.hash) ? activeOnCoin : [...activeOnCoin, sig];
}

function tryEntryPlan(
  sig: NormalizedTwapSignal,
  twaps: NormalizedTwapSignal[],
  openAtMs: number,
  minPct: number,
  reason: string,
): CoinEntryPlan | null {
  if (minPct > 0 && (sig.volumeSharePct == null || sig.volumeSharePct < minPct)) {
    return null;
  }
  const { buyPct, sellPct } = aggregateCoinImpacts(twaps);
  const { allow, dominant, diffPct } = crossingImpactDecision(buyPct, sellPct, minPct);
  if (!allow || !dominant || dominant !== sig.side) return null;
  const sched = computeTwapSchedule(sig);
  const effectiveOpen = Math.max(openAtMs, sched.paperOpenAtMs);
  return {
    allow: true,
    reason,
    buyPct,
    sellPct,
    diffPct,
    dominant,
    openAtMs: effectiveOpen,
    waitForOppositeEndsMs: effectiveOpen > sched.paperOpenAtMs ? effectiveOpen : null,
  };
}

/**
 * Before entry: aggregate all active long/short TWAPs on the coin.
 * If opposite TWAPs block net edge (>min%), defer open until they end.
 */
export function computeCoinEntryPlan(
  sig: NormalizedTwapSignal,
  state: ActiveTwapLookup,
  minPct: number,
): CoinEntryPlan {
  const activeOnCoin = activeTwapsForCoin(state, sig.coin);
  const allIncludingSig = twapsIncludingSig(activeOnCoin, sig);
  const sched = computeTwapSchedule(sig);
  const baseOpenMs = sched.paperOpenAtMs;

  const nowPlan = tryEntryPlan(sig, allIncludingSig, Math.max(baseOpenMs, Date.now()), minPct, 'ok');
  if (nowPlan) return nowPlan;

  const opposing = allIncludingSig.filter((t) => t.side !== sig.side);
  const endEvents = opposing
    .map((t) => ({ twap: t, endMs: computeTwapSchedule(t).lastCycleEtaMs }))
    .sort((a, b) => a.endMs - b.endMs);

  for (let i = 0; i < endEvents.length; i++) {
    const cutoff = endEvents[i]!.endMs;
    const endedHashes = new Set(endEvents.slice(0, i + 1).map((e) => e.twap.hash));
    const remaining = allIncludingSig.filter((t) => !endedHashes.has(t.hash));
    const plan = tryEntryPlan(sig, remaining, cutoff, minPct, 'deferred_opposite_end');
    if (plan) return plan;
  }

  const { buyPct, sellPct } = aggregateCoinImpacts(allIncludingSig);
  const { diffPct, dominant } = crossingImpactDecision(buyPct, sellPct, minPct);
  return {
    allow: false,
    reason: 'crossing_impact_no_edge',
    buyPct,
    sellPct,
    diffPct,
    dominant,
    openAtMs: baseOpenMs,
    waitForOppositeEndsMs: null,
  };
}

/** Opposite-side active TWAPs on the same coin (any whale). */
export function opposingActiveTwapsForCoin(
  state: ActiveTwapLookup,
  sig: NormalizedTwapSignal,
): NormalizedTwapSignal[] {
  return activeTwapsForCoin(state, sig.coin).filter((t) => t.side !== sig.side && t.hash !== sig.hash);
}

/** Close open position when a new/changed opposite TWAP removes our net edge. */
export function shouldCloseForImpactLoss(
  posSide: TwapSide,
  state: ActiveTwapLookup,
  coin: string,
  minPct: number,
): boolean {
  const active = activeTwapsForCoin(state, coin);
  if (active.length === 0) return false;
  const { buyPct, sellPct } = aggregateCoinImpacts(active);
  const { allow, dominant } = crossingImpactDecision(buyPct, sellPct, minPct);
  return !allow || !dominant || dominant !== posSide;
}

export function telegramMessageLink(chatId: string, messageId: number): string {
  const c = chatId.replace(/^-100/, '');
  return `https://t.me/c/${c}/${messageId}`;
}
