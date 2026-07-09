import type { LiveStagedEntryState } from './types.js';

/** Prod avg @ −10%: up to 4 × entry-split slice (e.g. 3×$500 on $1500 avg budget). */
export const AVG_SPLIT_LEG_COUNT = 4;

export type AvgSplitLegIndex = 1 | 2 | 3 | 4;

const TIMED_AVG_LEG_INDICES: AvgSplitLegIndex[] = [2, 3, 4];

export function avgSplitLegUsdFromState(st: LiveStagedEntryState, legIndex: AvgSplitLegIndex): number {
  switch (legIndex) {
    case 1:
      return st.avgSecondLegUsd ?? st.secondLegUsd ?? 0;
    case 2:
      return st.avgSplitLeg2Usd ?? 0;
    case 3:
      return st.avgSplitLeg3Usd ?? 0;
    case 4:
      return st.avgSplitLeg4Usd ?? 0;
    default:
      return 0;
  }
}

export function avgSplitLegDoneFromState(st: LiveStagedEntryState, legIndex: AvgSplitLegIndex): boolean {
  switch (legIndex) {
    case 1:
      return st.avgFirstLegDone === true;
    case 2:
      return st.avgSplitLeg2Done === true;
    case 3:
      return st.avgSplitLeg3Done === true;
    case 4:
      return st.avgSplitLeg4Done === true;
    default:
      return true;
  }
}

export function setAvgSplitLegDone(st: LiveStagedEntryState, legIndex: AvgSplitLegIndex, done: boolean): void {
  switch (legIndex) {
    case 1:
      if (done) st.avgFirstLegDone = true;
      break;
    case 2:
      st.avgSplitLeg2Done = done;
      break;
    case 3:
      st.avgSplitLeg3Done = done;
      break;
    case 4:
      st.avgSplitLeg4Done = done;
      break;
    default:
      break;
  }
}

export function setAvgSplitLegTs(st: LiveStagedEntryState, legIndex: AvgSplitLegIndex, ts: number): void {
  switch (legIndex) {
    case 1:
      st.avgFirstLegTs = ts;
      break;
    case 2:
      st.avgSplitLeg2Ts = ts;
      break;
    case 3:
      st.avgSplitLeg3Ts = ts;
      break;
    case 4:
      st.avgSplitLeg4Ts = ts;
      break;
    default:
      break;
  }
}

export function avgSplitLegTsFromState(
  st: LiveStagedEntryState,
  legIndex: AvgSplitLegIndex,
): number | undefined {
  switch (legIndex) {
    case 1:
      return st.avgFirstLegTs;
    case 2:
      return st.avgSplitLeg2Ts;
    case 3:
      return st.avgSplitLeg3Ts;
    case 4:
      return st.avgSplitLeg4Ts;
    default:
      return undefined;
  }
}

export function avgSplitTimedLegIndices(): readonly AvgSplitLegIndex[] {
  return TIMED_AVG_LEG_INDICES;
}

export function cancelAllPendingAvgSplitLegs(st: LiveStagedEntryState): void {
  for (const legIndex of TIMED_AVG_LEG_INDICES) {
    setAvgSplitLegDone(st, legIndex, true);
  }
}

export function avgSplitAllLegsDone(st: LiveStagedEntryState): boolean {
  for (let i = 1; i <= AVG_SPLIT_LEG_COUNT; i++) {
    const legIndex = i as AvgSplitLegIndex;
    const usd = avgSplitLegUsdFromState(st, legIndex);
    if (usd > 0 && !avgSplitLegDoneFromState(st, legIndex)) return false;
  }
  return true;
}
