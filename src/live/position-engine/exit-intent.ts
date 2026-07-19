import type { ExitReason } from '../../papertrader/types.js';
import type { PartialSell } from '../../papertrader/types.js';
import type { ExitGuardRequest, PositionEngineConfig, PositionSnapshot } from './types.js';
import { evaluateExitGuard } from './guards.js';

export type ExitIntentKind = 'partial' | 'full';

export interface ExitIntent {
  kind: ExitIntentKind;
  reason: ExitReason | PartialSell['reason'];
  sellFraction?: number;
  emergency?: boolean;
}

export type ExitIntentDecision =
  | { allowed: true; intent: ExitIntent }
  | {
      allowed: false;
      invariant: 'UPE-I1' | 'UPE-I2' | 'UPE-I5';
      reason: string;
      phase: string;
    };

/** Map partial sell reason to policy exit reason for guard evaluation. */
export function partialReasonToGuardExitReason(reason: PartialSell['reason']): ExitReason {
  switch (reason) {
    case 'KILLSTOP':
    case 'FLASH_CRASH_KILL':
      return 'KILLSTOP';
    case 'SL':
      return 'SL';
    case 'TRAIL':
    case 'TRAIL_STEP':
      return 'TRAIL';
    case 'TIMEOUT':
      return 'TIMEOUT';
    default:
      return 'TP';
  }
}

/** Validate exit intent against position snapshot (single gate for partial + full). */
export function evaluateExitIntent(
  snap: PositionSnapshot,
  cfg: PositionEngineConfig,
  intent: ExitIntent,
): ExitIntentDecision {
  const guardReason =
    intent.kind === 'partial'
      ? partialReasonToGuardExitReason(intent.reason as PartialSell['reason'])
      : (intent.reason as ExitReason);

  const decision = evaluateExitGuard(snap, cfg, {
    exitReason: guardReason,
    emergencyExit: intent.emergency,
  } satisfies ExitGuardRequest);

  if (!decision.allowed) {
    return {
      allowed: false,
      invariant: decision.invariant,
      reason: decision.reason,
      phase: snap.phase,
    };
  }
  return { allowed: true, intent };
}

export function createFullExitIntent(args: {
  reason: ExitReason;
  emergency?: boolean;
}): ExitIntent {
  return { kind: 'full', reason: args.reason, emergency: args.emergency };
}

export function createPartialExitIntent(args: {
  reason: PartialSell['reason'];
  sellFraction: number;
}): ExitIntent {
  return {
    kind: 'partial',
    reason: args.reason,
    sellFraction: args.sellFraction,
  };
}
