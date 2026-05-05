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
  return {
    stepPnl: o?.gridStepPnl ?? cfg.tpGridStepPnl,
    sellFraction: Math.min(1, o?.gridSellFraction ?? cfg.tpGridSellFraction),
    maxRungs: o?.gridMaxRungs,
    firstRungRetraceMinPnlPct: o?.gridFirstRungRetraceMinPnlPct ?? cfg.tpGridFirstRungRetraceMinPnlPct,
  };
}

/** DCA killstop for exit/DCA gating: regime override on the open trade, else global config. */
export function dcaKillstopEffective(ot: OpenTrade, cfg: PaperTraderConfig): number {
  const o = ot.tpGridOverrides?.dcaKillstop;
  if (typeof o === 'number' && o < 0) return o;
  return cfg.dcaKillstop;
}
