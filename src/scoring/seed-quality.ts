import type { SwapEvent } from '../collectors/helius-discovery.js';

/**
 * Per-wallet aggregated features computed from observed swap events.
 *
 * These are the inputs to the seed-watchlist ranker. The intuition behind
 * each feature is documented in `scoreWallet` below.
 */
export interface WalletFeatures {
  wallet: string;
  /** distinct base mints touched */
  tokenCount: number;
  /** number of swap events observed */
  swapCount: number;
  /** number of buy-side events */
  buyCount: number;
  /** number of sell-side events */
  sellCount: number;
  /** total volume across all swaps in USD */
  volumeUsd: number;
  /** sum of buy-side USD minus sum of sell-side USD (positive = accumulating) */
  netFlowUsd: number;
  /** median seconds between a wallet's consecutive trades (NaN if < 2 trades) */
  medianGapSec: number;
  /** fraction of total volume in the single largest token (0..1, lower = better diversified) */
  topTokenConcentration: number;
}

/**
 * Aggregate raw swap events into per-wallet features.
 *
 * One wallet may appear in many tokens; we keep all of them as one entity here.
 * Cluster dedup happens later (after we know funding sources).
 */
export function aggregateSwapEvents(events: SwapEvent[]): Map<string, WalletFeatures> {
  const byWallet = new Map<string, SwapEvent[]>();
  for (const ev of events) {
    let arr = byWallet.get(ev.wallet);
    if (!arr) {
      arr = [];
      byWallet.set(ev.wallet, arr);
    }
    arr.push(ev);
  }

  const result = new Map<string, WalletFeatures>();
  for (const [wallet, evs] of byWallet) {
    const tokens = new Set(evs.map((e) => e.baseMint));
    let buyCount = 0;
    let sellCount = 0;
    let volumeUsd = 0;
    let buyUsd = 0;
    let sellUsd = 0;
    const perToken = new Map<string, number>();
    for (const e of evs) {
      volumeUsd += e.amountUsd;
      if (e.side === 'buy') {
        buyCount++;
        buyUsd += e.amountUsd;
      } else {
        sellCount++;
        sellUsd += e.amountUsd;
      }
      perToken.set(e.baseMint, (perToken.get(e.baseMint) ?? 0) + e.amountUsd);
    }

    const sortedTs = evs.map((e) => e.ts).sort((a, b) => a - b);
    const gaps: number[] = [];
    for (let i = 1; i < sortedTs.length; i++) gaps.push(sortedTs[i]! - sortedTs[i - 1]!);
    gaps.sort((a, b) => a - b);
    const medianGapSec = gaps.length ? gaps[Math.floor(gaps.length / 2)]! : NaN;

    const topVol = Math.max(0, ...Array.from(perToken.values()));
    const topTokenConcentration = volumeUsd > 0 ? topVol / volumeUsd : 1;

    result.set(wallet, {
      wallet,
      tokenCount: tokens.size,
      swapCount: evs.length,
      buyCount,
      sellCount,
      volumeUsd,
      netFlowUsd: buyUsd - sellUsd,
      medianGapSec,
      topTokenConcentration,
    });
  }
  return result;
}

/**
 * Filtering knobs. Defaults are tuned to keep ~100-300 high-quality candidates
 * out of ~5-10k raw wallets observed across 30-50 trending memecoins.
 *
 * Filter operates in two tiers:
 *   - Multi-token (tokenCount >= minTokens && tokenCount <= maxTokens):
 *     diversification + balance — classic "smart money rotates"
 *   - Specialist (tokenCount == 1 but heavy & balanced activity):
 *     "this trader knows ONE coin really well" — they place bigger bets,
 *     enter/exit cleanly, and may have an info edge on that token
 */
export interface FilterOpts {
  /** minimum distinct tokens for the multi-token tier */
  minTokens?: number;
  /** maximum distinct tokens — drops MEV bots that touch everything */
  maxTokens?: number;
  /** minimum total USD volume (multi-token) */
  minVolumeUsd?: number;
  /** maximum total USD volume — drops AMM proxies / market makers */
  maxVolumeUsd?: number;
  /** minimum swap count (multi-token) */
  minSwaps?: number;
  /** maximum swap count — drops automation that hammers many txs */
  maxSwaps?: number;
  /** minimum median gap seconds — drops sub-second MEV / arb */
  minMedianGapSec?: number;
  /** maximum top-token concentration (0..1) — multi-token tier only */
  maxTopTokenConcentration?: number;
  /** require non-negative net flow (accumulating); when false, allow distributing too */
  requireNetAccumulation?: boolean;
  /** if false, single-token wallets are excluded entirely */
  allowSpecialists?: boolean;
  /** specialist tier: minimum swap count (default 10) */
  minSpecialistSwaps?: number;
  /** specialist tier: minimum USD volume (default 2000) */
  minSpecialistVolumeUsd?: number;
  /** specialist tier: minimum buy/sell balance ratio (0 to 1; 0.2 = at least 20% of trades on opposite side) */
  minSpecialistBalance?: number;
  /** multi-token tier: minimum buy/sell balance — drops "buy-only" bot fleets that pump tokens */
  minMultiTokenBalance?: number;
}

const FILTER_DEFAULTS: Required<FilterOpts> = {
  minTokens: 2,
  maxTokens: 80,
  minVolumeUsd: 500,
  maxVolumeUsd: 5_000_000,
  minSwaps: 4,
  maxSwaps: 1_000,
  minMedianGapSec: 2,
  maxTopTokenConcentration: 0.85,
  requireNetAccumulation: false,
  allowSpecialists: true,
  minSpecialistSwaps: 10,
  minSpecialistVolumeUsd: 2_000,
  minSpecialistBalance: 0.2,
  minMultiTokenBalance: 0.15,
};

/** Counts of why each wallet was rejected. Exposed for diagnostics. */
export interface FilterStats {
  total: number;
  kept: number;
  droppedMaxTokens: number;
  droppedMaxVolume: number;
  droppedMaxSwaps: number;
  droppedMinGap: number;
  droppedNetAccum: number;
  droppedSpecialistDisabled: number;
  droppedSpecialistSwaps: number;
  droppedSpecialistVolume: number;
  droppedSpecialistBalance: number;
  droppedMinTokens: number;
  droppedMinVolume: number;
  droppedMinSwaps: number;
  droppedConcentration: number;
  droppedMultiBalance: number;
}

/**
 * Reject obviously-bad wallets (bots, MMs, dust). Keeps everything else
 * for the ranker to score. Returns both the kept set AND a per-reason
 * tally so callers can see which gate is actually killing candidates.
 */
export function filterWalletsWithStats(
  feats: Iterable<WalletFeatures>,
  opts: FilterOpts = {},
): { kept: WalletFeatures[]; stats: FilterStats } {
  const o = { ...FILTER_DEFAULTS, ...opts };
  const kept: WalletFeatures[] = [];
  const stats: FilterStats = {
    total: 0,
    kept: 0,
    droppedMaxTokens: 0,
    droppedMaxVolume: 0,
    droppedMaxSwaps: 0,
    droppedMinGap: 0,
    droppedNetAccum: 0,
    droppedSpecialistDisabled: 0,
    droppedSpecialistSwaps: 0,
    droppedSpecialistVolume: 0,
    droppedSpecialistBalance: 0,
    droppedMinTokens: 0,
    droppedMinVolume: 0,
    droppedMinSwaps: 0,
    droppedConcentration: 0,
    droppedMultiBalance: 0,
  };

  for (const f of feats) {
    stats.total++;
    if (f.tokenCount > o.maxTokens) {
      stats.droppedMaxTokens++;
      continue;
    }
    if (f.volumeUsd > o.maxVolumeUsd) {
      stats.droppedMaxVolume++;
      continue;
    }
    if (f.swapCount > o.maxSwaps) {
      stats.droppedMaxSwaps++;
      continue;
    }
    if (Number.isFinite(f.medianGapSec) && f.medianGapSec < o.minMedianGapSec) {
      stats.droppedMinGap++;
      continue;
    }
    if (o.requireNetAccumulation && f.netFlowUsd < 0) {
      stats.droppedNetAccum++;
      continue;
    }

    if (f.tokenCount === 1) {
      if (!o.allowSpecialists) {
        stats.droppedSpecialistDisabled++;
        continue;
      }
      if (f.swapCount < o.minSpecialistSwaps) {
        stats.droppedSpecialistSwaps++;
        continue;
      }
      if (f.volumeUsd < o.minSpecialistVolumeUsd) {
        stats.droppedSpecialistVolume++;
        continue;
      }
      const total = f.buyCount + f.sellCount;
      const balance = total > 0 ? Math.min(f.buyCount, f.sellCount) / total : 0;
      if (balance < o.minSpecialistBalance) {
        stats.droppedSpecialistBalance++;
        continue;
      }
      kept.push(f);
      stats.kept++;
    } else {
      if (f.tokenCount < o.minTokens) {
        stats.droppedMinTokens++;
        continue;
      }
      if (f.volumeUsd < o.minVolumeUsd) {
        stats.droppedMinVolume++;
        continue;
      }
      if (f.swapCount < o.minSwaps) {
        stats.droppedMinSwaps++;
        continue;
      }
      if (f.topTokenConcentration > o.maxTopTokenConcentration) {
        stats.droppedConcentration++;
        continue;
      }
      const totalMt = f.buyCount + f.sellCount;
      const balanceMt =
        totalMt > 0 ? Math.min(f.buyCount, f.sellCount) / totalMt : 0;
      if (balanceMt < o.minMultiTokenBalance) {
        stats.droppedMultiBalance++;
        continue;
      }
      kept.push(f);
      stats.kept++;
    }
  }
  return { kept, stats };
}

/**
 * Backwards-compatible wrapper that just returns the kept wallets.
 */
export function filterWallets(
  feats: Iterable<WalletFeatures>,
  opts: FilterOpts = {},
): WalletFeatures[] {
  return filterWalletsWithStats(feats, opts).kept;
}

/**
 * Composite quality score in roughly the [0, 100+] range.
 *
 * Components:
 *   breadth      — log of distinct tokens (rewards diversity, anti-MEV bias)
 *   volume       — log of total USD volume (real money matters, but logged so
 *                  market makers don't dominate)
 *   balance      — closer to 50/50 buys/sells = trader, not dumper
 *   diversification — 1 - top-token concentration
 *   timeQuality  — sigmoid on median gap (rewards 30s..30min, penalizes <5s)
 */
export function scoreWallet(f: WalletFeatures): number {
  const breadth = Math.log10(Math.max(1, f.tokenCount)) * 30; // 0..~50
  const volume = Math.log10(Math.max(1, f.volumeUsd)) * 5; // ~5..35

  const total = f.buyCount + f.sellCount;
  const balance =
    total > 0 ? 1 - Math.abs(f.buyCount - f.sellCount) / total : 0; // 0..1
  const balanceScore = balance * 15;

  const diversification = (1 - f.topTokenConcentration) * 10;

  // sigmoid centered around 60s, saturates by ~600s
  const gap = Number.isFinite(f.medianGapSec) ? f.medianGapSec : 60;
  const timeQuality = (1 / (1 + Math.exp(-(gap - 10) / 30))) * 10;

  return breadth + volume + balanceScore + diversification + timeQuality;
}

/**
 * Convenience: aggregate + filter + score + sort, returning ranked list with score.
 */
export function rankWallets(
  events: SwapEvent[],
  filterOpts: FilterOpts = {},
): Array<WalletFeatures & { score: number }> {
  return rankWalletsWithStats(events, filterOpts).ranked;
}

/**
 * Same as rankWallets, but also returns aggregated features and filter stats
 * so callers can diagnose why so few/many wallets passed.
 */
export function rankWalletsWithStats(
  events: SwapEvent[],
  filterOpts: FilterOpts = {},
): {
  ranked: Array<WalletFeatures & { score: number }>;
  allFeatures: WalletFeatures[];
  stats: FilterStats;
} {
  const agg = aggregateSwapEvents(events);
  const allFeatures = Array.from(agg.values());
  const { kept, stats } = filterWalletsWithStats(allFeatures, filterOpts);
  const ranked = kept
    .map((f) => ({ ...f, score: scoreWallet(f) }))
    .sort((a, b) => b.score - a.score);
  return { ranked, allFeatures, stats };
}
