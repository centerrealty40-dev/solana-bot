import type { TwapSide } from '../types.js';

export type LadderMode = 'price' | 'roe' | 'off';

export type LadderConfig = {
  /** `price` = ±% from avg entry px; `roe` = legacy HL ROE ladder. */
  mode: LadderMode;
  stepPct: number;
  slicePctOfInitial: number;
  /** Price-mode DCA: single add as % of initial gross (default 50). */
  dcaPctOfInitial: number;
};

/** TP price threshold % from avg entry for level N (1-based). */
export function tpPriceThresholdPct(level: number): number {
  if (level <= 1) return 0.3;
  if (level === 2) return 0.5;
  if (level === 3) return 1;
  return 1 + (level - 3) * 0.5;
}

/** TP slice as % of current gross for level N (1-based). */
export function tpPriceSlicePct(level: number): number {
  return level === 1 ? 20 : 30;
}

export const PRICE_LADDER_DCA_THRESHOLD_PCT = 0.5;

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

function nextPriceLadderAction(
  side: TwapSide,
  markPx: number,
  avgEntryPx: number,
  initialNotionalUsd: number,
  currentNotionalUsd: number,
  tpLevelsTaken: number,
  dcaLevelsTaken: number,
  cfg: LadderConfig,
): LadderAction | null {
  const favPct = favorableMovePct(side, markPx, avgEntryPx);
  const nextTpLevel = tpLevelsTaken + 1;
  const tpThreshold = tpPriceThresholdPct(nextTpLevel);
  if (favPct >= tpThreshold) {
    const slicePct = tpPriceSlicePct(nextTpLevel);
    const take = Math.min(currentNotionalUsd * (slicePct / 100), currentNotionalUsd);
    if (take <= 0) return null;
    return { kind: 'take_profit', level: nextTpLevel, notionalUsd: take };
  }

  if (dcaLevelsTaken < 1 && favPct <= -PRICE_LADDER_DCA_THRESHOLD_PCT) {
    const add = initialNotionalUsd * (cfg.dcaPctOfInitial / 100);
    if (add <= 0) return null;
    return { kind: 'add', level: 1, notionalUsd: add };
  }

  return null;
}

function nextRoeLadderAction(
  side: TwapSide,
  markPx: number,
  entryAnchorPx: number,
  initialMarginUsd: number,
  _initialNotionalUsd: number,
  currentNotionalUsd: number,
  tpLevelsTaken: number,
  dcaLevelsTaken: number,
  cfg: LadderConfig,
): LadderAction | null {
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

/** Next ladder action (price-% from avg entry, or legacy HL ROE). */
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
  if (cfg.mode === 'off') return null;

  if (cfg.mode === 'price') {
    return nextPriceLadderAction(
      side,
      markPx,
      entryAnchorPx,
      initialNotionalUsd,
      currentNotionalUsd,
      tpLevelsTaken,
      dcaLevelsTaken,
      cfg,
    );
  }

  return nextRoeLadderAction(
    side,
    markPx,
    entryAnchorPx,
    initialMarginUsd,
    initialNotionalUsd,
    currentNotionalUsd,
    tpLevelsTaken,
    dcaLevelsTaken,
    cfg,
  );
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
