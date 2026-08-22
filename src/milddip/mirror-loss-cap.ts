import fs from 'node:fs';

export type MirrorLossCapState = {
  realizedPnlUsd: number;
  backfilled: boolean;
  triggeredAtMs?: number;
  triggeredPnlUsd?: number;
};

type Lot = { costUsd: number; tokens: number };

function finitePositive(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function buyCostUsd(event: Record<string, unknown>): number {
  const before = finitePositive(event.usdcBefore);
  const after = finitePositive(event.usdcAfter);
  if (before != null && after != null && before > after) return before - after;
  return (
    finitePositive(event.quoteSpentUsd) ??
    finitePositive(event.sizeUsd) ??
    finitePositive(event.amountUsd) ??
    0
  );
}

export function buyTokens(event: Record<string, unknown>, costUsd: number): number {
  const raw = finitePositive(event.tokenRaw);
  if (raw != null) return raw;
  const px = finitePositive(event.priceUsd) ?? finitePositive(event.fillPriceUsd);
  return px != null && costUsd > 0 ? costUsd / px : 0;
}

export function sellProceedsUsd(event: Record<string, unknown>): number {
  const before = Number(event.usdcBefore);
  const after = Number(event.usdcAfter);
  if (Number.isFinite(before) && Number.isFinite(after) && after > before) {
    return after - before;
  }
  return finitePositive(event.quoteReceivedUsd) ?? 0;
}

export function sellFraction(event: Record<string, unknown>, _tokens: number): number {
  const before = finitePositive(event.tokenRawBefore);
  const sold = finitePositive(event.tokenRawSold);
  if (before != null && sold != null && sold > 0) {
    return Math.min(1, sold / before);
  }
  const fraction = Number(event.sellFraction ?? event.fraction);
  return Number.isFinite(fraction) && fraction > 0 ? Math.min(1, fraction) : 1;
}

export function replayMirrorRealizedPnl(
  journalPath: string,
): number {
  let text: string;
  try {
    text = fs.readFileSync(journalPath, 'utf8');
  } catch {
    return 0;
  }
  const lots = new Map<string, Lot>();
  let realized = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (event.ok !== true) continue;
    const kind = event.kind;
    const mint = typeof event.mint === 'string' ? event.mint : '';
    if (!mint) continue;
    if (kind === 'copy_buy') {
      const costUsd = buyCostUsd(event);
      const tokens = buyTokens(event, costUsd);
      if (costUsd > 0 && tokens > 0) {
        const lot = lots.get(mint) ?? { costUsd: 0, tokens: 0 };
        lot.costUsd += costUsd;
        lot.tokens += tokens;
        lots.set(mint, lot);
      }
    } else if (kind === 'copy_sell') {
      const lot = lots.get(mint);
      if (!lot || !(lot.tokens > 0)) continue;
      const fraction = sellFraction(event, lot.tokens);
      const cost = lot.costUsd * fraction;
      realized += sellProceedsUsd(event) - cost;
      lot.costUsd = Math.max(0, lot.costUsd - cost);
      lot.tokens = Math.max(0, lot.tokens * (1 - fraction));
      if (lot.tokens <= 1e-9 || fraction >= 1) lots.delete(mint);
    }
  }
  return realized;
}

export function applyMirrorSell(args: {
  costUsd: number;
  tokens: number;
  receivedUsd: number;
  fraction: number;
  tokenRawBefore?: string | null;
  tokenRawSold?: string | null;
}): { realizedPnlUsd: number; remainingCostUsd: number; remainingTokens: number } {
  const before = finitePositive(args.tokenRawBefore);
  const sold = finitePositive(args.tokenRawSold);
  const fraction =
    before != null && sold != null
      ? Math.min(1, sold / before)
      : Math.min(1, Math.max(0, args.fraction));
  const cost = Math.max(0, args.costUsd) * fraction;
  return {
    realizedPnlUsd: Math.max(0, args.receivedUsd) - cost,
    remainingCostUsd: Math.max(0, args.costUsd - cost),
    remainingTokens: Math.max(0, args.tokens * (1 - fraction)),
  };
}
