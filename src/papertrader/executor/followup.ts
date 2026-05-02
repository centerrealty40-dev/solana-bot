import { fetchLatestSnapshotPrice } from '../pricing.js';
import { appendEvent } from '../store-jsonl.js';
import type { PaperTraderConfig } from '../config.js';
import type { PendingFollowup } from '../types.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const pending: PendingFollowup[] = [];
const completedKeys = new Set<string>();

function fkey(mint: string, entryTs: number, offsetMin: number): string {
  return `${mint}|${entryTs}|${offsetMin}`;
}

export function markFollowupCompleted(mint: string, entryTs: number, offsetMin: number): void {
  completedKeys.add(fkey(mint, entryTs, offsetMin));
}

export function schedulePendingFollowups(
  cfg: PaperTraderConfig,
  args: {
    mint: string;
    symbol: string;
    entryTs: number;
    entryPrice: number;
    entryMarketPrice: number;
    metricType: 'mc' | 'price';
    source?: string;
  },
  offsetsMin: number[],
): void {
  if (!offsetsMin.length) return;
  void cfg;
  for (const offset of offsetsMin) {
    const key = fkey(args.mint, args.entryTs, offset);
    if (completedKeys.has(key)) continue;
    pending.push({
      mint: args.mint,
      symbol: args.symbol,
      entryTs: args.entryTs,
      entryPrice: args.entryPrice,
      entryMarketPrice: args.entryMarketPrice,
      metricType: args.metricType,
      source: args.source,
      offsetMin: offset,
      dueTs: args.entryTs + offset * 60_000,
    });
  }
}

export async function followupTick(): Promise<void> {
  if (!pending.length) return;
  const now = Date.now();
  const due = pending.filter((f) => f.dueTs <= now);
  if (!due.length) return;

  for (const f of due) {
    const idx = pending.indexOf(f);
    if (idx >= 0) pending.splice(idx, 1);
    const key = fkey(f.mint, f.entryTs, f.offsetMin);
    if (completedKeys.has(key)) continue;

    let curMetric = 0;
    try {
      curMetric = Number(
        await fetchLatestSnapshotPrice(
          f.mint,
          f.source as 'raydium' | 'meteora' | 'orca' | 'moonshot' | 'pumpswap' | undefined,
        ) ?? 0,
      );
    } catch (err) {
      console.warn(`followup fetch failed ${f.mint}@+${f.offsetMin}m: ${(err as Error).message}`);
    }
    await sleep(120);

    if (curMetric > 0 && f.entryMarketPrice > 0) {
      const pnlPctVsEntry = (curMetric / f.entryMarketPrice - 1) * 100;
      appendEvent({
        kind: 'followup_snapshot',
        mint: f.mint,
        symbol: f.symbol,
        entryTs: f.entryTs,
        offsetMin: f.offsetMin,
        actual_offset_min: +((Date.now() - f.entryTs) / 60_000).toFixed(2),
        marketPrice: curMetric,
        entryMarketPrice: f.entryMarketPrice,
        pnlPctVsEntry: +pnlPctVsEntry.toFixed(2),
      });
    } else {
      appendEvent({
        kind: 'followup_snapshot',
        mint: f.mint,
        symbol: f.symbol,
        entryTs: f.entryTs,
        offsetMin: f.offsetMin,
        marketPrice: 0,
        error: 'no_data',
      });
    }
    completedKeys.add(key);
  }
}

export function pendingFollowupsCount(): number {
  return pending.length;
}
