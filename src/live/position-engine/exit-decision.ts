/**
 * Phase E — unified full-exit **decision** (policy → ExitReason).
 * Execution (Jupiter sell, journal close) stays in tracker.ts.
 */
import type { PaperTraderConfig, TpLadderLevel } from '../../papertrader/config.js';
import type { ExitReason, OpenTrade } from '../../papertrader/types.js';
import type { LiveOscarConfig } from '../config.js';
import type { TpGridEffective } from '../../papertrader/executor/tp-grid-effective.js';
import { evaluateFlashCrashKill, type FlashCrashKillVerdict } from '../../papertrader/executor/flash-crash-kill.js';
import {
  isVariantAExitPolicy,
  isVariantAHybridExitPolicy,
  isVariantALegacyV1ExitPolicy,
  isVariantAScratchExitPolicy,
  variantAEvalTimedExit,
  variantAMoonExitTriggered,
  variantATrailFullExitTriggered,
  type VariantAExitTag,
} from '../../papertrader/executor/exit-policy-variant-a.js';
import {
  isWaveBExitPolicy,
  waveBAbsoluteKillEligible,
  waveBBreakevenAtZeroExitEligible,
  waveBPreArmNoHalf8PullbackFullExitEligible,
} from '../../papertrader/executor/exit-policy-wave-b.js';
import {
  evaluatePresetCScalpExitAction,
  isPresetCScalpExitPolicy,
  presetCScalpBreakevenExitEligible,
  presetCScalpKillEligible,
} from '../../papertrader/executor/exit-policy-preset-c-scalp.js';
import {
  isRunnerProbeExitPolicy,
  runnerProbeKillEligible,
  runnerProbeTpEligible,
} from '../../papertrader/executor/exit-policy-runner-probe.js';
import { isScalpWaveExitPolicy } from '../../papertrader/executor/exit-policy-scalp-wave.js';
import { liveStagedEntryKillHit } from '../../papertrader/executor/live-staged-entry-gates.js';
import { waveBPostTp1ScratchFullExitDue } from '../../papertrader/executor/wave-b-post-tp1-scratch-reentry.js';
import { ladderRetraceTriggered } from '../../papertrader/executor/tp-ladder-state.js';
import { isLiveOscarTradingStrategyId } from '../../preset-c/live-oscar-family.js';
import { isUpeExitFrozen } from './entry-policy.js';
import {
  journalRemainingUsd,
  shouldForceCloseJournalZeroChainTail,
  WALLET_RECONCILE_REMAINING_EPS,
} from '../wallet-balance-exit-reconcile.js';
import { partialReasonToExitReason } from '../wallet-zero-policy.js';
import { livePolicyOnlyExitsEnabled } from '../policy-only-exits.js';

export type KillstopDebounceLog =
  | { kind: 'signal'; streak: number; pnlPctVsAvg: number; killDropPct: number }
  | { kind: 'replenish'; streak: number; pnlPctVsAvg: number; killEffPct: number; legCount: number };

export interface TrackerFullExitDecisionInput {
  cfg: PaperTraderConfig;
  effCfg: PaperTraderConfig;
  ot: OpenTrade;
  curMetric: number;
  xAvg: number;
  pnlPctVsAvg: number;
  ageH: number;
  tgEff: TpGridEffective;
  killEff: number;
  tpLadder: TpLadderLevel[];
  stagedEntryKillMetricUsd: number;
  snapPx: number;
  pendingTpProtectiveExit: ExitReason | null;
  ghostExitTick: boolean;
  idealizedMute: boolean;
  isPaperOscarIdealized: boolean;
  liveOscarCfg?: LiveOscarConfig;
  chainOscarUsd: number;
  reconcileMinUsd: number;
  flashNowMs: number;
}

export interface TrackerFullExitDecisionResult {
  exitReason: ExitReason | null;
  flashCrash: FlashCrashKillVerdict;
  liveKillstopBelowStreak: number;
  liveVariantAExitTag?: VariantAExitTag;
  liveWavePostTp1ScratchTaken?: boolean;
  suppressedKillDueToGhost?: boolean;
  killstopDebounceLog?: KillstopDebounceLog;
}

function timeoutSuppressedByProgress(ot: OpenTrade): boolean {
  if (isScalpWaveExitPolicy(ot)) return false;
  if (isRunnerProbeExitPolicy(ot)) return false;
  if (ot.partialSells.length > 0) return true;
  return ot.legs.some((l) => l.reason === 'dca');
}

/** Evaluate policy full-exit reason for one tracker tick (Phase E). */
export function evaluateTrackerFullExitDecision(
  input: TrackerFullExitDecisionInput,
): TrackerFullExitDecisionResult {
  const {
    cfg,
    effCfg,
    ot,
    curMetric,
    xAvg,
    pnlPctVsAvg,
    ageH,
    tgEff,
    killEff,
    tpLadder,
    stagedEntryKillMetricUsd,
    snapPx,
    pendingTpProtectiveExit,
    ghostExitTick,
    idealizedMute,
    isPaperOscarIdealized,
    liveOscarCfg,
    chainOscarUsd,
    reconcileMinUsd,
    flashNowMs,
  } = input;

  let exitReason: ExitReason | null = pendingTpProtectiveExit;
  let liveKillstopBelowStreak = ot.liveKillstopBelowStreak ?? 0;
  let liveVariantAExitTag: VariantAExitTag | undefined = ot.liveVariantAExitTag;
  let liveWavePostTp1ScratchTaken = ot.liveWavePostTp1ScratchTaken;
  let suppressedKillDueToGhost = false;
  let killstopDebounceLog: KillstopDebounceLog | undefined;

  let flashCrash: FlashCrashKillVerdict = { kind: 'none' };
  if (
    cfg.flashCrashKillEnabled &&
    isLiveOscarTradingStrategyId(cfg.strategyId) &&
    !livePolicyOnlyExitsEnabled(liveOscarCfg) &&
    ot.avgEntry > 0 &&
    curMetric > 0 &&
    ot.remainingFraction > 1e-6
  ) {
    flashCrash = evaluateFlashCrashKill(cfg, ot, flashNowMs, curMetric, {
      jupiterPx: ot.liveFlashLastJupiterPx,
      snapshotPx: ot.liveFlashLastSnapshotPx,
    });
    if (flashCrash.kind === 'full') {
      exitReason = 'FLASH_CRASH_KILL';
    }
  }

  if (!exitReason && !(isPaperOscarIdealized && idealizedMute)) {
    if (isVariantALegacyV1ExitPolicy(ot) && ot.avgEntry > 0) {
      const pnlFracVa = pnlPctVsAvg / 100;
      if (variantAMoonExitTriggered(ot, effCfg, pnlFracVa)) {
        liveVariantAExitTag = 'moon50';
        exitReason = 'TP';
      } else {
        const timedTag = variantAEvalTimedExit(ot, effCfg, pnlFracVa, ageH);
        if (timedTag) {
          liveVariantAExitTag = timedTag;
          exitReason = 'TIMEOUT';
        } else if (variantATrailFullExitTriggered(ot, effCfg, pnlFracVa)) {
          liveVariantAExitTag = 'trail';
          exitReason = 'TRAIL';
        }
      }
    } else if (isVariantAHybridExitPolicy(ot) && ot.avgEntry > 0) {
      const timedTag = variantAEvalTimedExit(ot, effCfg, pnlPctVsAvg / 100, ageH);
      if (timedTag) {
        liveVariantAExitTag = timedTag;
        exitReason = 'TIMEOUT';
      }
    } else if (isVariantAScratchExitPolicy(ot) && ot.avgEntry > 0) {
      const timedTag = variantAEvalTimedExit(ot, effCfg, pnlPctVsAvg / 100, ageH);
      if (timedTag) {
        liveVariantAExitTag = timedTag;
        exitReason = 'TIMEOUT';
      }
    }

    const upeExitFrozen = liveOscarCfg?.executionMode === 'live' && isUpeExitFrozen(ot);
    const inSignalKillTerritory =
      !upeExitFrozen && liveStagedEntryKillHit(ot, stagedEntryKillMetricUsd);
    const debounceKillAfterReplenish =
      isLiveOscarTradingStrategyId(cfg.strategyId) && ot.legs.length > 1 && !inSignalKillTerritory;

    if (!exitReason && waveBPostTp1ScratchFullExitDue(effCfg, ot, curMetric)) {
      liveWavePostTp1ScratchTaken = true;
      exitReason = 'WAVE_B_POST_TP1_SCRATCH';
    }

    const waveBKill =
      !upeExitFrozen &&
      isWaveBExitPolicy(ot) &&
      killEff < 0 &&
      waveBAbsoluteKillEligible(ot, killEff, curMetric, pnlPctVsAvg / 100);
    const presetCScalpKill = isPresetCScalpExitPolicy(ot) && presetCScalpKillEligible(ot, curMetric);
    const runnerProbeKill =
      isRunnerProbeExitPolicy(ot) && runnerProbeKillEligible(ot, curMetric, snapPx, cfg);
    const classicKill =
      !isWaveBExitPolicy(ot) &&
      !isPresetCScalpExitPolicy(ot) &&
      !isRunnerProbeExitPolicy(ot) &&
      !ot.liveStagedEntry &&
      killEff < 0 &&
      pnlPctVsAvg / 100 <= killEff;
    const inKillTerritory =
      !isVariantAExitPolicy(ot) &&
      (inSignalKillTerritory || waveBKill || presetCScalpKill || runnerProbeKill || classicKill);

    if (inKillTerritory) {
      if (ghostExitTick) {
        liveKillstopBelowStreak = 0;
        suppressedKillDueToGhost = true;
      } else if (waveBKill || presetCScalpKill || runnerProbeKill) {
        liveKillstopBelowStreak = 0;
        exitReason = 'KILLSTOP';
      } else if (inSignalKillTerritory) {
        const nextStreak = liveKillstopBelowStreak + 1;
        liveKillstopBelowStreak = nextStreak;
        if (nextStreak >= 2) exitReason = 'KILLSTOP';
        else {
          killstopDebounceLog = {
            kind: 'signal',
            streak: nextStreak,
            pnlPctVsAvg,
            killDropPct: ot.liveStagedEntry?.killDropPct ?? 0,
          };
        }
      } else if (debounceKillAfterReplenish) {
        const nextStreak = liveKillstopBelowStreak + 1;
        liveKillstopBelowStreak = nextStreak;
        if (nextStreak >= 2) exitReason = 'KILLSTOP';
        else {
          killstopDebounceLog = {
            kind: 'replenish',
            streak: nextStreak,
            pnlPctVsAvg,
            killEffPct: killEff * 100,
            legCount: ot.legs.length,
          };
        }
      } else {
        liveKillstopBelowStreak = 0;
        exitReason = 'KILLSTOP';
      }
    } else {
      liveKillstopBelowStreak = 0;
    }

    if (!exitReason) {
      if (
        isPresetCScalpExitPolicy(ot) &&
        presetCScalpBreakevenExitEligible(ot, curMetric) &&
        (ot.presetCScalpTp5Taken || ot.presetCScalpTp10Taken)
      ) {
        exitReason = 'BREAKEVEN_EXIT';
      } else if (isPresetCScalpExitPolicy(ot)) {
        const scalpFull = evaluatePresetCScalpExitAction(ot, cfg, curMetric);
        if (scalpFull.kind === 'full_exit') exitReason = scalpFull.reason;
      } else if (
        isWaveBExitPolicy(ot) &&
        waveBPreArmNoHalf8PullbackFullExitEligible(ot, effCfg, pnlPctVsAvg / 100) &&
        ot.avgEntry > 0
      ) {
        exitReason = 'BREAKEVEN_EXIT';
      } else if (
        isWaveBExitPolicy(ot) &&
        waveBBreakevenAtZeroExitEligible(ot, tgEff.stepPnl) &&
        ot.avgEntry > 0 &&
        pnlPctVsAvg <= 0
      ) {
        exitReason = 'BREAKEVEN_EXIT';
      } else if (runnerProbeTpEligible(ot, curMetric, snapPx, cfg)) {
        exitReason = 'TP';
      } else if (xAvg >= effCfg.tpX) {
        exitReason = 'TP';
      } else if (effCfg.slX > 0 && xAvg <= effCfg.slX) {
        exitReason = 'SL';
      } else if (
        effCfg.trailMode === 'ladder_retrace' &&
        !isWaveBExitPolicy(ot) &&
        !isVariantAExitPolicy(ot) &&
        ladderRetraceTriggered(
          ot,
          tpLadder,
          xAvg,
          tgEff.stepPnl > 0 ? 'grid' : 'discrete',
          tgEff.firstRungRetraceMinPnlPct,
        )
      ) {
        exitReason = 'TRAIL';
      } else if (
        effCfg.trailMode === 'peak' &&
        ot.trailingArmed &&
        curMetric <= ot.peakMcUsd * (1 - effCfg.trailDrop)
      ) {
        exitReason = 'TRAIL';
      }
    }
  }

  if (
    !exitReason &&
    !isWaveBExitPolicy(ot) &&
    !isVariantAExitPolicy(ot) &&
    !isScalpWaveExitPolicy(ot) &&
    ageH >= effCfg.timeoutHours &&
    !timeoutSuppressedByProgress(ot)
  ) {
    exitReason = 'TIMEOUT';
  }
  if (!exitReason && isScalpWaveExitPolicy(ot) && ageH >= effCfg.timeoutHours) {
    exitReason = 'TIMEOUT';
  }
  if (
    !exitReason &&
    isWaveBExitPolicy(ot) &&
    ot.liveWaveFlatTpMode != null &&
    cfg.liveOscarWaveBTimeStopHours > 0 &&
    ageH >= cfg.liveOscarWaveBTimeStopHours
  ) {
    exitReason = 'TIMEOUT';
  }
  if (
    !exitReason &&
    curMetric > 0 &&
    cfg.liveOscarHardTimeStopHours > 0 &&
    ageH >= cfg.liveOscarHardTimeStopHours
  ) {
    exitReason = 'TIME_STOP';
  }

  if (!exitReason && liveOscarCfg) {
    const journalZero = ot.remainingFraction <= WALLET_RECONCILE_REMAINING_EPS;
    if (
      ot.partialSells.length > 0 &&
      shouldForceCloseJournalZeroChainTail({
        remainingFraction: ot.remainingFraction,
        chainOscarUsd,
        journalRemainingUsd: journalRemainingUsd(ot),
        minUsd: reconcileMinUsd,
        tailFlushThresholdUsd: liveOscarCfg.liveTailFlushThresholdUsd,
        partialSellCount: ot.partialSells.length,
      })
    ) {
      const lastPartial = ot.partialSells[ot.partialSells.length - 1]!;
      exitReason = partialReasonToExitReason(lastPartial.reason);
    } else if (journalZero && !(chainOscarUsd >= reconcileMinUsd)) {
      exitReason = 'TP';
    }
  }

  return {
    exitReason,
    flashCrash,
    liveKillstopBelowStreak,
    ...(liveVariantAExitTag !== ot.liveVariantAExitTag ? { liveVariantAExitTag } : {}),
    ...(liveWavePostTp1ScratchTaken !== ot.liveWavePostTp1ScratchTaken
      ? { liveWavePostTp1ScratchTaken }
      : {}),
    ...(suppressedKillDueToGhost ? { suppressedKillDueToGhost: true } : {}),
    ...(killstopDebounceLog ? { killstopDebounceLog } : {}),
  };
}
