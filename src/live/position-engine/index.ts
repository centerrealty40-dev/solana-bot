export type {
  PositionPhase,
  ConfirmedBuyLeg,
  ConfirmedSellLeg,
  ChainSnapshot,
  EntrySplitProgress,
  PositionSnapshot,
  ExitGuardDecision,
  ExitGuardRequest,
  PositionEngineConfig,
  ClosePnlResult,
} from './types.js';

export {
  confirmedBuyCostUsd,
  confirmedSellProceedsUsd,
  confirmedRemainingFraction,
  confirmedOpenCostUsd,
  chainJournalCostRatio,
  computeClosePnl,
} from './ledger.js';

export type { ClosePnlInput, ClosePnlOutput } from './ledger.js';

export {
  derivePhase,
  isAcquiringPhase,
  defaultPositionEngineConfig,
  evaluateExitGuard,
  buildEntrySplitProgress,
} from './guards.js';

export {
  snapshotFromOpenTrade,
  confirmedBuysFromOpenTrade,
  confirmedSellsFromOpenTrade,
  countEntrySplitPlannedLegs,
  countEntrySplitCompletedLegs,
} from './adapter.js';

export {
  isEntrySplitAcquisitionActive,
  isUpeExitFrozen,
  canExecuteEntryLeg,
  stampLiveUpePhase,
  markLiveUpeExitInFlight,
  onEntryLegConfirmed,
} from './entry-policy.js';

export {
  evaluateExitIntent,
  createFullExitIntent,
  createPartialExitIntent,
  partialReasonToGuardExitReason,
} from './exit-intent.js';

export type { ExitIntent, ExitIntentKind, ExitIntentDecision } from './exit-intent.js';

export { syncUpeOnTrackerTick } from './orchestrator.js';
export type { UpeTickSyncResult } from './orchestrator.js';

export { loadPositionEngineConfigFromEnv } from './config.js';

export {
  applyUpeClosePnlIfEnabled,
  logUpeExitBlock,
  logUpePartialBlock,
  notifyUpeEntryLegConfirmed,
  syncLiveUpeOnTrackerTick,
  tryBlockLiveExitViaUpe,
  tryBlockPartialSellViaUpe,
} from './tracker-hook.js';
export type { UpeExitBlockResult } from './tracker-hook.js';
