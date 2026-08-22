function positive(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function buyCashDeltaUsd(event: Record<string, unknown>): number {
  const before = Number(event.usdcBefore);
  const after = Number(event.usdcAfter);
  if (Number.isFinite(before) && Number.isFinite(after)) return after - before;
  return -(positive(event.quoteSpentUsd) ?? positive(event.sizeUsd) ?? positive(event.amountUsd) ?? 0);
}

export function sellCashDeltaUsd(event: Record<string, unknown>): number {
  const before = Number(event.usdcBefore);
  const after = Number(event.usdcAfter);
  if (Number.isFinite(before) && Number.isFinite(after)) return after - before;
  return positive(event.quoteReceivedUsd) ?? 0;
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
