import { twapHourlyImpactPct } from '../coin-twap-analysis.js';
import type { TwapWatchState } from '../detect.js';
import { hlTwapEntrySide } from '../fade-whales.js';
import { computeTwapSchedule } from '../twap-schedule.js';
import type { NormalizedTwapSignal, TwapSide } from '../types.js';
import type { HlTwapLiveConfig } from './config.js';
import type { JournalSchedule } from './journal.js';
import {
  marginTiersFromConfig,
  openGrossUsdForMaxLev,
  type MarginByLevTiers,
} from './margin-by-leverage.js';
import type { HlTwapLiveOpen } from './types.js';

export type CoinStackConfig = Pick<HlTwapLiveConfig, 'coinMaxLegs' | 'coinMaxGrossUsd'> & {
  marginTiers: MarginByLevTiers;
  leverageForCoin: (coin: string) => number;
};

export type CoinStackDecision = {
  allow: boolean;
  reason: string;
};

export function stackCfgFromLiveConfig(
  cfg: HlTwapLiveConfig,
  leverageForCoin?: (coin: string) => number,
): CoinStackConfig {
  return {
    coinMaxLegs: cfg.coinMaxLegs,
    coinMaxGrossUsd: cfg.coinMaxGrossUsd,
    marginTiers: marginTiersFromConfig(cfg),
    leverageForCoin: leverageForCoin ?? (() => cfg.leverage),
  };
}

export function hourlyImpactForSignal(
  sig: Pick<NormalizedTwapSignal, 'volumeSharePct' | 'minutes' | 'notionalUsd' | 'dayNtlVlmUsd'>,
): number {
  return twapHourlyImpactPct(sig) ?? 0;
}

function hourlyImpactForOpen(open: HlTwapLiveOpen, watchState: TwapWatchState): number {
  const sig = watchState.activeByHash.get(open.hash);
  if (sig) return hourlyImpactForSignal(sig);
  const hourly = twapHourlyImpactPct({
    volumeSharePct: open.impactPct ?? 0,
    minutes: open.minutes,
    notionalUsd: open.whaleNotionalUsd ?? 0,
    dayNtlVlmUsd: null,
  });
  return hourly ?? 0;
}

export function newLegGrossUsd(cfg: CoinStackConfig, coin: string): number {
  const lev = cfg.leverageForCoin(coin);
  return openGrossUsdForMaxLev(lev, cfg.marginTiers);
}

export function bookGrossUsd(
  coin: string,
  side: TwapSide,
  opens: Map<string, HlTwapLiveOpen>,
): number {
  let sum = 0;
  for (const p of opens.values()) {
    if (p.coin === coin && p.side === side) sum += Math.max(0, p.currentNotionalUsd);
  }
  return sum;
}

export type CoinSideSlot = { hash: string; kind: 'open' | 'pending' };

export function coinSideStackSlots(
  coin: string,
  side: TwapSide,
  opens: Map<string, HlTwapLiveOpen>,
  pending: Map<string, JournalSchedule>,
): CoinSideSlot[] {
  const slots: CoinSideSlot[] = [];
  for (const [hash, p] of opens) {
    if (p.coin === coin && p.side === side) slots.push({ hash, kind: 'open' });
  }
  for (const [hash, s] of pending) {
    if (s.coin === coin && s.side === side) slots.push({ hash, kind: 'pending' });
  }
  return slots;
}

function weakestOpenImpact(
  coin: string,
  side: TwapSide,
  opens: Map<string, HlTwapLiveOpen>,
  watchState: TwapWatchState,
): number | null {
  let weakest: number | null = null;
  for (const p of opens.values()) {
    if (p.coin !== coin || p.side !== side) continue;
    const impact = hourlyImpactForOpen(p, watchState);
    if (weakest == null || impact < weakest) weakest = impact;
  }
  return weakest;
}

/** Max journal legs + gross cap per coin+side book. No triple-stack (exchange is one net position). */
export function evaluateCoinStackEntry(
  sig: NormalizedTwapSignal,
  entrySide: TwapSide,
  opens: Map<string, HlTwapLiveOpen>,
  pending: Map<string, JournalSchedule>,
  watchState: TwapWatchState,
  cfg: CoinStackConfig,
): CoinStackDecision {
  const slots = coinSideStackSlots(sig.coin, entrySide, opens, pending);
  if (slots.some((s) => s.hash === sig.hash)) {
    return { allow: true, reason: 'already_tracked' };
  }

  const newGross = newLegGrossUsd(cfg, sig.coin);
  const currentGross = bookGrossUsd(sig.coin, entrySide, opens);

  if (currentGross + newGross > cfg.coinMaxGrossUsd) {
    return { allow: false, reason: 'coin_stack_gross_cap' };
  }

  if (slots.length < cfg.coinMaxLegs) {
    return { allow: true, reason: 'coin_stack_ok' };
  }

  const newImpact = hourlyImpactForSignal(sig);
  const weakestImpact = weakestOpenImpact(sig.coin, entrySide, opens, watchState);
  if (weakestImpact != null && newImpact <= weakestImpact) {
    return { allow: false, reason: 'coin_stack_full_weaker_signal' };
  }
  return { allow: false, reason: 'coin_stack_full' };
}

/** Best-impact journal leg (for logging / fallback). */
export function driverOpenInGroup(
  group: HlTwapLiveOpen[],
  watchState: TwapWatchState,
): HlTwapLiveOpen {
  return group.reduce((best, p) =>
    hourlyImpactForOpen(p, watchState) > hourlyImpactForOpen(best, watchState) ? p : best,
  );
}

/** Best active TWAP on coin+side — includes signals without a journal leg (3rd-order re-anchor). */
export function bookDriverSignal(
  coin: string,
  entrySide: TwapSide,
  group: HlTwapLiveOpen[],
  watchState: TwapWatchState,
): NormalizedTwapSignal | null {
  let best: NormalizedTwapSignal | null = null;
  let bestImpact = -1;
  for (const sig of watchState.activeByHash.values()) {
    if (sig.coin !== coin) continue;
    if (hlTwapEntrySide(sig.user, sig.side) !== entrySide) continue;
    const impact = hourlyImpactForSignal(sig);
    if (impact > bestImpact) {
      bestImpact = impact;
      best = sig;
    }
  }
  if (best) return best;
  if (group.length === 0) return null;
  return watchState.activeByHash.get(driverOpenInGroup(group, watchState).hash) ?? null;
}

/** Timer exit for the whole book follows the best-impact active TWAP schedule. */
export function bookDriverCloseAtMs(
  coin: string,
  entrySide: TwapSide,
  group: HlTwapLiveOpen[],
  watchState?: TwapWatchState,
): number {
  if (group.length === 0) return 0;
  if (!watchState) return group[0]!.liveCloseAtMs;
  const sig = bookDriverSignal(coin, entrySide, group, watchState);
  if (sig) return computeTwapSchedule(sig).paperCloseAtMs;
  return driverOpenInGroup(group, watchState).liveCloseAtMs;
}

export function dcaWouldExceedBookGrossCap(
  bookGross: number,
  addUsd: number,
  maxGrossUsd: number,
): boolean {
  return bookGross + addUsd > maxGrossUsd;
}
