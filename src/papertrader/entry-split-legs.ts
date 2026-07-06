import type { LiveStagedEntryState } from './types.js';

/** Max timed entry-split legs including open leg-1 (prod: 3×$1000). */
export const ENTRY_SPLIT_LEG_COUNT = 8;

export type EntrySplitLegIndex = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

const TIMED_LEG_INDICES: EntrySplitLegIndex[] = [2, 3, 4, 5, 6, 7, 8];

export function entrySplitLegUsdFromState(st: LiveStagedEntryState, legIndex: EntrySplitLegIndex): number {
  switch (legIndex) {
    case 1:
      return st.entrySplitLegUsd ?? st.firstLegUsd;
    case 2:
      return st.entrySplitLeg2Usd ?? 0;
    case 3:
      return st.entrySplitLeg3Usd ?? 0;
    case 4:
      return st.entrySplitLeg4Usd ?? 0;
    case 5:
      return st.entrySplitLeg5Usd ?? 0;
    case 6:
      return st.entrySplitLeg6Usd ?? 0;
    case 7:
      return st.entrySplitLeg7Usd ?? 0;
    case 8:
      return st.entrySplitLeg8Usd ?? 0;
    default:
      return 0;
  }
}

export function entrySplitLegDoneFromState(st: LiveStagedEntryState, legIndex: EntrySplitLegIndex): boolean {
  switch (legIndex) {
    case 1:
      return true;
    case 2:
      return st.entrySplitLeg2Done === true;
    case 3:
      return st.entrySplitLeg3Done === true;
    case 4:
      return st.entrySplitLeg4Done === true;
    case 5:
      return st.entrySplitLeg5Done === true;
    case 6:
      return st.entrySplitLeg6Done === true;
    case 7:
      return st.entrySplitLeg7Done === true;
    case 8:
      return st.entrySplitLeg8Done === true;
    default:
      return true;
  }
}

export function setEntrySplitLegDone(st: LiveStagedEntryState, legIndex: EntrySplitLegIndex, done: boolean): void {
  switch (legIndex) {
    case 2:
      st.entrySplitLeg2Done = done;
      break;
    case 3:
      st.entrySplitLeg3Done = done;
      break;
    case 4:
      st.entrySplitLeg4Done = done;
      break;
    case 5:
      st.entrySplitLeg5Done = done;
      break;
    case 6:
      st.entrySplitLeg6Done = done;
      break;
    case 7:
      st.entrySplitLeg7Done = done;
      break;
    case 8:
      st.entrySplitLeg8Done = done;
      break;
    default:
      break;
  }
}

export function setEntrySplitLegTs(st: LiveStagedEntryState, legIndex: EntrySplitLegIndex, ts: number): void {
  switch (legIndex) {
    case 2:
      st.entrySplitLeg2Ts = ts;
      break;
    case 3:
      st.entrySplitLeg3Ts = ts;
      break;
    case 4:
      st.entrySplitLeg4Ts = ts;
      break;
    case 5:
      st.entrySplitLeg5Ts = ts;
      break;
    case 6:
      st.entrySplitLeg6Ts = ts;
      break;
    case 7:
      st.entrySplitLeg7Ts = ts;
      break;
    case 8:
      st.entrySplitLeg8Ts = ts;
      break;
    default:
      break;
  }
}

export function entrySplitLegTsFromState(
  st: LiveStagedEntryState,
  legIndex: EntrySplitLegIndex,
): number | undefined {
  switch (legIndex) {
    case 1:
      return st.entrySplitLeg1Ts ?? st.signalTs;
    case 2:
      return st.entrySplitLeg2Ts;
    case 3:
      return st.entrySplitLeg3Ts;
    case 4:
      return st.entrySplitLeg4Ts;
    case 5:
      return st.entrySplitLeg5Ts;
    case 6:
      return st.entrySplitLeg6Ts;
    case 7:
      return st.entrySplitLeg7Ts;
    case 8:
      return st.entrySplitLeg8Ts;
    default:
      return undefined;
  }
}

export function cancelAllPendingEntrySplitLegs(st: LiveStagedEntryState): void {
  for (const legIndex of TIMED_LEG_INDICES) {
    setEntrySplitLegDone(st, legIndex, true);
  }
}

export function entrySplitTimedLegIndices(): readonly EntrySplitLegIndex[] {
  return TIMED_LEG_INDICES;
}

export function entrySplitAllLegsDone(st: LiveStagedEntryState): boolean {
  for (const legIndex of TIMED_LEG_INDICES) {
    const usd = entrySplitLegUsdFromState(st, legIndex);
    if (usd > 0 && !entrySplitLegDoneFromState(st, legIndex)) return false;
  }
  return true;
}
