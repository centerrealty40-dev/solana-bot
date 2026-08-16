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
