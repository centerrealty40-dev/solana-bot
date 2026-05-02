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

/**
 * After partial TPs: if unrealized PnL (vs avg) falls back to the previous rung's threshold
 * relative to the highest rung already hit — close the remainder.
 */
export function ladderRetraceTriggered(ot: OpenTrade, tpLadder: TpLadderLevel[], xAvg: number): boolean {
  if (tpLadder.length === 0) return false;
  const fired = collectFiredLadderPnls(ot, tpLadder);
  if (fired.length === 0) return false;
  const sorted = [...tpLadder].sort((a, b) => a.pnlPct - b.pnlPct);
  const highestFired = fired[fired.length - 1];
  const idx = sorted.findIndex((l) => Math.abs(l.pnlPct - highestFired) <= LADDER_PNL_EPS);
  if (idx < 0) return false;
  const prevThreshold = idx > 0 ? sorted[idx - 1].pnlPct : 0;
  const curPnlFrac = xAvg - 1;
  return curPnlFrac <= prevThreshold + LADDER_PNL_EPS;
}
