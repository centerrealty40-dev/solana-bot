/**
 * Live Oscar — режимы выхода A/B (§ IDEALIZED_OSCAR_STACK_SPEC): параметры `PAPER_LIVE_EXIT_MODE_B_*`
 * пока `liveExitProfileMode === 'B'`. Пока режим не назначен или A — используется базовый `cfg` (сетка/kill из `PAPER_*`).
 * После DCA режим **B** сохраняется до закрытия (нет B→A на частичных TP).
 */
import type { PaperTraderConfig } from './config.js';
import type { OpenTrade } from './types.js';
import {
  isWaveBExitPolicy,
  WAVE_B_DEFENSIVE_TRAIL_ARM_PNL_FRAC,
  WAVE_B_V1_TP_GRID,
} from './executor/exit-policy-wave-b.js';

import {
  isScalpWaveExitPolicy,
  scalpWaveEffectiveExitParams,
} from './executor/exit-policy-scalp-wave.js';
import {
  isPresetCScalpExitPolicy,
  presetCScalpEffectiveExitParams,
} from './executor/exit-policy-preset-c-scalp.js';

import {
  isRunnerProbeExitPolicy,
  runnerProbeEffectiveExitParams,
} from './executor/exit-policy-runner-probe.js';
import {
  isFastDipScalpExitPolicy,
  fastDipScalpEffectiveExitParams,
} from './executor/exit-policy-fast-dip-scalp.js';
import {
  isDormantAwakeningExitPolicy,
  dormantAwakeningEffectiveExitParams,
} from './executor/exit-policy-dormant-awakening.js';

export function cfgEffectiveForOpen(cfg: PaperTraderConfig, ot: OpenTrade): PaperTraderConfig {
  if (isDormantAwakeningExitPolicy(ot)) {
    return { ...cfg, ...dormantAwakeningEffectiveExitParams(cfg) };
  }
  if (isFastDipScalpExitPolicy(ot)) {
    return { ...cfg, ...fastDipScalpEffectiveExitParams(cfg) };
  }
  if (isPresetCScalpExitPolicy(ot)) {
    return { ...cfg, ...presetCScalpEffectiveExitParams(cfg) };
  }
  if (isRunnerProbeExitPolicy(ot)) {
    return { ...cfg, ...runnerProbeEffectiveExitParams(cfg) };
  }
  if (isScalpWaveExitPolicy(ot)) {
    return { ...cfg, ...scalpWaveEffectiveExitParams(cfg) };
  }
  if (isWaveBExitPolicy(ot)) {
    return {
      ...cfg,
      trailMode: 'stepped_grid',
      trailTriggerX: 1 + WAVE_B_DEFENSIVE_TRAIL_ARM_PNL_FRAC,
      tpGridStepPnl: WAVE_B_V1_TP_GRID.gridStepPnl,
      tpGridSellFractionByStep: [...WAVE_B_V1_TP_GRID.gridSellFractionByStep],
      tpGridFirstRungRetraceMinPnlPct: WAVE_B_V1_TP_GRID.gridFirstRungRetraceMinPnlPct,
      liveOscarBreakevenTrimAfterFirstTpEnabled: false,
    };
  }
  if (!cfg.liveExitModeAbEnabled || ot.liveExitProfileMode !== 'B') return cfg;
  const p: Partial<PaperTraderConfig> = {};
  if (cfg.liveExitModeBTrailDrop != null) p.trailDrop = cfg.liveExitModeBTrailDrop;
  if (cfg.liveExitModeBTrailTriggerX != null) p.trailTriggerX = cfg.liveExitModeBTrailTriggerX;
  if (cfg.liveExitModeBTimeoutHours != null) p.timeoutHours = cfg.liveExitModeBTimeoutHours;
  if (cfg.liveExitModeBTpGridStepPnl != null) p.tpGridStepPnl = cfg.liveExitModeBTpGridStepPnl;
  if (cfg.liveExitModeBTpGridSellFraction != null) p.tpGridSellFraction = cfg.liveExitModeBTpGridSellFraction;
  if (cfg.liveExitModeBTpGridFirstRungRetraceMinPnlPct != null) {
    p.tpGridFirstRungRetraceMinPnlPct = cfg.liveExitModeBTpGridFirstRungRetraceMinPnlPct;
  }
  if (cfg.liveExitModeBTpGridMaxRungs != null) {
    p.tpGridMaxRungs = Math.floor(cfg.liveExitModeBTpGridMaxRungs);
  }
  if (cfg.liveExitModeBDcaKillstop != null) p.dcaKillstop = cfg.liveExitModeBDcaKillstop;
  if (cfg.liveExitModeBPeakLogStepPct != null) p.peakLogStepPct = cfg.liveExitModeBPeakLogStepPct;
  if (Object.keys(p).length === 0) return cfg;
  return { ...cfg, ...p };
}
