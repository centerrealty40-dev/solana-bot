export type LeaderStyleEntryArgs = {
  enabled: boolean;
  dataAgeMs: number | null;
  minDataAgeMs: number;
  volume5mUsd: number | null;
  liquidityUsd: number | null;
  minVol5mToLiq: number;
  minLiquidityUsd: number;
  maxLiquidityUsd: number;
  currentPriceUsd: number | null;
  localHighUsd: number | null;
  localLowUsd: number | null;
  pullbackPct: number;
};

export type LeaderStyleEntryDecision = {
  pass: boolean;
  reason: string | null;
  turnover: number | null;
  pullbackPct: number | null;
};

export function evaluateLeaderStyleEntry(
  args: LeaderStyleEntryArgs,
): LeaderStyleEntryDecision {
  if (!args.enabled) return { pass: false, reason: 'disabled', turnover: null, pullbackPct: null };
  if (
    args.dataAgeMs == null ||
    !Number.isFinite(args.dataAgeMs) ||
    args.dataAgeMs < args.minDataAgeMs
  ) return { pass: false, reason: 'insufficient_data_age', turnover: null, pullbackPct: null };
  const liq = args.liquidityUsd;
  if (liq == null || !Number.isFinite(liq) || liq < args.minLiquidityUsd) {
    return { pass: false, reason: 'liquidity_below_floor', turnover: null, pullbackPct: null };
  }
  if (args.maxLiquidityUsd > 0 && liq > args.maxLiquidityUsd) {
    return { pass: false, reason: 'liquidity_above_ceiling', turnover: null, pullbackPct: null };
  }
  const turnover =
    args.volume5mUsd != null && Number.isFinite(args.volume5mUsd) && liq > 0
      ? args.volume5mUsd / liq
      : null;
  if (turnover == null || turnover < args.minVol5mToLiq) {
    return { pass: false, reason: 'turnover_below_floor', turnover, pullbackPct: null };
  }
  if (
    args.currentPriceUsd == null ||
    !Number.isFinite(args.currentPriceUsd) ||
    args.currentPriceUsd <= 0 ||
    args.localHighUsd == null ||
    !Number.isFinite(args.localHighUsd) ||
    args.localHighUsd <= 0
  ) return { pass: false, reason: 'no_pullback', turnover, pullbackPct: null };
  const pullbackPct = (1 - args.currentPriceUsd / args.localHighUsd) * 100;
  if (pullbackPct < args.pullbackPct) {
    return { pass: false, reason: 'no_pullback', turnover, pullbackPct };
  }
  if (
    args.localLowUsd != null &&
    Number.isFinite(args.localLowUsd) &&
    args.currentPriceUsd <= args.localLowUsd
  ) return { pass: false, reason: 'at_local_low', turnover, pullbackPct };
  return { pass: true, reason: null, turnover, pullbackPct };
}

export type LeaderStyleExitDecision = {
  shouldExit: boolean;
  reason: 'lstyle_profit_rebound' | 'lstyle_pnl_tp' | 'lstyle_vol_fade' | 'lstyle_depth_drain' | 'lstyle_max_hold' | null;
};

export function evaluateLeaderStyleExit(args: {
  heldMs: number;
  maxHoldMs: number;
  pnlPct: number;
  pnlTpPct: number;
  bounceOffTroughPct: number;
  profitReboundPct: number;
  liqRatio: number | null;
  volumeFade: boolean;
  depthDrainRatio: number | null;
  depthDrainMax: number;
}): LeaderStyleExitDecision {
  if (args.profitReboundPct > 0 && args.bounceOffTroughPct >= args.profitReboundPct && (args.liqRatio ?? 0) >= 1) {
    return { shouldExit: true, reason: 'lstyle_profit_rebound' };
  }
  if (args.pnlTpPct > 0 && args.pnlPct >= args.pnlTpPct) {
    return { shouldExit: true, reason: 'lstyle_pnl_tp' };
  }
  if (args.volumeFade) return { shouldExit: true, reason: 'lstyle_vol_fade' };
  if (args.depthDrainMax > 0 && (args.depthDrainRatio ?? 0) > args.depthDrainMax) {
    return { shouldExit: true, reason: 'lstyle_depth_drain' };
  }
  if (args.maxHoldMs > 0 && args.heldMs >= args.maxHoldMs) {
    return { shouldExit: true, reason: 'lstyle_max_hold' };
  }
  return { shouldExit: false, reason: null };
}
