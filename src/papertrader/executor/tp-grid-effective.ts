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
