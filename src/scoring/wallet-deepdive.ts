import type { SwapEvent } from '../collectors/helius-discovery.js';

/**
 * Wallet deep-dive scoring.
 *
 * Goal: take a candidate wallet (e.g. from pump-retro discovery) and decide
 * whether it's actually a real trader worth copying — or a one-trick wonder,
 * a buy-and-hold bagholder, or a sniper bot that got lucky on a few pumps.
 *
 * Why we need this: the discovery step finds wallets that were EARLY on
 * pumped tokens. But "early" + "pumped" alone doesn't prove edge. A wallet
 * that bought and never sold is gambling, not trading. A wallet that
 * roundtrips most positions, sells profitably, and has been active for
 * months is a real operator.
 *
 * Methodology — fully on-chain, no USD dependency:
 *   - Group all SWAP events by baseMint -> positions
 *   - Per position: did they sell? if both buy+sell USD known, compute PnL
 *   - Per wallet: aggregate behavior metrics that survive sparse USD data
 *
 * Key signals (USD-independent):
 *   - sellRatio       fraction of swaps that were sells (bots: ~0)
 *   - roundtripRatio  fraction of positions where wallet both bought & sold
 *   - daysActive      first->last activity span (throwaway wallets: < 1d)
 *   - distinctMints   variety (snipers: high; specialists: medium)
 *   - avgHoldSec      median position hold time (scalper / swing / hodler)
 *
 * USD-dependent (only when pricing was available):
 *   - winRate         % of closed positions in profit
 *   - sumPnlUsd       total PnL across closed priced positions
 *   - avgTradeUsd     trade size signal
 */

export interface DeepDiveMetrics {
  wallet: string;
  totalSwaps: number;
  buyCount: number;
  sellCount: number;
  /** sells / (buys + sells); ~0 means buy-only bot/bagholder */
  sellRatio: number;
  /** unique tokens swapped */
  distinctMints: number;
  /** positions with at least one buy AND one sell */
  closedPositions: number;
  /** closedPositions / distinctMints */
  roundtripRatio: number;
  /** earliest -> latest swap span, in days */
  daysActive: number;
  /** median hold time for closed positions (sec), 0 if none */
  medianHoldSec: number;
  /** average buy USD across priced buys; 0 if no pricing */
  avgBuyUsd: number;
  /** count of positions where BOTH buy and sell were priced */
  pricedClosedPositions: number;
  /** % profitable among priced closed positions, 0..1; 0 if none priced */
  winRate: number;
  /** sum of PnL in USD across priced closed positions */
  sumPnlUsd: number;
  /** classification label for human review */
  klass:
    | 'real_trader'
    | 'specialist'
    | 'scalper'
    | 'buy_only'
    | 'sniper_bot'
    | 'throwaway'
    | 'unclassified';
  /** composite quality score for ranking */
  score: number;
}

/** Per-position aggregate (one position = wallet's activity in one mint). */
interface Position {
  mint: string;
  buys: SwapEvent[];
  sells: SwapEvent[];
  firstTs: number;
  lastTs: number;
}

/**
 * Build per-mint positions from a wallet's full swap history.
 */
function groupByMint(events: SwapEvent[]): Position[] {
  const byMint = new Map<string, Position>();
  for (const e of events) {
    let pos = byMint.get(e.baseMint);
    if (!pos) {
      pos = { mint: e.baseMint, buys: [], sells: [], firstTs: e.ts, lastTs: e.ts };
      byMint.set(e.baseMint, pos);
    }
    if (e.side === 'buy') pos.buys.push(e);
    else pos.sells.push(e);
    if (e.ts < pos.firstTs) pos.firstTs = e.ts;
    if (e.ts > pos.lastTs) pos.lastTs = e.ts;
  }
  return Array.from(byMint.values());
}

/**
 * For a single closed position (has both buys and sells), compute PnL in USD.
 * Returns null if either side has zero priced data — we don't want to mix
 * "real loss" with "we don't know the price".
 *
 * Method: simple cost-basis-vs-proceeds (not strictly FIFO since we don't
 * track per-share basis across partial sells; for the typical memecoin
 * "buy in -> sell out" pattern this matches FIFO closely).
 */
function positionPnlUsd(pos: Position): number | null {
  const buyUsd = pos.buys.reduce((s, e) => s + e.amountUsd, 0);
  const sellUsd = pos.sells.reduce((s, e) => s + e.amountUsd, 0);
  if (buyUsd <= 0 || sellUsd <= 0) return null;
  return sellUsd - buyUsd;
}

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1]! + s[mid]!) / 2 : s[mid]!;
}

/**
 * Compute the full set of metrics for one wallet given its swap history.
 */
export function scoreWallet(wallet: string, events: SwapEvent[]): DeepDiveMetrics {
  const positions = groupByMint(events);
  const buyCount = events.filter((e) => e.side === 'buy').length;
  const sellCount = events.filter((e) => e.side === 'sell').length;
  const totalSwaps = events.length;
  const sellRatio = totalSwaps > 0 ? sellCount / totalSwaps : 0;
  const distinctMints = positions.length;
  const closed = positions.filter((p) => p.buys.length > 0 && p.sells.length > 0);
  const closedPositions = closed.length;
  const roundtripRatio = distinctMints > 0 ? closedPositions / distinctMints : 0;

  let daysActive = 0;
  if (events.length >= 2) {
    const tss = events.map((e) => e.ts);
    daysActive = (Math.max(...tss) - Math.min(...tss)) / 86400;
  }

  const holdSecs = closed.map((p) => p.lastTs - p.firstTs);
  const medianHoldSec = median(holdSecs);

  const pricedBuys = events.filter((e) => e.side === 'buy' && e.amountUsd > 0);
  const avgBuyUsd =
    pricedBuys.length > 0 ? pricedBuys.reduce((s, e) => s + e.amountUsd, 0) / pricedBuys.length : 0;

  const pnls: number[] = [];
  for (const p of closed) {
    const pnl = positionPnlUsd(p);
    if (pnl !== null) pnls.push(pnl);
  }
  const pricedClosedPositions = pnls.length;
  const winRate =
    pricedClosedPositions > 0 ? pnls.filter((p) => p > 0).length / pricedClosedPositions : 0;
  const sumPnlUsd = pnls.reduce((s, p) => s + p, 0);

  // Classification — order matters, more specific first
  let klass: DeepDiveMetrics['klass'] = 'unclassified';
  if (totalSwaps < 5 || daysActive < 1) {
    klass = 'throwaway';
  } else if (sellRatio < 0.05) {
    klass = 'buy_only'; // never sells = bot or bagholder
  } else if (
    medianHoldSec > 0 &&
    medianHoldSec < 30 &&
    distinctMints > 50 &&
    sellRatio > 0.3
  ) {
    klass = 'sniper_bot'; // many tokens, ultra-short holds, sells fast
  } else if (roundtripRatio > 0.5 && daysActive > 14 && distinctMints > 10) {
    klass = 'real_trader';
  } else if (distinctMints <= 5 && sellRatio > 0.2 && daysActive > 7) {
    klass = 'specialist'; // few tokens, deep convictions, sells
  } else if (medianHoldSec > 0 && medianHoldSec < 600 && sellRatio > 0.3) {
    klass = 'scalper';
  }

  // Composite score for ranking. Designed so a wallet with no USD data
  // (sumPnlUsd = 0, winRate = 0) still gets credit for behavioral signals.
  let score = 0;
  if (klass === 'real_trader') score += 40;
  else if (klass === 'specialist') score += 25;
  else if (klass === 'scalper') score += 15;
  else if (klass === 'buy_only') score -= 30;
  else if (klass === 'sniper_bot') score -= 40;
  else if (klass === 'throwaway') score -= 50;

  score += Math.min(20, roundtripRatio * 30); // up to +20 for high roundtrip
  score += Math.min(15, daysActive / 4); // up to +15 (60 days = max)
  score += Math.min(10, distinctMints / 5); // variety, up to +10
  if (pricedClosedPositions >= 3) {
    score += (winRate - 0.5) * 30; // -15..+15 around 50% baseline
    if (sumPnlUsd > 0) score += Math.min(15, Math.log10(sumPnlUsd + 1) * 5);
  }

  return {
    wallet,
    totalSwaps,
    buyCount,
    sellCount,
    sellRatio,
    distinctMints,
    closedPositions,
    roundtripRatio,
    daysActive,
    medianHoldSec,
    avgBuyUsd,
    pricedClosedPositions,
    winRate,
    sumPnlUsd,
    klass,
    score,
  };
}

/**
 * Format a compact note string for storage/logging.
 */
export function formatDeepDiveNote(m: DeepDiveMetrics): string {
  const parts: string[] = [
    `class=${m.klass}`,
    `score=${m.score.toFixed(1)}`,
    `swaps=${m.totalSwaps}`,
    `mints=${m.distinctMints}`,
    `sellRatio=${(m.sellRatio * 100).toFixed(0)}%`,
    `roundtrip=${(m.roundtripRatio * 100).toFixed(0)}%`,
    `days=${m.daysActive.toFixed(1)}`,
  ];
  if (m.medianHoldSec > 0) {
    const h = m.medianHoldSec;
    const holdStr =
      h < 60
        ? `${Math.round(h)}s`
        : h < 3600
          ? `${(h / 60).toFixed(0)}m`
          : h < 86400
            ? `${(h / 3600).toFixed(1)}h`
            : `${(h / 86400).toFixed(1)}d`;
    parts.push(`hold=${holdStr}`);
  }
  if (m.pricedClosedPositions >= 3) {
    parts.push(`win=${(m.winRate * 100).toFixed(0)}%`);
    parts.push(`pnl=$${Math.round(m.sumPnlUsd)}`);
  }
  return parts.join(' ');
}

/**
 * Verdict helper: should we keep this wallet on the watchlist?
 */
export function shouldKeep(m: DeepDiveMetrics, opts: { minScore?: number } = {}): boolean {
  const minScore = opts.minScore ?? 30;
  if (m.klass === 'sniper_bot' || m.klass === 'throwaway' || m.klass === 'buy_only') return false;
  return m.score >= minScore;
}
