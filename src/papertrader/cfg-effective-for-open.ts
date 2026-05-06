/**
 * Live Oscar — режимы выхода A/B (§ IDEALIZED_OSCAR_STACK_SPEC): после первого усреднения
 * подмешиваются параметры из env `PAPER_LIVE_EXIT_MODE_B_*`.
 */
import type { PaperTraderConfig } from './config.js';
import type { OpenTrade } from './types.js';

export function cfgEffectiveForOpen(cfg: PaperTraderConfig, ot: OpenTrade): PaperTraderConfig {
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
