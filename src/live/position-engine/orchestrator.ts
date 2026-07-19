import type { OpenTrade } from '../../papertrader/types.js';
import type { ChainSnapshot, PositionPhase } from './types.js';
import { snapshotFromOpenTrade } from './adapter.js';
import {
  canExecuteEntryLeg,
  isEntrySplitAcquisitionActive,
  isUpeExitFrozen,
  markLiveUpeExitInFlight,
  onEntryLegConfirmed,
  stampLiveUpePhase,
} from './entry-policy.js';

export interface UpeTickSyncResult {
  phase: PositionPhase;
  exitsFrozen: boolean;
  entryLegsAllowed: boolean;
  entrySplitActive: boolean;
  entrySplitCompleted: number;
  entrySplitPlanned: number;
}

/** Per-mint tick: derive phase from chain + journal, stamp OpenTrade. */
export function syncUpeOnTrackerTick(args: {
  ot: OpenTrade;
  chain: ChainSnapshot;
}): UpeTickSyncResult {
  const snap = snapshotFromOpenTrade({
    ot: args.ot,
    chain: args.chain,
    exitInFlight: args.ot.liveUpeExitInFlight === true,
  });
  stampLiveUpePhase(args.ot, snap.phase);
  return {
    phase: snap.phase,
    exitsFrozen: isUpeExitFrozen(args.ot),
    entryLegsAllowed: canExecuteEntryLeg(args.ot),
    entrySplitActive: isEntrySplitAcquisitionActive(args.ot),
    entrySplitCompleted: snap.entrySplit.completedLegs,
    entrySplitPlanned: snap.entrySplit.plannedLegs,
  };
}

export { onEntryLegConfirmed, markLiveUpeExitInFlight, isUpeExitFrozen, canExecuteEntryLeg };
