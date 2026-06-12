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

/** Ladder slice as collateral — used for dynamic-margin DCA headroom at entry. */
export function sliceMarginUsd(initialMarginUsd: number, cfg: LadderConfig): number {
  return initialMarginUsd * (cfg.slicePctOfInitial / 100);
}

/** TP/DCA gross slice: slicePct% of live position (e.g. $1.8k on $6k at 30%). */
export function ladderSliceGrossUsd(currentNotionalUsd: number, cfg: LadderConfig): number {
  return currentNotionalUsd * (cfg.slicePctOfInitial / 100);
}

/** @deprecated use {@link ladderSliceGrossUsd} */
export function tpSliceGrossUsd(currentNotionalUsd: number, cfg: LadderConfig): number {
  return ladderSliceGrossUsd(currentNotionalUsd, cfg);
}

/** @deprecated use {@link ladderSliceGrossUsd} */
export function sliceNotionalUsd(initialNotionalUsd: number, cfg: LadderConfig): number {
  return initialNotionalUsd * (cfg.slicePctOfInitial / 100);
}

/**
 * Hyperliquid UI ROE % = unrealized PnL / margin (collateral).
 * Matches clearinghouse display — not raw price move % (which is ~ROE / leverage).
 */
export function hlRoePct(
  side: TwapSide,
  markPx: number,
  avgEntryPx: number,
  currentNotionalUsd: number,
  marginUsd: number,
): number {
  if (marginUsd <= 0) return 0;
  const pnlUsd = unrealizedUsd(side, avgEntryPx, currentNotionalUsd, markPx);
  return (pnlUsd / marginUsd) * 100;
}

/** Next ladder action: ±stepPct **HL ROE** on book margin; slice = slicePct% of current gross. */
export function nextLadderAction(
  side: TwapSide,
  markPx: number,
  entryAnchorPx: number,
  initialMarginUsd: number,
  initialNotionalUsd: number,
  currentNotionalUsd: number,
  tpLevelsTaken: number,
  dcaLevelsTaken: number,
  cfg: LadderConfig,
  _leverage = 1,
): LadderAction | null {
  if (markPx <= 0 || entryAnchorPx <= 0 || initialMarginUsd <= 0 || initialNotionalUsd <= 0) return null;
  if (currentNotionalUsd <= 0) return null;

  const roePct = hlRoePct(side, markPx, entryAnchorPx, currentNotionalUsd, initialMarginUsd);
  const sliceGross = ladderSliceGrossUsd(currentNotionalUsd, cfg);

  const nextTpThreshold = (tpLevelsTaken + 1) * cfg.stepPct;
  if (roePct >= nextTpThreshold) {
    const take = Math.min(sliceGross, currentNotionalUsd);
    if (take <= 0) return null;
    return { kind: 'take_profit', level: tpLevelsTaken + 1, notionalUsd: take };
  }

  const nextDcaThreshold = -(dcaLevelsTaken + 1) * cfg.stepPct;
  if (roePct <= nextDcaThreshold) {
    if (sliceGross <= 0) return null;
    return { kind: 'add', level: dcaLevelsTaken + 1, notionalUsd: sliceGross };
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
