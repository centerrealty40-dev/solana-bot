import { computeTwapSchedule } from './twap-schedule.js';
import type { NormalizedTwapSignal, TwapSide } from './types.js';
import { isMicroTwapMinutes, twapDurationGate } from './twap-duration.js';
import { isDeniedWhale } from './whale-denylist.js';
import { hlTwapUnrestrictedMode } from './unrestricted.js';

export type CrossingImpactDecision = {
  allow: boolean;
  dominant: TwapSide | null;
  diffPct: number | null;
};

/** Product policy: sole entry filter — hourly impact ≥ this (cannot be lowered via env). */
export const HL_TWAP_IMPACT_FLOOR_PCT_HOUR = 2;

/** Min net hourly impact on dominant side (default 2 %/hour, floor 2). */
export function minImpactPctHour(): number {
  const v = process.env.HL_TWAP_MIN_IMPACT_PCT_HOUR?.trim();
  let n = HL_TWAP_IMPACT_FLOOR_PCT_HOUR;
  if (v != null && v !== '') {
    const parsed = Number(v);
    if (Number.isFinite(parsed) && parsed >= 0) n = parsed;
  }
  return Math.max(HL_TWAP_IMPACT_FLOOR_PCT_HOUR, n);
}

/**
 * Hourly pressure rate from TWAP size + duration.
 * Full-notional share of 24h vol spread over `minutes` → % per active hour.
 * Example: 3% of day vol over 60m TWAP → 3%/h; same over 24h → 0.125%/h.
 */
export function twapHourlyImpactPct(
  sig: Pick<NormalizedTwapSignal, 'volumeSharePct' | 'minutes' | 'notionalUsd' | 'dayNtlVlmUsd'>,
): number | null {
  const mins = Math.max(1, Math.round(sig.minutes || 0));
  if (sig.volumeSharePct != null && sig.volumeSharePct > 0) {
    return (sig.volumeSharePct * 60) / mins;
  }
  if (sig.dayNtlVlmUsd != null && sig.dayNtlVlmUsd > 0 && sig.notionalUsd > 0) {
    const share = (sig.notionalUsd / sig.dayNtlVlmUsd) * 100;
    return (share * 60) / mins;
  }
  return null;
}

/**
 * Перекрёстные TWAP: доминирующая сторона ≥ min и |buy − sell| > min.
 * Values are **hourly** impact rates (%/hour) when used for entry.
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
  const dominant: TwapSide | null = buy > sell ? 'buy' : sell > buy ? 'sell' : null;
  if (!dominant) {
    return { allow: false, dominant: null, diffPct };
  }
  const dominantPct = dominant === 'buy' ? buy : sell;
  if (dominantPct < minPct) {
    return { allow: false, dominant: null, diffPct };
  }
  const opposingPct = dominant === 'buy' ? sell : buy;
  if (opposingPct <= 0) {
    return { allow: true, dominant, diffPct };
  }
  if (diffPct <= minPct) {
    return { allow: false, dominant: null, diffPct };
  }
  return { allow: true, dominant, diffPct };
}

export type ActiveTwapLookup = {
  activeByHash: Map<string, NormalizedTwapSignal>;
};

/** Sum daily-volume share % from all active TWAPs (legacy / display). */
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

/** Sum hourly impact rates (%/hour) from all active TWAPs on the coin. */
export function aggregateCoinHourlyImpacts(twaps: NormalizedTwapSignal[]): {
  buyPctPerHour: number;
  sellPctPerHour: number;
} {
  let buyPctPerHour = 0;
  let sellPctPerHour = 0;
  for (const t of twaps) {
    const h = twapHourlyImpactPct(t) ?? 0;
    if (t.side === 'buy') buyPctPerHour += h;
    else sellPctPerHour += h;
  }
  return { buyPctPerHour, sellPctPerHour };
}

export function activeTwapsForCoin(state: ActiveTwapLookup, coin: string): NormalizedTwapSignal[] {
  return [...state.activeByHash.values()].filter((t) => t.coin === coin);
}

function twapsIncludingSig(
  activeOnCoin: NormalizedTwapSignal[],
  sig: NormalizedTwapSignal,
): NormalizedTwapSignal[] {
  return activeOnCoin.some((t) => t.hash === sig.hash) ? activeOnCoin : [...activeOnCoin, sig];
}

export type CoinEntryPlan = {
  allow: boolean;
  reason: string;
  /** Daily vol share % (sum, display). */
  buyPct: number;
  sellPct: number;
  /** Hourly impact %/h (entry math). */
  buyPctPerHour: number;
  sellPctPerHour: number;
  diffPct: number | null;
  dominant: TwapSide | null;
  openAtMs: number;
  waitForOppositeEndsMs: number | null;
};

function buildEntryPlan(
  twaps: NormalizedTwapSignal[],
  fields: {
    allow: boolean;
    reason: string;
    diffPct: number | null;
    dominant: TwapSide | null;
    openAtMs: number;
    waitForOppositeEndsMs: number | null;
  },
): CoinEntryPlan {
  const { buyPct, sellPct } = aggregateCoinImpacts(twaps);
  const { buyPctPerHour, sellPctPerHour } = aggregateCoinHourlyImpacts(twaps);
  return {
    ...fields,
    buyPct,
    sellPct,
    buyPctPerHour,
    sellPctPerHour,
  };
}

function tryEntryPlan(
  sig: NormalizedTwapSignal,
  twaps: NormalizedTwapSignal[],
  openAtMs: number,
  minHourPct: number,
  reason: string,
): CoinEntryPlan | null {
  if (twapHourlyImpactPct(sig) == null) return null;

  const { buyPctPerHour, sellPctPerHour } = aggregateCoinHourlyImpacts(twaps);
  const { allow, dominant, diffPct } = crossingImpactDecision(
    buyPctPerHour,
    sellPctPerHour,
    minHourPct,
  );
  if (!allow || !dominant || dominant !== sig.side) return null;

  const sched = computeTwapSchedule(sig);
  const effectiveOpen = Math.max(openAtMs, sched.paperOpenAtMs);
  return buildEntryPlan(twaps, {
    allow: true,
    reason,
    diffPct,
    dominant,
    openAtMs: effectiveOpen,
    waitForOppositeEndsMs: reason === 'deferred_opposite_end' ? effectiveOpen : null,
  });
}

/**
 * Entry plan: aggregate **hourly** impact across all active TWAPs on coin.
 * Enter when our side dominates (≥ min %/h, Δ > min). Defer until opposing TWAPs end if needed.
 */
export function computeCoinEntryPlan(
  sig: NormalizedTwapSignal,
  state: ActiveTwapLookup,
  minHourPct = minImpactPctHour(),
): CoinEntryPlan {
  const activeOnCoin = activeTwapsForCoin(state, sig.coin);
  const allIncludingSig = twapsIncludingSig(activeOnCoin, sig);
  const sched = computeTwapSchedule(sig);
  const baseOpenMs = sched.paperOpenAtMs;

  const deny = (reason: string): CoinEntryPlan => {
    const { buyPctPerHour, sellPctPerHour } = aggregateCoinHourlyImpacts(allIncludingSig);
    const { diffPct, dominant } = crossingImpactDecision(
      buyPctPerHour,
      sellPctPerHour,
      minHourPct,
    );
    return buildEntryPlan(allIncludingSig, {
      allow: false,
      reason,
      diffPct,
      dominant,
      openAtMs: baseOpenMs,
      waitForOppositeEndsMs: null,
    });
  };

  if (hlTwapUnrestrictedMode()) {
    const okReason = isMicroTwapMinutes(sig.minutes) ? 'ok_micro' : 'ok';

    const nowPlan = tryEntryPlan(
      sig,
      allIncludingSig,
      Math.max(baseOpenMs, Date.now()),
      minHourPct,
      okReason,
    );
    if (nowPlan) return nowPlan;

    const opposing = allIncludingSig.filter((t) => t.side !== sig.side);
    const endEvents = opposing
      .map((t) => ({ twap: t, endMs: computeTwapSchedule(t).lastCycleEtaMs }))
      .sort((a, b) => a.endMs - b.endMs);

    for (let i = 0; i < endEvents.length; i++) {
      const cutoff = endEvents[i]!.endMs;
      const endedHashes = new Set(endEvents.slice(0, i + 1).map((e) => e.twap.hash));
      const remaining = allIncludingSig.filter((t) => !endedHashes.has(t.hash));
      const plan = tryEntryPlan(sig, remaining, cutoff, minHourPct, 'deferred_opposite_end');
      if (plan) return plan;
    }

    return deny('hourly_impact_no_edge');
  }

  if (isDeniedWhale(sig.user)) {
    return deny('whale_denylisted');
  }

  const duration = twapDurationGate(sig.minutes);
  if (!duration.allow) {
    return deny(duration.reason);
  }

  const nowPlan = tryEntryPlan(
    sig,
    allIncludingSig,
    Math.max(baseOpenMs, Date.now()),
    minHourPct,
    'ok',
  );
  if (nowPlan) return nowPlan;

  const opposing = allIncludingSig.filter((t) => t.side !== sig.side);
  const endEvents = opposing
    .map((t) => ({ twap: t, endMs: computeTwapSchedule(t).lastCycleEtaMs }))
    .sort((a, b) => a.endMs - b.endMs);

  for (let i = 0; i < endEvents.length; i++) {
    const cutoff = endEvents[i]!.endMs;
    const endedHashes = new Set(endEvents.slice(0, i + 1).map((e) => e.twap.hash));
    const remaining = allIncludingSig.filter((t) => !endedHashes.has(t.hash));
    const plan = tryEntryPlan(sig, remaining, cutoff, minHourPct, 'deferred_opposite_end');
    if (plan) return plan;
  }

  return deny('hourly_impact_no_edge');
}

export function opposingActiveTwapsForCoin(
  state: ActiveTwapLookup,
  sig: NormalizedTwapSignal,
): NormalizedTwapSignal[] {
  return activeTwapsForCoin(state, sig.coin).filter((t) => t.side !== sig.side && t.hash !== sig.hash);
}

/** Close when hourly impact no longer supports our side. */
export function shouldCloseForImpactLoss(
  posSide: TwapSide,
  state: ActiveTwapLookup,
  coin: string,
  minHourPct = minImpactPctHour(),
): boolean {
  const active = activeTwapsForCoin(state, coin);
  if (active.length === 0) return false;
  const { buyPctPerHour, sellPctPerHour } = aggregateCoinHourlyImpacts(active);
  const { allow, dominant } = crossingImpactDecision(
    buyPctPerHour,
    sellPctPerHour,
    minHourPct,
  );
  return !allow || !dominant || dominant !== posSide;
}

export function telegramMessageLink(chatId: string, messageId: number): string {
  const c = chatId.replace(/^-100/, '');
  return `https://t.me/c/${c}/${messageId}`;
}
