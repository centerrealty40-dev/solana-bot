import type { WalletAggregate } from '../types.js';

/**
 * `consistency_score` — 0..1, measures how consistent the wallet's behaviour is across
 * multiple sub-windows. We split the swap history into N equal-size buckets and compare
 * the variance of per-bucket trade count + per-bucket avg notional.
 *
 * High consistency = boring trader who shows up every day with similar size = real human/bot
 * Low consistency = wallet bought/sold once recently = ephemeral / sybil signal
 *
 * Note: this is a heuristic; do not treat as ground truth.
 */
export function computeConsistencyScore(agg: WalletAggregate): number {
  if (agg.swaps.length < 5) return 0;
  const N_BUCKETS = 6;
  const sortedAsc = agg.swaps; // assumed asc by buildWalletAggregate
  const first = sortedAsc[0]!.blockTime.getTime();
  const last = sortedAsc[sortedAsc.length - 1]!.blockTime.getTime();
  const span = Math.max(last - first, 1);
  const bucketSize = span / N_BUCKETS;

  const counts = new Array<number>(N_BUCKETS).fill(0);
  const notionals = Array.from({ length: N_BUCKETS }, () => [] as number[]);
  for (const s of sortedAsc) {
    let idx = Math.floor((s.blockTime.getTime() - first) / bucketSize);
    if (idx >= N_BUCKETS) idx = N_BUCKETS - 1;
    counts[idx] = (counts[idx] ?? 0) + 1;
    notionals[idx]!.push(s.amountUsd);
  }

  const occupiedBuckets = counts.filter((c) => c > 0).length;
  const occupancyScore = occupiedBuckets / N_BUCKETS;

  const meanCount = counts.reduce((a, b) => a + b, 0) / N_BUCKETS;
  const varCount =
    counts.reduce((acc, c) => acc + (c - meanCount) ** 2, 0) / N_BUCKETS;
  const cvCount = meanCount === 0 ? 1 : Math.sqrt(varCount) / meanCount;
  const stabilityScore = 1 / (1 + cvCount);

  return 0.5 * occupancyScore + 0.5 * stabilityScore;
}
