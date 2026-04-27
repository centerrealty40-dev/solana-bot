import type { SwapEvent } from '../collectors/helius-discovery.js';
import type { LongformWinner } from '../collectors/dex-longform.js';

/**
 * "Long-form alpha" discovery.
 *
 * Premise: a wallet that bought a token EARLY in its life (first ~7 days)
 * with MEANINGFUL size (not snipe-dust), positioned in the post-sniper-batch
 * window (rank ~30-500), and we observe this pattern across MULTIPLE tokens
 * that subsequently became long-form winners (50x+ over weeks) — that wallet
 * has a real edge.
 *
 * Difference from pump-retro:
 *   - Pump-retro looks at the first ~50 buyers of 24h-pumps. This is the
 *     auto-sniper zone. We saw firsthand: 11/11 candidates were bots.
 *   - Long-form skips snipers (rank > 30), requires real money entry
 *     (>= 0.5 SOL), and looks at tokens that survived AND grew over weeks.
 *     Survival itself is a filter: bots dump within hours; conviction
 *     traders remain.
 */

/** One observation: wallet W bought long-form winner T at chronological
 *  rank R within the early window, paying solValue SOL. */
export interface LongformHit {
  wallet: string;
  mint: string;
  /** chronological rank of this wallet's first buy in the early window
   *  (1 = first in window, N = N-th unique buyer). After we skip the sniper
   *  zone the lowest possible rank is `skipFirst + 1`. */
  rank: number;
  ts: number;
  solValue: number;
  amountUsd: number;
}

export interface LongformAlphaWallet {
  wallet: string;
  /** distinct long-form winners this wallet was early in */
  hitCount: number;
  hits: LongformHit[];
  totalSolSpent: number;
  /** average rank across hits; lower = earlier (better) */
  avgRank: number;
  /** composite ranking score */
  score: number;
}

/**
 * Pull early-window buyers for one long-form winner.
 *
 * "Early window" = [pairCreatedAt, pairCreatedAt + earlyWindowDays].
 * Within that window we order by timestamp and assign ranks. Then we DROP
 * the first `skipFirst` (the sniper batch — auto-buyers regardless of merit)
 * and keep up to `topN` ranks from there.
 *
 * `minSolPerBuy` is the dust filter: a real human/fund pays >= 0.3 SOL per
 * entry; bots scatter 0.001-0.05 SOL per snipe across hundreds of tokens.
 */
export function extractLongformEarlyBuyers(
  events: SwapEvent[],
  opts: {
    pairCreatedAt: number;
    earlyWindowDays?: number;
    skipFirst?: number;
    topN?: number;
    minSolPerBuy?: number;
  },
): LongformHit[] {
  const earlyWindowDays = opts.earlyWindowDays ?? 7;
  const skipFirst = opts.skipFirst ?? 30;
  const topN = opts.topN ?? 500;
  const minSolPerBuy = opts.minSolPerBuy ?? 0.3;

  const launchTs = Math.floor(opts.pairCreatedAt / 1000);
  const windowEndTs = launchTs + earlyWindowDays * 86400;

  // Buys in the early window, sorted earliest-first
  const buys = events
    .filter(
      (e) =>
        e.side === 'buy' &&
        e.ts >= launchTs &&
        e.ts <= windowEndTs &&
        e.solValue >= minSolPerBuy,
    )
    .sort((a, b) => a.ts - b.ts);

  // Dedup by wallet — keep the FIRST in-window buy as the canonical entry
  const seen = new Set<string>();
  const ranked: LongformHit[] = [];
  let chronoRank = 0;
  for (const e of buys) {
    if (seen.has(e.wallet)) continue;
    seen.add(e.wallet);
    chronoRank++;
    if (chronoRank <= skipFirst) continue; // sniper zone
    if (ranked.length >= topN) break;
    ranked.push({
      wallet: e.wallet,
      mint: e.baseMint,
      rank: chronoRank,
      ts: e.ts,
      solValue: e.solValue,
      amountUsd: e.amountUsd,
    });
  }
  return ranked;
}

/**
 * Cross-aggregate per-token hits. A wallet that appears across multiple
 * long-form winners has a much stronger signal than any one hit alone.
 *
 * Score combines:
 *   - hit count (cross-token consistency = real edge, not luck)
 *   - rank (lower = earlier in the move = stronger conviction)
 *   - SOL spent (skin in the game)
 */
export function aggregateLongformHits(
  perTokenHits: LongformHit[][],
  opts: { minHits?: number } = {},
): LongformAlphaWallet[] {
  const minHits = opts.minHits ?? 2;
  const byWallet = new Map<string, LongformHit[]>();
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

  const out: LongformAlphaWallet[] = [];
  for (const [wallet, hits] of byWallet) {
    const mints = new Set(hits.map((h) => h.mint));
    if (mints.size < minHits) continue;
    const totalSolSpent = hits.reduce((s, h) => s + h.solValue, 0);
    const avgRank = hits.reduce((s, h) => s + h.rank, 0) / hits.length;
    // Score: cross-token consistency dominates (log scale), rank refines, money kicker
    const rankFactor = 1 / Math.log10(avgRank + 1); // earlier = higher
    const score =
      Math.log10(mints.size + 1) * 30 +
      rankFactor * 20 +
      Math.log10(Math.max(1, totalSolSpent) + 1) * 8;
    out.push({
      wallet,
      hitCount: mints.size,
      hits,
      totalSolSpent,
      avgRank,
      score,
    });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

/**
 * Anti-fleet: collapse near-duplicate wallets that are likely mirrors of
 * the same operator (same hit set + similar rank + similar SOL profile).
 * Keeps the highest-score representative.
 */
export function collapseLongformFleets(wallets: LongformAlphaWallet[]): LongformAlphaWallet[] {
  const buckets = new Map<string, LongformAlphaWallet>();
  for (const w of wallets) {
    const hitBucket = w.hitCount;
    const rankBucket = Math.round(w.avgRank / 30); // 30-rank bins
    const solBucket = Math.round(Math.log10(Math.max(1, w.totalSolSpent)) * 2);
    const mintFp = w.hits.map((h) => h.mint).sort().join(',');
    const fp = `${hitBucket}|${rankBucket}|${solBucket}|${mintFp}`;
    const cur = buckets.get(fp);
    if (!cur || cur.score < w.score) buckets.set(fp, w);
  }
  return Array.from(buckets.values()).sort((a, b) => b.score - a.score);
}

/**
 * Format a compact note for storage in watchlist_wallets.note.
 * Includes hit list with token symbols + rank + SOL spent so reviewers
 * can assess the wallet's signal quickly.
 */
export function formatLongformNote(w: LongformAlphaWallet, winners?: LongformWinner[]): string {
  const sortedHits = [...w.hits].sort((a, b) => a.rank - b.rank);
  const symByMint = new Map(winners?.map((t) => [t.mint, t.symbol]) ?? []);
  const hitDescs = sortedHits.slice(0, 5).map((h) => {
    const sym = symByMint.get(h.mint) ?? h.mint.slice(0, 4);
    return `${sym}#${h.rank}@${h.solValue.toFixed(2)}SOL`;
  });
  const more = sortedHits.length > 5 ? `+${sortedHits.length - 5}` : '';
  return [
    `score=${w.score.toFixed(1)}`,
    `winners=${w.hitCount}`,
    `avgRank=${w.avgRank.toFixed(0)}`,
    `solIn=${w.totalSolSpent.toFixed(2)}`,
    `hits=[${hitDescs.join(',')}${more}]`,
  ].join(' ');
}
