import type { SwapEvent } from '../collectors/helius-discovery.js';
import type { PumpedToken } from '../collectors/dex-pumped.js';

/**
 * "Pump retro" alpha discovery.
 *
 * The premise: a wallet that consistently appears among the EARLIEST buyers
 * of tokens that subsequently pumped has a real information edge — they're
 * either an insider, an exceptional reader of on-chain signals, or a bot
 * with a leading data feed. Either way, we want to know what they buy next.
 *
 * Compare this to volume-based "smart money" lists, which mostly surface
 * the busiest wallets — overwhelmingly bots, MMs and tourists. Here we
 * filter on OUTCOME (the token did pump), then look BACKWARD to find who
 * was positioned for it. That's leading-edge, not lagging.
 */

/**
 * One observation: wallet W bought pumped token T at chronological rank R.
 * "Rank 1" means W was the very first buyer in the deep-history window.
 * Lower rank = earlier = stronger signal.
 */
export interface EarlyBuyerHit {
  wallet: string;
  mint: string;
  /** 1-based chronological rank among buyers in window (1 = earliest seen) */
  rank: number;
  /** unix epoch seconds */
  ts: number;
  /** USD volume of this buy (0 if we couldn't price) */
  amountUsd: number;
}

/**
 * Per-wallet aggregate after cross-tabulating hits across all pumped tokens.
 */
export interface PumpAlphaWallet {
  wallet: string;
  /** distinct pumped tokens this wallet was early in */
  hitCount: number;
  /** detail of each hit (mint, rank, ts, $) */
  hits: EarlyBuyerHit[];
  /** sum of (1 / rank) across hits — earlier ranks weighted more */
  rankScore: number;
  /** sum of buy USD amounts across hits */
  totalBuyUsd: number;
  /** average rank across hits (lower is better) */
  avgRank: number;
  /** composite score combining hits, rank, and money */
  score: number;
}

/**
 * For one pumped token, given its full deep-history swap window, return
 * the chronologically EARLIEST `topN` buyers. Each gets a `rank` based on
 * their position in the buy-time order.
 *
 * Optionally restrict to buys within `[now - lookbackSec, now]` so we look
 * at "early in the move" rather than "earliest of all time" (which would
 * just surface launchpad snipers).
 *
 * Note: for old tokens with deep liquidity, our `pages * 100` window may not
 * reach launch — that's fine, we then capture "early in the recent move",
 * which is exactly the alpha we want.
 */
export function extractEarlyBuyers(
  events: SwapEvent[],
  opts: { topN?: number; lookbackSec?: number; nowSec?: number } = {},
): EarlyBuyerHit[] {
  const topN = opts.topN ?? 50;
  const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000);

  let buys = events.filter((e) => e.side === 'buy');
  if (opts.lookbackSec !== undefined && opts.lookbackSec > 0) {
    const minTs = nowSec - opts.lookbackSec;
    buys = buys.filter((e) => e.ts >= minTs);
  }

  buys.sort((a, b) => a.ts - b.ts); // ascending: earliest first

  // Dedup by wallet — a wallet that re-bought N times shouldn't get N hits
  // for the same token. We keep their FIRST buy as the canonical rank.
  const seen = new Set<string>();
  const dedup: SwapEvent[] = [];
  for (const e of buys) {
    if (seen.has(e.wallet)) continue;
    seen.add(e.wallet);
    dedup.push(e);
    if (dedup.length >= topN) break;
  }

  return dedup.map((e, i) => ({
    wallet: e.wallet,
    mint: e.baseMint,
    rank: i + 1,
    ts: e.ts,
    amountUsd: e.amountUsd,
  }));
}

/**
 * Aggregate per-token hit lists into per-wallet alpha summaries.
 *
 * Filtering & scoring:
 *   - minHits: wallet must be early in at least this many distinct pumped
 *     tokens (default 2 — "1 hit = lucky" rule)
 *   - score = log(hitCount + 1) * 30 + rankScore * 5 + log(totalBuyUsd + 1) * 2
 *     (hit count dominates because cross-token consistency is the core signal;
 *      rank refines tie-breaks; USD size is a small kicker)
 */
export function aggregatePumpHits(
  perTokenHits: EarlyBuyerHit[][],
  opts: { minHits?: number } = {},
): PumpAlphaWallet[] {
  const minHits = opts.minHits ?? 2;
  const byWallet = new Map<string, EarlyBuyerHit[]>();
  for (const tokenHits of perTokenHits) {
    for (const h of tokenHits) {
      let arr = byWallet.get(h.wallet);
      if (!arr) {
        arr = [];
        byWallet.set(h.wallet, arr);
      }
      arr.push(h);
    }
  }

  const out: PumpAlphaWallet[] = [];
  for (const [wallet, hits] of byWallet) {
    // Distinct mints — same wallet can theoretically appear twice if our
    // dedup-by-wallet upstream missed (defensive).
    const mints = new Set(hits.map((h) => h.mint));
    if (mints.size < minHits) continue;
    const rankScore = hits.reduce((s, h) => s + 1 / h.rank, 0);
    const totalBuyUsd = hits.reduce((s, h) => s + h.amountUsd, 0);
    const avgRank = hits.reduce((s, h) => s + h.rank, 0) / hits.length;
    const score =
      Math.log10(mints.size + 1) * 30 +
      rankScore * 5 +
      Math.log10(Math.max(1, totalBuyUsd) + 1) * 2;
    out.push({
      wallet,
      hitCount: mints.size,
      hits,
      rankScore,
      totalBuyUsd,
      avgRank,
      score,
    });
  }

  out.sort((a, b) => b.score - a.score);
  return out;
}

/**
 * Negative-control filter: drop wallets that look like "snipers" — they buy
 * EARLY into many tokens regardless of outcome, just by being fast. Real
 * alpha is selective. Without per-wallet base-rate tracking we approximate:
 *
 *   - if a wallet's avg buy USD is tiny (< minAvgUsd), they're a low-cost
 *     sniper bot (fire-and-forget); drop them
 *   - if a wallet's hits all happen within seconds of each other across
 *     tokens, that's a multi-token sniper batch — drop
 *
 * The strict negative control (cross-check against a random non-pumped basket)
 * is left for v2; this is a cheap heuristic that catches the obvious cases.
 */
export function filterSnipers(
  wallets: PumpAlphaWallet[],
  opts: { minAvgUsd?: number; minSpreadSec?: number } = {},
): PumpAlphaWallet[] {
  return filterSnipersWithStats(wallets, opts).kept;
}

export interface SniperFilterDetail {
  wallet: PumpAlphaWallet;
  reason: 'kept' | 'low_avg_usd' | 'short_spread';
  avgUsd: number;
  spreadSec: number;
}

/**
 * Same as filterSnipers but returns kept + per-wallet detail (avg USD, spread,
 * reason for rejection). Used in the seed script for diagnostics so we can see
 * what the filter is killing and tune accordingly.
 */
export function filterSnipersWithStats(
  wallets: PumpAlphaWallet[],
  opts: { minAvgUsd?: number; minSpreadSec?: number } = {},
): { kept: PumpAlphaWallet[]; details: SniperFilterDetail[] } {
  const minAvgUsd = opts.minAvgUsd ?? 50;
  const minSpreadSec = opts.minSpreadSec ?? 60;
  const kept: PumpAlphaWallet[] = [];
  const details: SniperFilterDetail[] = [];
  for (const w of wallets) {
    const avgUsd = w.totalBuyUsd / w.hitCount;
    const tss = w.hits.map((h) => h.ts).sort((a, b) => a - b);
    const spreadSec = tss[tss.length - 1]! - tss[0]!;
    let reason: SniperFilterDetail['reason'] = 'kept';
    if (avgUsd < minAvgUsd) reason = 'low_avg_usd';
    else if (spreadSec < minSpreadSec) reason = 'short_spread';
    details.push({ wallet: w, reason, avgUsd, spreadSec });
    if (reason === 'kept') kept.push(w);
  }
  return { kept, details };
}

/**
 * Same anti-fleet logic as in seed-quality, adapted for pump-alpha shape.
 * Buckets wallets by feature fingerprint (hitCount, avgRank bucket, rank
 * score bucket) and keeps top-score per bucket — kills the case where one
 * sniper service runs N mirror accounts that all hit the same set of pumps.
 */
export function collapsePumpFleets(wallets: PumpAlphaWallet[]): PumpAlphaWallet[] {
  const buckets = new Map<string, PumpAlphaWallet>();
  for (const w of wallets) {
    const hitBucket = w.hitCount;
    const rankBucket = Math.round(w.avgRank / 5); // 5-rank bins
    const usdBucket = Math.round(Math.log10(Math.max(1, w.totalBuyUsd)) * 2);
    // Hit-set fingerprint: same wallets in same exact tokens = obvious mirrors
    const mintFp = w.hits.map((h) => h.mint).sort().join(',');
    const fp = `${hitBucket}|${rankBucket}|${usdBucket}|${mintFp}`;
    const cur = buckets.get(fp);
    if (!cur || cur.score < w.score) buckets.set(fp, w);
  }
  return Array.from(buckets.values()).sort((a, b) => b.score - a.score);
}

/**
 * Format a compact note for storage in watchlist_wallets.note field.
 * Includes the wallet's full alpha profile so we can query it later.
 */
export function formatPumpNote(w: PumpAlphaWallet, pumped?: PumpedToken[]): string {
  const sortedHits = [...w.hits].sort((a, b) => a.rank - b.rank);
  const symbolByMint = new Map(pumped?.map((p) => [p.mint, p.symbol]) ?? []);
  const hitDescs = sortedHits.slice(0, 5).map((h) => {
    const sym = symbolByMint.get(h.mint) ?? h.mint.slice(0, 4);
    return `${sym}#${h.rank}`;
  });
  const more = sortedHits.length > 5 ? `+${sortedHits.length - 5}` : '';
  return [
    `score=${w.score.toFixed(1)}`,
    `pumps=${w.hitCount}`,
    `avgRank=${w.avgRank.toFixed(1)}`,
    `buy=$${Math.round(w.totalBuyUsd)}`,
    `hits=[${hitDescs.join(',')}${more}]`,
  ].join(' ');
}
