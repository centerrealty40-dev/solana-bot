import type { OpenTrade } from '../../papertrader/types.js';
import type { PositionPhase } from './types.js';
import { entrySplitAllLegsDone } from '../../papertrader/entry-split-legs.js';
import { isAcquiringPhase } from './guards.js';

/** True when entry-split v2 plan is active and timed legs remain. */
export function isEntrySplitAcquisitionActive(ot: OpenTrade): boolean {
  const st = ot.liveStagedEntry;
  if (!st?.entrySplitV2) return false;
  return !entrySplitAllLegsDone(st);
}

/** Exits (partial + full) frozen until acquisition completes. */
export function isUpeExitFrozen(ot: OpenTrade): boolean {
  if (ot.liveUpeExitInFlight === true) return true;
  const phase = ot.liveUpePhase;
  if (phase != null && isAcquiringPhase(phase)) return true;
  return isEntrySplitAcquisitionActive(ot);
}

/** Whether a new entry-split / staged-avg buy leg may execute this tick. */
export function canExecuteEntryLeg(ot: OpenTrade): boolean {
  const phase = ot.liveUpePhase;
  if (phase === 'exiting' || phase === 'closed') return false;
  if (ot.liveUpeExitInFlight === true) return false;
  if (ot.remainingFraction <= 0) return false;
  return true;
}

/** Stamp phase on open after chain + staged-entry facts update. */
export function stampLiveUpePhase(ot: OpenTrade, phase: PositionPhase): void {
  ot.liveUpePhase = phase;
}

/** Mark sell pipeline in-flight (blocks duplicate exits — UPE-I5). */
export function markLiveUpeExitInFlight(ot: OpenTrade, inFlight: boolean): void {
  ot.liveUpeExitInFlight = inFlight;
}

/** After confirmed buy leg: refresh phase stamp (caller runs full sync after). */
export function onEntryLegConfirmed(ot: OpenTrade): void {
  if (isEntrySplitAcquisitionActive(ot)) {
    stampLiveUpePhase(ot, 'acquiring');
    return;
  }
  if ((ot.entryLegSignatures?.length ?? 0) > 0 || ot.legs.length > 0) {
    stampLiveUpePhase(ot, 'managed');
  }
}
