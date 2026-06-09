import type { FollowPosition } from './types.js';

/** Wave B exit / DCA bookkeeping on a follow position (mirrors live-oscar open fields). */
export type FollowWaveBState = {
  ladderUsedIndices: number[];
  ladderUsedLevels: number[];
  trailLevelsTaken: number[];
  peakPnlFrac: number;
  trailAnchorPnlFrac: number;
  maxExecutedTpFrac: number;
  trailingArmed: boolean;
  dcaUsedIndices: number[];
  dcaUsedLevels: number[];
  dcaLastEvalDropFromFirstPct?: number;
  lastObservedPriceUsd?: number;
};

export const FOLLOW_WAVE_B_EPS = 1e-9;

export function initFollowWaveBState(): FollowWaveBState {
  return {
    ladderUsedIndices: [],
    ladderUsedLevels: [],
    trailLevelsTaken: [],
    peakPnlFrac: 0,
    trailAnchorPnlFrac: 0,
    maxExecutedTpFrac: 0,
    trailingArmed: false,
    dcaUsedIndices: [],
    dcaUsedLevels: [],
  };
}

export function ensureFollowWaveBState(pos: FollowPosition): FollowWaveBState {
  if (!pos.waveB) pos.waveB = initFollowWaveBState();
  return pos.waveB;
}

export function followLadderTaken(wb: FollowWaveBState, stepIdx: number, thresholdFrac: number): boolean {
  if (wb.ladderUsedIndices.includes(stepIdx)) return true;
  return wb.ladderUsedLevels.some((u) => Math.abs(u - thresholdFrac) <= FOLLOW_WAVE_B_EPS);
}

export function markFollowLadderFired(wb: FollowWaveBState, stepIdx: number, thresholdFrac: number): void {
  if (!wb.ladderUsedIndices.includes(stepIdx)) wb.ladderUsedIndices.push(stepIdx);
  if (!wb.ladderUsedLevels.some((u) => Math.abs(u - thresholdFrac) <= FOLLOW_WAVE_B_EPS)) {
    wb.ladderUsedLevels.push(thresholdFrac);
  }
}

export function followDcaTaken(wb: FollowWaveBState, stepIdx: number, triggerFrac: number): boolean {
  if (wb.dcaUsedIndices.includes(stepIdx)) return true;
  return wb.dcaUsedLevels.some((u) => Math.abs(u - triggerFrac) <= FOLLOW_WAVE_B_EPS);
}

export function markFollowDcaFired(wb: FollowWaveBState, stepIdx: number, triggerFrac: number): void {
  if (!wb.dcaUsedIndices.includes(stepIdx)) wb.dcaUsedIndices.push(stepIdx);
  if (!wb.dcaUsedLevels.some((u) => Math.abs(u - triggerFrac) <= FOLLOW_WAVE_B_EPS)) {
    wb.dcaUsedLevels.push(triggerFrac);
  }
}

export function followAvgFillUsd(pos: FollowPosition): number {
  let usd = 0;
  let w = 0;
  for (const leg of pos.legs) {
    if (leg.fillPriceUsd > 0 && leg.usd > 0) {
      usd += leg.usd * leg.fillPriceUsd;
      w += leg.usd;
    }
  }
  return w > 0 ? usd / w : 0;
}

export function followTotalInvestedUsd(pos: FollowPosition): number {
  return pos.legs.reduce((s, l) => s + l.usd, 0);
}

export function followPnlFracVsAvg(pos: FollowPosition, markUsd: number): number {
  const avg = followAvgFillUsd(pos);
  if (!(avg > 0) || !(markUsd > 0)) return 0;
  return markUsd / avg - 1;
}

export function followRemainderNetUsd(pos: FollowPosition, markUsd: number): number {
  const invested = followTotalInvestedUsd(pos) * Math.max(0, pos.remainingFrac);
  const avg = followAvgFillUsd(pos);
  if (!(invested > 0) || !(markUsd > 0) || !(avg > 0)) return 0;
  return invested * (markUsd / avg);
}
