import type { WalletAggregate } from '../types.js';

/**
 * `realized_pnl_30d` — sum of FIFO-realized PnL across all closed lots.
 *
 * The aggregate `wallet.totalRealizedPnlUsd` already contains this — this metric simply
 * exposes it for clarity and is the basis for `winrate_30d`.
 */
export function computeRealizedPnl30d(agg: WalletAggregate): number {
  return agg.totalRealizedPnlUsd;
}

/**
 * `winrate_30d` — fraction of distinct tokens where the wallet ended with positive realized PnL.
 * Tokens with no closed positions are excluded from the denominator.
 */
export function computeWinrate(agg: WalletAggregate): number {
  let denom = 0;
  let wins = 0;
  for (const p of agg.positions.values()) {
    if (p.closedCount === 0) continue;
    denom += 1;
    if (p.realizedPnlUsd > 0) wins += 1;
  }
  return denom === 0 ? 0 : wins / denom;
}

/**
 * `unrealized_pnl` — for every token where some lots remain open, estimate
 * (lastKnownPrice - lotEntryPrice) * remainingAmount. Approximate; only used for
 * ranking, not money decisions.
 */
export function computeUnrealizedPnl(
  agg: WalletAggregate,
  lastKnownPrice: Map<string, number>,
): number {
  let total = 0;
  for (const [mint, p] of agg.positions) {
    const last = lastKnownPrice.get(mint);
    if (!last || last <= 0) continue;
    for (const lot of p.lots) {
      // amount in raw units; we don't know decimals, but the same scale was used to derive priceUsd
      // unrealized USD ≈ (last - entry) * (remainingRaw / origRaw) * usdAtEntry
      // we approximate by using lot.priceUsd as a price baseline and treating raw amounts as proportional:
      // unrealized_per_unit_pct = (last/entry - 1)
      const pct = last / lot.priceUsd - 1;
      // we don't have per-lot USD; use cost portion proportional to remaining raw
      // best we can do without lot.usd: skip if cost too noisy.
      // For a rough rank metric we use pct * (notional baseline = $100)
      total += pct * 100;
    }
  }
  return total;
}
