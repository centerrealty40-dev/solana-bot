import type { PaperTraderConfig } from '../config.js';
import type { OpenTrade } from '../types.js';

/**
 * Per-open overrides for TP grid (regime fork). When `tpGridOverrides` is absent, uses global `cfg`.
 */
export function tpGridEffective(
  ot: OpenTrade,
  cfg: PaperTraderConfig,
): {
  stepPnl: number;
  sellFraction: number;
  maxRungs: number | undefined;
  firstRungRetraceMinPnlPct: number;
} {
  const o = ot.tpGridOverrides;
  /** Режим B live — параметры сетки только из cfg (effCfg), без legacy tp-regime overrides на открытии. */
  const ignoreOverrides = cfg.liveExitModeAbEnabled === true && ot.liveExitProfileMode === 'B';
  return {
    stepPnl: ignoreOverrides ? cfg.tpGridStepPnl : (o?.gridStepPnl ?? cfg.tpGridStepPnl),
    sellFraction: Math.min(
      1,
      ignoreOverrides ? cfg.tpGridSellFraction : (o?.gridSellFraction ?? cfg.tpGridSellFraction),
    ),
    maxRungs: ignoreOverrides ? cfg.tpGridMaxRungs : (o?.gridMaxRungs ?? cfg.tpGridMaxRungs),
    firstRungRetraceMinPnlPct: ignoreOverrides
      ? cfg.tpGridFirstRungRetraceMinPnlPct
      : (o?.gridFirstRungRetraceMinPnlPct ?? cfg.tpGridFirstRungRetraceMinPnlPct),
  };
}

/** DCA killstop for exit/DCA gating: regime override on the open trade, else global config. */
export function dcaKillstopEffective(ot: OpenTrade, cfg: PaperTraderConfig): number {
  const o = ot.tpGridOverrides?.dcaKillstop;
  if (typeof o === 'number' && o < 0) return o;
  return cfg.dcaKillstop;
}
