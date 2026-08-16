export type StagedEntryFirstClip = {
  sizeUsd: number;
  intendedUsd: number | null;
  active: boolean;
};

export function resolveStagedEntryFirstClip(args: {
  enabled: boolean;
  isNewBag: boolean;
  isProbe: boolean;
  isGreen: boolean;
  sizeUsd: number;
  firstUsd: number;
}): StagedEntryFirstClip {
  const active =
    args.enabled &&
    args.isNewBag &&
    !args.isProbe &&
    !args.isGreen &&
    args.sizeUsd > 0 &&
    args.firstUsd > 0;
  return {
    sizeUsd: active ? Math.min(args.sizeUsd, args.firstUsd) : args.sizeUsd,
    intendedUsd: active ? args.sizeUsd : null,
    active,
  };
}

export type StagedEntryAddVerdict = {
  shouldAdd: boolean;
  addUsd: number;
  triggerPx: number | null;
  reason: string;
};

export function evaluateStagedEntryAdd(args: {
  enabled: boolean;
  addDone: boolean;
  attempts: number;
  nowMs: number;
  lastAttemptAtMs?: number;
  markPx: number | null;
  firstFillPx: number | null;
  triggerPct: number;
  maxChasePct: number;
  intendedUsd: number;
  alreadyFilledUsd: number;
  addMult: number;
  addMaxUsd: number;
  liquidityUsd: number | null;
  minLiquidityUsd: number;
  liquidityDrainActive: boolean;
  rugRiskActive: boolean;
}): StagedEntryAddVerdict {
  const triggerPx =
    args.firstFillPx != null && args.firstFillPx > 0
      ? args.firstFillPx * (1 + Math.max(0, args.triggerPct) / 100)
      : null;
  const upperPx =
    triggerPx != null && args.maxChasePct < 100
      ? args.firstFillPx! * (1 + (Math.max(0, args.triggerPct) + Math.max(0, args.maxChasePct)) / 100)
      : null;
  if (!args.enabled) return { shouldAdd: false, addUsd: 0, triggerPx, reason: 'disabled' };
  if (args.addDone) return { shouldAdd: false, addUsd: 0, triggerPx, reason: 'already_added' };
  if (args.attempts >= 3) return { shouldAdd: false, addUsd: 0, triggerPx, reason: 'attempt_limit' };
  if (
    args.lastAttemptAtMs != null &&
    args.nowMs - args.lastAttemptAtMs < 60_000
  ) {
    return { shouldAdd: false, addUsd: 0, triggerPx, reason: 'backoff' };
  }
  if (args.markPx == null || !(args.markPx > 0)) {
    return { shouldAdd: false, addUsd: 0, triggerPx, reason: 'missing_fresh_mark' };
  }
  if (triggerPx == null) {
    return { shouldAdd: false, addUsd: 0, triggerPx, reason: 'missing_first_fill' };
  }
  if (args.markPx < triggerPx) {
    return { shouldAdd: false, addUsd: 0, triggerPx, reason: 'below_trigger' };
  }
  if (upperPx != null && args.markPx > upperPx) {
    return { shouldAdd: false, addUsd: 0, triggerPx, reason: 'above_chase_band' };
  }
  if (args.liquidityUsd == null || args.liquidityUsd < args.minLiquidityUsd) {
    return { shouldAdd: false, addUsd: 0, triggerPx, reason: 'liquidity_below_floor' };
  }
  if (args.liquidityDrainActive) {
    return { shouldAdd: false, addUsd: 0, triggerPx, reason: 'liquidity_drain' };
  }
  if (args.rugRiskActive) {
    return { shouldAdd: false, addUsd: 0, triggerPx, reason: 'rug_risk' };
  }
  const addUsd = Math.min(
    Math.max(0, args.intendedUsd * args.addMult - args.alreadyFilledUsd),
    Math.max(0, args.addMaxUsd),
  );
  if (!(addUsd > 0)) {
    return { shouldAdd: false, addUsd: 0, triggerPx, reason: 'target_filled' };
  }
  return { shouldAdd: true, addUsd, triggerPx, reason: 'triggered' };
}

const STAGED_PROFIT_EXIT_REASONS = new Set(['mfe_bank_sleeve', 'tp_grid']);

export function stagedEntryAverageCostPx(pos: {
  entryPriceUsd: number;
  stagedEntryAvgCostPriceUsd?: number;
  stagedEntryTotalCostUsd?: number;
  stagedEntryTotalTokenAmount?: number;
}): number {
  if (pos.stagedEntryAvgCostPriceUsd != null && pos.stagedEntryAvgCostPriceUsd > 0) {
    return pos.stagedEntryAvgCostPriceUsd;
  }
  if (
    pos.stagedEntryTotalCostUsd != null &&
    pos.stagedEntryTotalTokenAmount != null &&
    pos.stagedEntryTotalCostUsd > 0 &&
    pos.stagedEntryTotalTokenAmount > 0
  ) {
    return pos.stagedEntryTotalCostUsd / pos.stagedEntryTotalTokenAmount;
  }
  return pos.entryPriceUsd;
}

export function evaluateStagedProfitExit(args: {
  reason: string | null;
  exitPx: number;
  avgCostPx: number;
  minOverAvgPct: number;
}): { allow: boolean; thresholdPx: number; reason: string } {
  const thresholdPx = args.avgCostPx * (1 + Math.max(0, args.minOverAvgPct) / 100);
  if (!STAGED_PROFIT_EXIT_REASONS.has(args.reason ?? '')) {
    return { allow: true, thresholdPx, reason: 'protective_or_other' };
  }
  if (args.minOverAvgPct <= 0 || args.exitPx >= thresholdPx) {
    return { allow: true, thresholdPx, reason: 'above_avg_cost' };
  }
  return { allow: false, thresholdPx, reason: 'below_staged_avg_cost' };
}
