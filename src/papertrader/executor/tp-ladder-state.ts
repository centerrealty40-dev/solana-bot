import type { TpLadderLevel } from '../config.js';
import type { OpenTrade } from '../types.js';

/** Align ladder level comparison across tracker, restore, and JSONL replay. */
export const LADDER_PNL_EPS = 1e-9;

export function ladderPnlThresholdTaken(levels: Set<number>, pnlPct: number): boolean {
  for (const u of levels) {
    if (Math.abs(u - pnlPct) <= LADDER_PNL_EPS) return true;
  }
  return false;
}

export function ladderPnlThresholdMark(levels: Set<number>, pnlPct: number): void {
  if (ladderPnlThresholdTaken(levels, pnlPct)) return;
  levels.add(pnlPct);
}

/** True if this ladder step already fired (canonical index or legacy PnL threshold set). */
export function ladderStepOrThresholdTaken(ot: OpenTrade, stepIdx: number, pnlPct: number): boolean {
  if (ot.ladderUsedIndices.has(stepIdx)) return true;
  return ladderPnlThresholdTaken(ot.ladderUsedLevels, pnlPct);
}

export function markLadderStepFired(ot: OpenTrade, stepIdx: number, pnlPct: number): void {
  ot.ladderUsedIndices.add(stepIdx);
  ladderPnlThresholdMark(ot.ladderUsedLevels, pnlPct);
}

/**
 * Merge step indices (preferred) and legacy `ladderUsedLevels` floats into sorted unique thresholds.
 */
export function collectFiredLadderPnls(ot: OpenTrade, tpLadder: TpLadderLevel[]): number[] {
  const raw: number[] = [];
  for (const i of ot.ladderUsedIndices) {
    const lvl = tpLadder[i];
    if (lvl && Number.isFinite(lvl.pnlPct)) raw.push(lvl.pnlPct);
  }
  for (const u of ot.ladderUsedLevels) {
    if (Number.isFinite(u)) raw.push(u);
  }
  raw.sort((a, b) => a - b);
  const merged: number[] = [];
  for (const x of raw) {
    const last = merged[merged.length - 1];
    if (last === undefined || Math.abs(x - last) > LADDER_PNL_EPS) merged.push(x);
  }
  return merged;
}

export type LadderRetraceMode = 'discrete' | 'grid';

/**
 * Baseline: trail floor is the PnL threshold **one rung below** the highest rung already hit.
 * Adaptive: from `minPeakSortedIdx` onward, floor moves **extraSkipRungs** deeper toward breakeven
 * (looser trail — tolerates deeper pullback before full exit).
 */
export type LadderRetraceSpec =
  | { kind: 'baseline' }
  | {
      kind: 'adaptive';
      /** Peak rung index in **sorted** ladder / fired list (0-based). When `peakIdx < minPeakSortedIdx`, baseline applies. */
      minPeakSortedIdx: number;
      /** Extra rungs toward breakeven beyond baseline floor index (`peakIdx - 1`). Typical `1` = «через одну» ступень. */
      extraSkipRungs: number;
      /** 0 = baseline floor; 1 = full adaptive floor; in-between = linear blend on PnL% (e.g. «полторы ступени»). */
      blendWideFrac?: number;
    };

function resolveAdaptiveFloorPnlPct(args: {
  peakSortedIdx: number;
  sortedThresholds: number[];
  firstRungFallback: number;
  spec: Extract<LadderRetraceSpec, { kind: 'adaptive' }>;
}): number {
  const { peakSortedIdx, sortedThresholds, firstRungFallback, spec } = args;
  const baseFloorIdx = peakSortedIdx - 1;
  const baselinePnl =
    baseFloorIdx >= 0 ? sortedThresholds[baseFloorIdx]! : Math.max(0, firstRungFallback);
  if (peakSortedIdx < spec.minPeakSortedIdx || spec.extraSkipRungs <= 0) {
    return baselinePnl;
  }
  const wideFloorIdx = baseFloorIdx - spec.extraSkipRungs;
  const widePnl = wideFloorIdx >= 0 ? sortedThresholds[wideFloorIdx]! : 0;
  const b = spec.blendWideFrac ?? 1;
  if (b <= 1e-12) return baselinePnl;
  if (b >= 1 - 1e-12) return widePnl;
  return baselinePnl + b * (widePnl - baselinePnl);
}

/**
 * PnL fraction floor (vs avg entry) that triggers ladder_retrace exit when price falls to it or below.
 */
export function ladderRetraceFloorPnlFrac(
  ot: OpenTrade,
  tpLadder: TpLadderLevel[],
  mode: LadderRetraceMode,
  tpGridFirstRungRetraceMinPnlPct: number,
  spec: LadderRetraceSpec,
): number | null {
  if (mode === 'grid') {
    const fired = collectFiredLadderPnls(ot, []);
    if (fired.length === 0) return null;
    const sortedThresholds = fired;
    const peakSortedIdx = fired.length - 1;
    if (spec.kind === 'baseline') {
      return resolveAdaptiveFloorPnlPct({
        peakSortedIdx,
        sortedThresholds,
        firstRungFallback: tpGridFirstRungRetraceMinPnlPct,
        spec: { kind: 'adaptive', minPeakSortedIdx: Infinity, extraSkipRungs: 0 },
      });
    }
    return resolveAdaptiveFloorPnlPct({
      peakSortedIdx,
      sortedThresholds,
      firstRungFallback: tpGridFirstRungRetraceMinPnlPct,
      spec,
    });
  }
  if (tpLadder.length === 0) return null;
  const fired = collectFiredLadderPnls(ot, tpLadder);
  if (fired.length === 0) return null;
  const sorted = [...tpLadder].sort((a, b) => a.pnlPct - b.pnlPct);
  const sortedThresholds = sorted.map((l) => l.pnlPct);
  const highestFired = fired[fired.length - 1]!;
  const peakSortedIdx = sorted.findIndex((l) => Math.abs(l.pnlPct - highestFired) <= LADDER_PNL_EPS);
  if (peakSortedIdx < 0) return null;
  if (spec.kind === 'baseline') {
    return resolveAdaptiveFloorPnlPct({
      peakSortedIdx,
      sortedThresholds,
      firstRungFallback: 0,
      spec: { kind: 'adaptive', minPeakSortedIdx: Infinity, extraSkipRungs: 0 },
    });
  }
  return resolveAdaptiveFloorPnlPct({
    peakSortedIdx,
    sortedThresholds,
    firstRungFallback: 0,
    spec,
  });
}

export function ladderRetraceTriggeredWithSpec(
  ot: OpenTrade,
  tpLadder: TpLadderLevel[],
  xAvg: number,
  mode: LadderRetraceMode,
  tpGridFirstRungRetraceMinPnlPct: number,
  spec: LadderRetraceSpec,
): boolean {
  /** Require ≥2 partial TP rungs before trail-by-retrace can exit — first rung (~2.5%) alone is too noisy. */
  const firedPartialSteps =
    mode === 'grid'
      ? collectFiredLadderPnls(ot, []).length
      : collectFiredLadderPnls(ot, tpLadder).length;
  if (firedPartialSteps < 2) return false;

  const floor = ladderRetraceFloorPnlFrac(ot, tpLadder, mode, tpGridFirstRungRetraceMinPnlPct, spec);
  if (floor === null) return false;
  const curPnlFrac = xAvg - 1;
  return curPnlFrac <= floor + LADDER_PNL_EPS;
}

/**
 * After partial TPs: if unrealized PnL (vs avg) falls back to the previous rung's threshold
 * relative to the highest rung already hit — close the remainder.
 */
export function ladderRetraceTriggered(
  ot: OpenTrade,
  tpLadder: TpLadderLevel[],
  xAvg: number,
  mode: LadderRetraceMode = 'discrete',
  /** Используется только в `grid`; см. config `tpGridFirstRungRetraceMinPnlPct`. */
  tpGridFirstRungRetraceMinPnlPct = 0,
): boolean {
  return ladderRetraceTriggeredWithSpec(ot, tpLadder, xAvg, mode, tpGridFirstRungRetraceMinPnlPct, {
    kind: 'baseline',
  });
}

/**
 * After partial TPs on a **grid** (no discrete `tpLadder` rows): same retrace rule using fired PnL thresholds only.
 * @param firstRungRetraceMinPnlPct когда сработала только первая ступень, подставляем этот порог вместо «0 к средней»
 *        (см. `PaperTraderConfig.tpGridFirstRungRetraceMinPnlPct`).
 */
export function ladderRetraceTriggeredGrid(
  ot: OpenTrade,
  xAvg: number,
  firstRungRetraceMinPnlPct = 0,
): boolean {
  return ladderRetraceTriggeredWithSpec(ot, [], xAvg, 'grid', firstRungRetraceMinPnlPct, {
    kind: 'baseline',
  });
}
