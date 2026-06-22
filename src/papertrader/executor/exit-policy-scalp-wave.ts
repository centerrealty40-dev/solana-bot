import type { PaperTraderConfig } from '../config.js';
import type { OpenTrade } from '../types.js';
import { isLiveOscarScalpWaveTrade } from '../live-oscar-scalp-wave.js';

export function isScalpWaveExitPolicy(ot: OpenTrade): boolean {
  return ot.liveExitPolicyId === 'scalp_wave_v1' || isLiveOscarScalpWaveTrade(ot);
}

/** Stamp scalp_wave_v1 on open — one-shot $300, TP +10%, no kill (escalation handoff), timestop 3h. */
export function stampScalpWaveExitPolicyOnOpen(ot: OpenTrade, cfg: PaperTraderConfig): boolean {
  if (cfg.strategyId !== 'live-oscar' || !isLiveOscarScalpWaveTrade(ot)) return false;
  ot.liveExitPolicyId = 'scalp_wave_v1';
  ot.tpGridOverrides = {
    ...ot.tpGridOverrides,
    gridStepPnl: 0,
    dcaKillstop: 0,
  };
  return true;
}

/** Effective exit params for tracker / cfgEffectiveForOpen. Kill disabled — deep dip escalates to wave_b. */
export function scalpWaveEffectiveExitParams(cfg: PaperTraderConfig): Pick<
  PaperTraderConfig,
  'tpX' | 'dcaKillstop' | 'timeoutHours' | 'tpGridStepPnl' | 'trailMode' | 'slX'
> {
  return {
    tpX: 1 + cfg.liveOscarScalpWaveTpPct,
    dcaKillstop: 0,
    timeoutHours: cfg.liveOscarScalpWaveTimeStopHours,
    tpGridStepPnl: 0,
    trailMode: 'peak',
    slX: 0,
  };
}
