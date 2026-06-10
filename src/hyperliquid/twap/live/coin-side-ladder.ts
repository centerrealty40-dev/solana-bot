import type { TwapSide } from '../types.js';
import type { HlTwapLiveOpen } from './types.js';

export function coinSideKey(coin: string, side: TwapSide): string {
  return `${coin}:${side}`;
}

export function groupOpensByCoinSide(
  opens: Map<string, HlTwapLiveOpen>,
): Map<string, HlTwapLiveOpen[]> {
  const groups = new Map<string, HlTwapLiveOpen[]>();
  for (const pos of opens.values()) {
    const key = coinSideKey(pos.coin, pos.side);
    const list = groups.get(key);
    if (list) list.push(pos);
    else groups.set(key, [pos]);
  }
  return groups;
}

/** Notional-weighted avg entry for a stacked coin+side book. */
export function groupAvgEntryPx(group: HlTwapLiveOpen[]): number {
  let pxSum = 0;
  let total = 0;
  for (const p of group) {
    const w = Math.max(0, p.currentNotionalUsd);
    if (w <= 0) continue;
    pxSum += p.avgEntryPx * w;
    total += w;
  }
  if (total > 0) return pxSum / total;
  return group[0]?.avgEntryPx ?? 0;
}

export function groupMaxTpLevels(group: HlTwapLiveOpen[]): number {
  return Math.max(0, ...group.map((p) => p.tpLevelsTaken));
}

export function groupMaxDcaLevels(group: HlTwapLiveOpen[]): number {
  return Math.max(0, ...group.map((p) => p.dcaLevelsTaken));
}

export function applyTpLevelToGroup(group: HlTwapLiveOpen[], level: number): void {
  for (const p of group) p.tpLevelsTaken = level;
}

export function applyDcaLevelToGroup(group: HlTwapLiveOpen[], level: number): void {
  for (const p of group) p.dcaLevelsTaken = level;
}

/** Split exchange gross across journal legs by initial notional share. */
export function distributeExchangeNotional(group: HlTwapLiveOpen[], exchangeNotionalUsd: number): void {
  const totalInitial = group.reduce((s, p) => s + Math.max(0, p.initialNotionalUsd), 0);
  for (const p of group) {
    const share =
      totalInitial > 0 ? Math.max(0, p.initialNotionalUsd) / totalInitial : 1 / group.length;
    p.currentNotionalUsd = exchangeNotionalUsd * share;
  }
}

/** Primary leg for logging (earliest open). */
export function primaryOpenInGroup(group: HlTwapLiveOpen[]): HlTwapLiveOpen {
  return group.reduce((a, b) => (a.entryTs <= b.entryTs ? a : b));
}

export function sumInitialMarginUsd(group: HlTwapLiveOpen[]): number {
  return group.reduce((s, p) => s + Math.max(0, p.marginUsd), 0);
}

export function sumInitialNotionalUsd(group: HlTwapLiveOpen[]): number {
  return group.reduce((s, p) => s + Math.max(0, p.initialNotionalUsd), 0);
}
