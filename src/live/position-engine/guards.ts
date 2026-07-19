import type {
  EntrySplitProgress,
  ExitGuardDecision,
  ExitGuardRequest,
  PositionEngineConfig,
  PositionPhase,
  PositionSnapshot,
} from './types.js';
import { chainJournalCostRatio, confirmedBuyCostUsd } from './ledger.js';

const ACQUIRING_ALLOWED_EXITS = new Set(['LIQ_DRAIN', 'VOL_COLLAPSE']);

/** Derive lifecycle phase from snapshot facts. */
export function derivePhase(args: {
  entrySplit: EntrySplitProgress;
  exitInFlight: boolean;
  confirmedLegCount: number;
  chainHasTokens: boolean;
}): PositionPhase {
  if (args.exitInFlight) return 'exiting';
  if (!args.chainHasTokens && args.confirmedLegCount === 0) return 'opening';
  if (args.entrySplit.active && !args.entrySplit.allLegsDone) return 'acquiring';
  if (args.confirmedLegCount >= 1 && args.chainHasTokens) return 'managed';
  if (args.confirmedLegCount >= 1) return 'managed';
  return 'opening';
}

/** Whether entry acquisition is still in progress. */
export function isAcquiringPhase(phase: PositionPhase): boolean {
  return phase === 'opening' || phase === 'acquiring';
}

export function defaultPositionEngineConfig(
  overrides?: Partial<PositionEngineConfig>,
): PositionEngineConfig {
  return {
    minChainJournalRatio: 0.55,
    allowLiqDrainDuringAcquire: true,
    enabled: true,
    ...overrides,
  };
}

/**
 * Central exit gate — all full/partial policy exits must pass here.
 * Prevents Ge87-class races: kill during entry split, close on desynced journal.
 */
export function evaluateExitGuard(
  snap: PositionSnapshot,
  cfg: PositionEngineConfig,
  req: ExitGuardRequest,
): ExitGuardDecision {
  if (!cfg.enabled) return { allowed: true };

  if (snap.exitInFlight) {
    return {
      allowed: false,
      invariant: 'UPE-I5',
      reason: 'exit already in flight',
    };
  }

  const reason = req.exitReason.toUpperCase();

  if (isAcquiringPhase(snap.phase)) {
    const safetyOk =
      cfg.allowLiqDrainDuringAcquire &&
      (reason === 'LIQ_DRAIN' || reason === 'VOL_COLLAPSE');
    if (!safetyOk && !ACQUIRING_ALLOWED_EXITS.has(reason)) {
      return {
        allowed: false,
        invariant: 'UPE-I1',
        reason: `exit ${reason} blocked during ${snap.phase} (entry split ${snap.entrySplit.completedLegs}/${snap.entrySplit.plannedLegs})`,
      };
    }
  }

  const isFullExit = !isPartialExitReason(reason);
  const skipDesyncGate =
    (reason === 'LIQ_DRAIN' || reason === 'VOL_COLLAPSE') && cfg.allowLiqDrainDuringAcquire;
  if (isFullExit && !skipDesyncGate && !req.emergencyExit && snap.chain.oscarAttributedUsd > 0) {
    const confirmedCost = confirmedBuyCostUsd(snap.confirmedBuys);
    const ratio = chainJournalCostRatio({
      chain: snap.chain,
      journalInvestedUsd: snap.journalInvestedUsd,
      confirmedCostUsd: confirmedCost,
    });
    if (ratio > 0 && ratio < cfg.minChainJournalRatio) {
      return {
        allowed: false,
        invariant: 'UPE-I2',
        reason: `chain/journal cost ratio ${(ratio * 100).toFixed(1)}% < ${(cfg.minChainJournalRatio * 100).toFixed(0)}% min`,
      };
    }
  }

  return { allowed: true };
}

/** Partial TP / trail rungs — not subject to UPE-I2 full-exit desync gate. */
function isPartialExitReason(reason: string): boolean {
  const r = reason.toUpperCase();
  if (r === 'TP' || r === 'TRAIL' || r === 'TRAIL_STEP') return true;
  if (r.startsWith('WAVE_B') && r.includes('PARTIAL')) return true;
  return false;
}

export function buildEntrySplitProgress(args: {
  active: boolean;
  plannedLegs: number;
  completedLegs: number;
}): EntrySplitProgress {
  return {
    active: args.active,
    plannedLegs: args.plannedLegs,
    completedLegs: args.completedLegs,
    allLegsDone: !args.active || (args.plannedLegs > 0 && args.completedLegs >= args.plannedLegs),
  };
}
