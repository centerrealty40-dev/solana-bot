import type { PaperTraderConfig } from '../config.js';
import { parseDcaLevels } from '../config.js';
import type { OpenTrade } from '../types.js';
import { isRunnerProbeTrade } from '../live-oscar-runner-probe.js';
import { isLiveOscarTradingStrategyId } from '../../preset-c/live-oscar-family.js';
import { LADDER_PNL_EPS } from './tp-ladder-state.js';

export function isRunnerProbeExitPolicy(ot: OpenTrade): boolean {
  return ot.liveExitPolicyId === 'runner_probe_v1' || isRunnerProbeTrade(ot);
}

/** Negative kill fraction for dcaKillstop / classicKill (e.g. −0.50 for 50% drawdown). */
export function runnerProbeEffectiveKillFrac(cfg: PaperTraderConfig): number {
  return -cfg.runnerProbeKillPct;
}

export function runnerProbeDcaLevelsSpec(cfg: PaperTraderConfig): string {
  return cfg.runnerProbeDcaLevelsSpec;
}

/** Max notional per runner_probe open including DCA legs ($500 + $500 DCA = $1000). */
export function runnerProbeMaxPositionUsd(cfg: PaperTraderConfig): number {
  const levels = parseDcaLevels(cfg.runnerProbeDcaLevelsSpec);
  const dcaMult = levels.reduce((sum, l) => sum + l.addFraction, 0);
  return cfg.runnerProbePositionUsd * (1 + dcaMult);
}

/**
 * Kill uses the worse of Jupiter MTM and PG snapshot so deep PG drawdowns still trigger
 * when Jupiter buy-probe underreports sell-side stress.
 */
export function runnerProbeConservativeKillPx(curMetricUsd: number, snapPxUsd: number): number {
  if (!(curMetricUsd > 0)) return snapPxUsd > 0 ? snapPxUsd : curMetricUsd;
  if (!(snapPxUsd > 0)) return curMetricUsd;
  return Math.min(curMetricUsd, snapPxUsd);
}

/**
 * TP uses the best of tick MTM, PG snapshot, and tracked peak so brief spikes are not missed
 * when Jupiter lags or tick-to-tick clamp undershoots.
 */
export function runnerProbeOptimisticTpPx(
  ot: OpenTrade,
  curMetricUsd: number,
  snapPxUsd: number,
): number {
  let best = curMetricUsd > 0 ? curMetricUsd : 0;
  if (snapPxUsd > best) best = snapPxUsd;
  if (ot.peakMcUsd > best) best = ot.peakMcUsd;
  return best;
}

export function runnerProbeKillEligible(
  ot: OpenTrade,
  curMetricUsd: number,
  snapPxUsd: number,
  cfg: PaperTraderConfig,
): boolean {
  if (!isRunnerProbeExitPolicy(ot) || !(ot.avgEntry > 0)) return false;
  const px = runnerProbeConservativeKillPx(curMetricUsd, snapPxUsd);
  if (!(px > 0)) return false;
  return px / ot.avgEntry - 1 <= runnerProbeEffectiveKillFrac(cfg) + 1e-9;
}

export function runnerProbeTpEligible(
  ot: OpenTrade,
  curMetricUsd: number,
  snapPxUsd: number,
  cfg: PaperTraderConfig,
): boolean {
  if (!isRunnerProbeExitPolicy(ot) || !(ot.avgEntry > 0)) return false;
  const tpX = 1 + cfg.runnerProbeTpPct;
  const px = runnerProbeOptimisticTpPx(ot, curMetricUsd, snapPxUsd);
  if (px > 0 && px / ot.avgEntry + LADDER_PNL_EPS >= tpX) return true;
  if (ot.peakPnlPct + 1e-6 >= cfg.runnerProbeTpPct * 100) return true;
  return false;
}

/** $500 probe + optional DCA: TP +10%, kill −50%, timestop 6h. */
export function stampRunnerProbeExitPolicyOnOpen(ot: OpenTrade, cfg: PaperTraderConfig): boolean {
  if (!isLiveOscarTradingStrategyId(cfg.strategyId) || !isRunnerProbeTrade(ot)) return false;
  ot.liveExitPolicyId = 'runner_probe_v1';
  ot.tpGridOverrides = {
    ...ot.tpGridOverrides,
    gridStepPnl: 0,
    dcaKillstop: runnerProbeEffectiveKillFrac(cfg),
  };
  return true;
}

export function runnerProbeEffectiveExitParams(cfg: PaperTraderConfig): Pick<
  PaperTraderConfig,
  'tpX' | 'dcaKillstop' | 'timeoutHours' | 'tpGridStepPnl' | 'trailMode' | 'slX'
> {
  return {
    tpX: 1 + cfg.runnerProbeTpPct,
    dcaKillstop: runnerProbeEffectiveKillFrac(cfg),
    timeoutHours: cfg.runnerProbeTimeStopHours,
    tpGridStepPnl: 0,
    trailMode: 'peak',
    slX: 0,
  };
}
