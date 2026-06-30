import type { PaperTraderConfig } from '../config.js';
import type { OpenTrade } from '../types.js';
import { isRunnerProbeTrade } from '../live-oscar-runner-probe.js';
import { isLiveOscarTradingStrategyId } from '../../preset-c/live-oscar-family.js';

export function isRunnerProbeExitPolicy(ot: OpenTrade): boolean {
  return ot.liveExitPolicyId === 'runner_probe_v1' || isRunnerProbeTrade(ot);
}

/** One-shot $500 probe: TP +12%, kill −15%, timestop 6h — no DCA. */
export function stampRunnerProbeExitPolicyOnOpen(ot: OpenTrade, cfg: PaperTraderConfig): boolean {
  if (!isLiveOscarTradingStrategyId(cfg.strategyId) || !isRunnerProbeTrade(ot)) return false;
  ot.liveExitPolicyId = 'runner_probe_v1';
  ot.tpGridOverrides = {
    ...ot.tpGridOverrides,
    gridStepPnl: 0,
    dcaKillstop: cfg.runnerProbeKillPct,
  };
  return true;
}

export function runnerProbeEffectiveExitParams(cfg: PaperTraderConfig): Pick<
  PaperTraderConfig,
  'tpX' | 'dcaKillstop' | 'timeoutHours' | 'tpGridStepPnl' | 'trailMode' | 'slX'
> {
  return {
    tpX: 1 + cfg.runnerProbeTpPct,
    dcaKillstop: cfg.runnerProbeKillPct,
    timeoutHours: cfg.runnerProbeTimeStopHours,
    tpGridStepPnl: 0,
    trailMode: 'peak',
    slX: 0,
  };
}
