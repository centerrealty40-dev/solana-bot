import type { WalletAggregate } from '../types.js';
import { computeTrancheRatio } from '../fifo.js';

/**
 * `holding_avg_minutes` — median (per-position) holding time in minutes.
 * We use median, not mean, to avoid being warped by one long-held bag.
 */
export function computeHoldingAvgMinutes(agg: WalletAggregate): number {
  const minutes: number[] = [];
  for (const p of agg.positions.values()) {
    if (p.closedCount === 0) continue;
    minutes.push(p.holdingMinutes / p.closedCount);
  }
  if (minutes.length === 0) return 0;
  minutes.sort((a, b) => a - b);
  const mid = Math.floor(minutes.length / 2);
  return minutes.length % 2 === 0
    ? (minutes[mid - 1]! + minutes[mid]!) / 2
    : minutes[mid]!;
}

/**
 * `sell_in_tranches_ratio` — fraction of closed positions that exited via more
 * than one sell transaction. This is a cheap "skill" indicator: random sniper
 * bots tend to dump in one tx; experienced traders ladder out.
 */
export function computeSellInTranchesRatio(agg: WalletAggregate): number {
  return computeTrancheRatio(agg.swaps);
}
