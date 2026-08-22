import fs from 'node:fs';

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

export function replayMirrorTradingCash(journalPath: string): number {
  let text: string;
  try {
    text = fs.readFileSync(journalPath, 'utf8');
  } catch {
    return 0;
  }
  let cash = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      if (event.ok !== true) continue;
      if (event.kind === 'copy_buy') cash += buyCashDeltaUsd(event);
      else if (event.kind === 'copy_sell') cash += sellCashDeltaUsd(event);
    } catch {
      /* Ignore malformed journal rows during backfill. */
    }
  }
  return cash;
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
  const tokens = positive(position.tokenRaw);
  return tokens != null
    ? tokens * mark
    : position.entryPriceUsd > 0
      ? Math.max(0, position.sizeUsd * mark / position.entryPriceUsd)
      : Math.max(0, position.sizeUsd);
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
