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
  anchorPx: number | null;
  anchorAtMs: number | null;
  bounceOffAnchorPct: number | null;
  markVsFirstFillPct: number | null;
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
  anchorMode: 'fill' | 'trough';
  troughPx: number | null;
  troughAtMs: number | null;
  triggerPct: number;
  maxChasePct: number;
  troughTriggerPct: number;
  troughBandPct: number;
  minTroughAgeMs: number;
  intendedUsd: number;
  alreadyFilledUsd: number;
  addMult: number;
  addMaxUsd: number;
  liquidityUsd: number | null;
  minLiquidityUsd: number;
  liquidityDrainActive: boolean;
  rugRiskActive: boolean;
}): StagedEntryAddVerdict {
  const fillTriggerPx =
    args.firstFillPx != null && args.firstFillPx > 0
      ? args.firstFillPx * (1 + Math.max(0, args.triggerPct) / 100)
      : null;
  const upperPx =
    args.firstFillPx != null &&
    args.firstFillPx > 0 &&
    args.maxChasePct < 100
      ? args.firstFillPx! * (1 + (Math.max(0, args.triggerPct) + Math.max(0, args.maxChasePct)) / 100)
      : null;
  const anchorPx =
    args.anchorMode === 'trough'
      ? args.troughPx != null && args.troughPx > 0
        ? args.troughPx
        : null
      : args.firstFillPx != null && args.firstFillPx > 0
        ? args.firstFillPx
        : null;
  const anchorAtMs =
    args.anchorMode === 'trough'
      ? args.troughAtMs != null && args.troughAtMs > 0
        ? args.troughAtMs
        : null
      : null;
  const bounceOffAnchorPct =
    args.markPx != null && anchorPx != null && anchorPx > 0
      ? (args.markPx / anchorPx - 1) * 100
      : null;
  const markVsFirstFillPct =
    args.markPx != null && args.firstFillPx != null && args.firstFillPx > 0
      ? (args.markPx / args.firstFillPx - 1) * 100
      : null;
  const triggerPx =
    args.anchorMode === 'trough' && anchorPx != null
      ? anchorPx * (1 + Math.max(0, args.troughTriggerPct) / 100)
      : fillTriggerPx;
  const verdict = (reason: string): StagedEntryAddVerdict => ({
    shouldAdd: false,
    addUsd: 0,
    triggerPx,
    anchorPx,
    anchorAtMs,
    bounceOffAnchorPct,
    markVsFirstFillPct,
    reason,
  });
  if (!args.enabled) return verdict('disabled');
  if (args.addDone) return verdict('already_added');
  if (args.attempts >= 3) return verdict('attempt_limit');
  if (
    args.lastAttemptAtMs != null &&
    args.nowMs - args.lastAttemptAtMs < 60_000
  ) {
    return verdict('backoff');
  }
  if (args.markPx == null || !(args.markPx > 0)) {
    return verdict('missing_fresh_mark');
  }
  if (args.firstFillPx == null || !(args.firstFillPx > 0)) {
    return verdict('missing_first_fill');
  }
  if (args.anchorMode === 'trough') {
    if (anchorPx == null || anchorAtMs == null) {
      return verdict('missing_trough');
    }
    if (bounceOffAnchorPct! < Math.max(0, args.troughTriggerPct)) {
      return verdict('below_trough_trigger');
    }
    if (args.nowMs - anchorAtMs < Math.max(0, args.minTroughAgeMs)) {
      return verdict('trough_too_fresh');
    }
    if (upperPx != null && args.markPx > upperPx) {
      return verdict('above_chase_band');
    }
    if (
      bounceOffAnchorPct! >
      Math.max(0, args.troughTriggerPct) + Math.max(0, args.troughBandPct)
    ) {
      return verdict('above_trough_band');
    }
  } else if (args.markPx < triggerPx!) {
    return verdict('below_trigger');
  }
  if (args.anchorMode !== 'trough' && upperPx != null && args.markPx > upperPx) {
    return verdict('above_chase_band');
  }
  if (args.liquidityUsd == null || args.liquidityUsd < args.minLiquidityUsd) {
    return verdict('liquidity_below_floor');
  }
  if (args.liquidityDrainActive) {
    return verdict('liquidity_drain');
  }
  if (args.rugRiskActive) {
    return verdict('rug_risk');
  }
  const addUsd = Math.min(
    Math.max(0, args.intendedUsd * args.addMult - args.alreadyFilledUsd),
    Math.max(0, args.addMaxUsd),
  );
  if (!(addUsd > 0)) {
    return verdict('target_filled');
  }
  return {
    shouldAdd: true,
    addUsd,
    triggerPx,
    anchorPx,
    anchorAtMs,
    bounceOffAnchorPct,
    markVsFirstFillPct,
    reason: 'triggered',
  };
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
  entryPriceUsd: number;
  stagedAddDone: boolean;
  avgCostPx: number;
  minOverAvgPct: number;
}): { allow: boolean; thresholdPx: number; reason: string } {
  const thresholdPx = args.avgCostPx * (1 + Math.max(0, args.minOverAvgPct) / 100);
  if (!args.stagedAddDone) {
    return { allow: true, thresholdPx, reason: 'no_staged_add' };
  }
  if (
    !STAGED_PROFIT_EXIT_REASONS.has(args.reason ?? '') ||
    args.exitPx <= args.entryPriceUsd
  ) {
    return { allow: true, thresholdPx, reason: 'protective_or_underwater' };
  }
  if (args.minOverAvgPct <= 0 || args.exitPx >= thresholdPx) {
    return { allow: true, thresholdPx, reason: 'above_avg_cost' };
  }
  return { allow: false, thresholdPx, reason: 'below_staged_avg_cost' };
}
