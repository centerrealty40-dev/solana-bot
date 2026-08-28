function positive(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function buyCashDeltaUsd(event: Record<string, unknown>): number {
  const confirmed = Number(event.cashDeltaUsd);
  if (Number.isFinite(confirmed)) return confirmed;
  const quoteSpentUsd = positive(event.quoteSpentUsd);
  if (quoteSpentUsd != null) return -quoteSpentUsd;
  const before = Number(event.usdcBefore);
  const after = Number(event.usdcAfter);
  if (Number.isFinite(before) && Number.isFinite(after)) return after - before;
  return -(positive(event.sizeUsd) ?? positive(event.amountUsd) ?? 0);
}

export function sellCashDeltaUsd(event: Record<string, unknown>): number {
  const confirmed = Number(event.cashDeltaUsd);
  if (Number.isFinite(confirmed)) return confirmed;
  const quoteReceivedUsd = positive(event.quoteReceivedUsd);
  if (quoteReceivedUsd != null) return quoteReceivedUsd;
  const before = Number(event.usdcBefore);
  const after = Number(event.usdcAfter);
  if (Number.isFinite(before) && Number.isFinite(after)) return after - before;
  return positive(event.sizeUsd) ?? positive(event.amountUsd) ?? 0;
}

export function mirrorOpenMarkValueUsd(
  position: {
    sizeUsd: number;
    entryPriceUsd: number;
    tokenRaw?: string | null;
    lastMarkPriceUsd?: number;
  },
  markPriceUsd?: number | null,
): number {
  const mark = positive(markPriceUsd) ?? positive(position.lastMarkPriceUsd);
  if (mark == null) return Math.max(0, position.sizeUsd);
  return position.entryPriceUsd > 0
    ? Math.max(0, position.sizeUsd * mark / position.entryPriceUsd)
    : Math.max(0, position.sizeUsd);
}

export function accountMirrorCashLeg(
  target: { mirrorTradingCashUsd?: number },
  event: Record<string, unknown>,
  side: 'buy' | 'sell',
): number {
  const delta = side === 'buy' ? buyCashDeltaUsd(event) : sellCashDeltaUsd(event);
  target.mirrorTradingCashUsd = (target.mirrorTradingCashUsd ?? 0) + delta;
  return delta;
}

export type MirrorLossCapBaselineState = {
  mirrorTradingCashUsd?: number;
  mirrorLossCapDayKey?: string;
  mirrorLossCapBaselineAtMs?: number;
  mirrorLossCapBaselineUsd?: number;
  mirrorLossCapTriggeredAtMs?: number;
  mirrorLossCapTriggeredPnlUsd?: number;
  mirrorLossCapPendingDrawdownUsd?: number;
  mirrorLossCapPendingAtMs?: number;
};

export function mirrorLossCapDayKey(
  nowMs: number,
  tzOffsetMinutes: number,
): string {
  return new Date(nowMs + tzOffsetMinutes * 60_000).toISOString().slice(0, 10);
}

export function maybeResetMirrorLossCapDay(args: {
  state: MirrorLossCapBaselineState & { mirrorLossCapDayKey?: string };
  lossCapUsd: number;
  bagsUsd: number;
  nowMs: number;
  tzOffsetMinutes: number;
  enabled: boolean;
}): { reset: boolean; previousDayKey: string | null; dayKey: string } {
  const dayKey = mirrorLossCapDayKey(args.nowMs, args.tzOffsetMinutes);
  const previousDayKey = args.state.mirrorLossCapDayKey ?? null;
  if (!args.enabled || args.lossCapUsd <= 0) {
    return { reset: false, previousDayKey, dayKey };
  }
  if (previousDayKey == null) {
    args.state.mirrorLossCapDayKey = dayKey;
    return { reset: false, previousDayKey, dayKey };
  }
  if (previousDayKey === dayKey) {
    return { reset: false, previousDayKey, dayKey };
  }
  args.state.mirrorTradingCashUsd = -args.bagsUsd;
  args.state.mirrorLossCapBaselineAtMs = args.nowMs;
  args.state.mirrorLossCapBaselineUsd = args.lossCapUsd;
  args.state.mirrorLossCapTriggeredAtMs = undefined;
  args.state.mirrorLossCapTriggeredPnlUsd = undefined;
  args.state.mirrorLossCapPendingDrawdownUsd = undefined;
  args.state.mirrorLossCapPendingAtMs = undefined;
  args.state.mirrorLossCapDayKey = dayKey;
  return { reset: true, previousDayKey, dayKey };
}

export function syncMirrorLossCapBaseline(args: {
  state: MirrorLossCapBaselineState;
  lossCapUsd: number;
  bagsUsd: number;
  nowMs: number;
}): {
  changed: boolean;
  reason: 'initial' | 'unknown_threshold' | 'threshold_changed' | 'disabled' | null;
  previousLossCapUsd: number | null;
} {
  const { state, lossCapUsd, bagsUsd, nowMs } = args;
  const previousLossCapUsd = Number.isFinite(state.mirrorLossCapBaselineUsd)
    ? state.mirrorLossCapBaselineUsd!
    : null;
  if (lossCapUsd <= 0) {
    const changed =
      state.mirrorLossCapBaselineAtMs != null ||
      state.mirrorLossCapBaselineUsd != null ||
      state.mirrorLossCapTriggeredAtMs != null ||
      state.mirrorLossCapTriggeredPnlUsd != null ||
      state.mirrorLossCapPendingDrawdownUsd != null ||
      state.mirrorLossCapPendingAtMs != null;
    state.mirrorLossCapBaselineAtMs = undefined;
    state.mirrorLossCapBaselineUsd = undefined;
    state.mirrorLossCapTriggeredAtMs = undefined;
    state.mirrorLossCapTriggeredPnlUsd = undefined;
    state.mirrorLossCapPendingDrawdownUsd = undefined;
    state.mirrorLossCapPendingAtMs = undefined;
    return {
      changed,
      reason: changed ? 'disabled' : null,
      previousLossCapUsd,
    };
  }
  const hasBaseline = state.mirrorLossCapBaselineAtMs != null;
  const thresholdMatches = previousLossCapUsd === lossCapUsd;
  if (hasBaseline && thresholdMatches) {
    return { changed: false, reason: null, previousLossCapUsd };
  }
  state.mirrorTradingCashUsd = -bagsUsd;
  state.mirrorLossCapBaselineAtMs = nowMs;
  state.mirrorLossCapBaselineUsd = lossCapUsd;
  state.mirrorLossCapTriggeredAtMs = undefined;
  state.mirrorLossCapTriggeredPnlUsd = undefined;
  state.mirrorLossCapPendingDrawdownUsd = undefined;
  state.mirrorLossCapPendingAtMs = undefined;
  return {
    changed: true,
    reason: !hasBaseline
      ? 'initial'
      : previousLossCapUsd == null
        ? 'unknown_threshold'
        : 'threshold_changed',
    previousLossCapUsd,
  };
}

export function confirmLossCapObservation(args: {
  drawdownUsd: number;
  capUsd: number;
  pendingDrawdownUsd?: number;
  pendingAtMs?: number;
  nowMs: number;
}): { confirmed: boolean; pendingDrawdownUsd?: number; pendingAtMs?: number } {
  if (args.capUsd <= 0 || args.drawdownUsd > -args.capUsd) {
    return { confirmed: false };
  }
  if (
    args.pendingAtMs != null &&
    args.nowMs > args.pendingAtMs &&
    (args.pendingDrawdownUsd ?? 0) <= -args.capUsd
  ) {
    return { confirmed: true };
  }
  return {
    confirmed: false,
    pendingDrawdownUsd: args.drawdownUsd,
    pendingAtMs: args.nowMs,
  };
}
