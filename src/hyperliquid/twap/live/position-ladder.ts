import type { TwapSide } from '../types.js';

export type LadderConfig = {
  stepPct: number;
  slicePctOfInitial: number;
};

export type LadderAction =
  | { kind: 'take_profit'; level: number; notionalUsd: number }
  | { kind: 'add'; level: number; notionalUsd: number };

/** Favorable PnL move % from entry anchor (long: price up, short: price down). */
export function favorableMovePct(side: TwapSide, markPx: number, entryAnchorPx: number): number {
  if (entryAnchorPx <= 0 || markPx <= 0) return 0;
  const raw = ((markPx - entryAnchorPx) / entryAnchorPx) * 100;
  return side === 'buy' ? raw : -raw;
}

export function sliceNotionalUsd(initialNotionalUsd: number, cfg: LadderConfig): number {
  return initialNotionalUsd * (cfg.slicePctOfInitial / 100);
}

/** Next ladder action at current mark, or null if no threshold crossed.
 *  `leverage` scales price move to approximate margin ROE (price% × leverage). */
export function nextLadderAction(
  side: TwapSide,
  markPx: number,
  entryAnchorPx: number,
  initialNotionalUsd: number,
  currentNotionalUsd: number,
  tpLevelsTaken: number,
  dcaLevelsTaken: number,
  cfg: LadderConfig,
  leverage = 1,
): LadderAction | null {
  if (markPx <= 0 || entryAnchorPx <= 0 || initialNotionalUsd <= 0) return null;

  const lev = Math.max(1, leverage);
  const move = favorableMovePct(side, markPx, entryAnchorPx) * lev;
  const slice = sliceNotionalUsd(initialNotionalUsd, cfg);

  const nextTpThreshold = (tpLevelsTaken + 1) * cfg.stepPct;
  if (move >= nextTpThreshold) {
    const take = Math.min(slice, currentNotionalUsd);
    if (take <= 0) return null;
    return { kind: 'take_profit', level: tpLevelsTaken + 1, notionalUsd: take };
  }

  const nextDcaThreshold = -(dcaLevelsTaken + 1) * cfg.stepPct;
  if (move <= nextDcaThreshold) {
    return { kind: 'add', level: dcaLevelsTaken + 1, notionalUsd: slice };
  }

  return null;
}

/** Update avg entry after DCA add. */
export function avgEntryAfterAdd(
  avgEntryPx: number,
  currentNotionalUsd: number,
  addNotionalUsd: number,
  fillPx: number,
): number {
  if (addNotionalUsd <= 0 || fillPx <= 0) return avgEntryPx;
  const total = currentNotionalUsd + addNotionalUsd;
  if (total <= 0) return fillPx;
  return (avgEntryPx * currentNotionalUsd + fillPx * addNotionalUsd) / total;
}

export function unrealizedUsd(
  side: TwapSide,
  avgEntryPx: number,
  currentNotionalUsd: number,
  markPx: number,
): number {
  const dir = side === 'buy' ? 1 : -1;
  const pnlPct = dir * ((markPx - avgEntryPx) / avgEntryPx) * 100;
  return (pnlPct / 100) * currentNotionalUsd;
}
