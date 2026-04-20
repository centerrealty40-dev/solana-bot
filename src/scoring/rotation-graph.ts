import type { TransferEvent } from '../collectors/wallet-transfers.js';
import type { SwapEvent } from '../collectors/helius-discovery.js';
import { isExcludedAddress } from '../core/known-addresses.js';

/**
 * One funding edge: SEED wallet → CANDIDATE wallet at time T for amount A.
 */
export interface FundingEdge {
  seed: string;
  candidate: string;
  amountSol: number;
  amountUsd: number;
  ts: number;
  signature: string;
}

/**
 * Per-candidate aggregated funding profile across all observed seeds.
 */
export interface CandidateProfile {
  wallet: string;
  /** distinct seed wallets that funded this candidate */
  funders: string[];
  /** all funding edges to this candidate (sorted by ts ascending) */
  edges: FundingEdge[];
  /** sum of amountSol across edges */
  totalSol: number;
  /** sum of amountUsd across edges */
  totalUsd: number;
  /** earliest funding ts */
  firstFundedTs: number;
  /** latest funding ts */
  lastFundedTs: number;
}

/**
 * Per-candidate behavior profile assembled after the verification step.
 * Optional fields are filled when we have sufficient swap history evidence.
 */
export interface CandidateBehavior {
  /** total swap events seen in our verification window */
  swapCount: number;
  /** distinct base mints traded */
  distinctMints: number;
  /** seconds between firstFundedTs and the first swap (lower = more deliberate) */
  timeToFirstSwapSec: number | null;
  /** total USD swap volume observed */
  totalSwapUsd: number;
  /** ratio of buys to sells (close to 1 = balanced trader; >>1 = accumulator) */
  buySellRatio: number | null;
  /** suspicious patterns detected during verification */
  flags: string[];
}

/**
 * Final ranked rotation candidate.
 */
export interface RotationCandidate {
  wallet: string;
  profile: CandidateProfile;
  behavior: CandidateBehavior | null;
  /** composite quality score; higher = more likely a genuine rotation account */
  score: number;
  /** one-line reason explaining the rank (for debug + DB note) */
  reason: string;
}

/**
 * Build the funder→candidate graph from raw transfer events. We only consider
 * 'out' transfers from each seed (i.e., seed sent value to someone else).
 *
 * Filters:
 *   - skip recipients in EXCLUDED_ADDRESSES (CEX hot wallets, programs)
 *   - skip recipients that are themselves seeds (rotation among the same set
 *     is interesting separately, but for fresh-wallet discovery we want NEW
 *     addresses)
 *   - skip self-transfers (wallet to itself)
 *   - require single edge >= minSolPerEdge (default 0.5 SOL = ~$50-100)
 */
export function buildRotationGraph(
  seedToTransfers: Record<string, TransferEvent[]>,
  opts: {
    minSolPerEdge?: number;
    excludeAdditional?: ReadonlySet<string>;
  } = {},
): { candidates: Map<string, CandidateProfile>; edges: FundingEdge[] } {
  const minSolPerEdge = opts.minSolPerEdge ?? 0.5;
  const seedSet = new Set(Object.keys(seedToTransfers));
  const exclude = opts.excludeAdditional ?? new Set<string>();

  const candidates = new Map<string, CandidateProfile>();
  const edges: FundingEdge[] = [];

  for (const [seed, transfers] of Object.entries(seedToTransfers)) {
    for (const t of transfers) {
      if (t.direction !== 'out') continue;
      if (t.amountSol < minSolPerEdge) continue;
      const cand = t.counterparty;
      if (cand === seed) continue;
      if (seedSet.has(cand)) continue;
      if (isExcludedAddress(cand)) continue;
      if (exclude.has(cand)) continue;

      const edge: FundingEdge = {
        seed,
        candidate: cand,
        amountSol: t.amountSol,
        amountUsd: t.amountUsd,
        ts: t.ts,
        signature: t.signature,
      };
      edges.push(edge);

      let profile = candidates.get(cand);
      if (!profile) {
        profile = {
          wallet: cand,
          funders: [],
          edges: [],
          totalSol: 0,
          totalUsd: 0,
          firstFundedTs: edge.ts,
          lastFundedTs: edge.ts,
        };
        candidates.set(cand, profile);
      }
      profile.edges.push(edge);
      profile.totalSol += edge.amountSol;
      profile.totalUsd += edge.amountUsd;
      if (edge.ts < profile.firstFundedTs) profile.firstFundedTs = edge.ts;
      if (edge.ts > profile.lastFundedTs) profile.lastFundedTs = edge.ts;
      if (!profile.funders.includes(seed)) profile.funders.push(seed);
    }
  }

  // Sort each profile's edges chronologically for downstream analysis
  for (const p of candidates.values()) {
    p.edges.sort((a, b) => a.ts - b.ts);
  }

  return { candidates, edges };
}

/**
 * Heuristic CEX detection: any candidate that is a recipient of more than
 * `fanInCap` distinct seeds is almost certainly a hot wallet (CEX, MM, or
 * onramp), not an alpha rotation account. Real operators rotate across 2-10
 * wallets; receiving funds from 30%+ of our seed pool means it's a public
 * service.
 *
 * Returns the set of candidates to additionally exclude.
 */
export function detectFanInOutliers(
  candidates: Map<string, CandidateProfile>,
  totalSeeds: number,
  fanInCap?: number,
): Set<string> {
  const cap = fanInCap ?? Math.max(15, Math.ceil(totalSeeds * 0.4));
  const flagged = new Set<string>();
  for (const [w, p] of candidates) {
    if (p.funders.length >= cap) flagged.add(w);
  }
  return flagged;
}

/**
 * Score a candidate purely on funding-graph evidence (before verification).
 *
 * Components:
 *   - distinctFunders: dominant signal — multi-seed funding is rare and meaningful
 *   - log(totalSol): more capital = more conviction (logged so single whales don't dominate)
 *   - waveBonus: bonus if funder timestamps cluster within 7 days (operator deploying capital)
 *   - freshnessBonus: bonus if first funding is in the last 90 days (likely fresh rotation)
 *
 * @param now unix-sec; allows reproducible scoring with cached data
 */
export function scoreFundingProfile(
  p: CandidateProfile,
  now = Math.floor(Date.now() / 1000),
): { score: number; reason: string } {
  const distinct = p.funders.length;
  const distinctScore = distinct * 30;

  const totalSol = Math.max(p.totalSol, 0.01);
  const capitalScore = Math.log10(1 + totalSol) * 8;

  // Wave bonus: do all funding edges happen in a tight time window?
  const spreadDays = (p.lastFundedTs - p.firstFundedTs) / 86_400;
  let waveBonus = 0;
  if (distinct >= 2) {
    if (spreadDays <= 1) waveBonus = 12;
    else if (spreadDays <= 7) waveBonus = 7;
    else if (spreadDays <= 30) waveBonus = 3;
  }

  // Freshness: most-recent funding within 90 days = active operation
  const ageDays = (now - p.lastFundedTs) / 86_400;
  let freshBonus = 0;
  if (ageDays <= 30) freshBonus = 6;
  else if (ageDays <= 90) freshBonus = 3;

  const score = distinctScore + capitalScore + waveBonus + freshBonus;
  const reason =
    `${distinct} funders` +
    `, ${totalSol.toFixed(1)} SOL total` +
    (waveBonus > 0 ? `, wave (${spreadDays.toFixed(1)}d)` : '') +
    (freshBonus > 0 ? `, fresh (${ageDays.toFixed(0)}d ago)` : '');
  return { score, reason };
}

/**
 * Compute behavior metrics from a candidate's swap history (verification step).
 * Returns null if the candidate has no swap activity at all (= not a trader,
 * possibly a holding wallet or spam recipient — drop in caller).
 */
export function computeBehavior(
  swaps: SwapEvent[],
  profile: CandidateProfile,
): CandidateBehavior | null {
  if (swaps.length === 0) return null;
  const sortedSwaps = swaps.slice().sort((a, b) => a.ts - b.ts);
  const distinctMints = new Set(sortedSwaps.map((s) => s.baseMint)).size;

  // Time-to-first-swap from first funding event
  const firstSwapTs = sortedSwaps[0]!.ts;
  let timeToFirstSwapSec: number | null = null;
  if (firstSwapTs >= profile.firstFundedTs) {
    timeToFirstSwapSec = firstSwapTs - profile.firstFundedTs;
  }

  const totalSwapUsd = sortedSwaps.reduce((s, sw) => s + sw.amountUsd, 0);
  const buys = sortedSwaps.filter((s) => s.side === 'buy').length;
  const sells = sortedSwaps.filter((s) => s.side === 'sell').length;
  const buySellRatio = sells > 0 ? buys / sells : null;

  const flags: string[] = [];
  if (sortedSwaps.length > 80) flags.push('high_velocity');
  if (sells === 0 && buys >= 5) flags.push('buy_only');
  if (distinctMints === 1 && sortedSwaps.length >= 5) flags.push('single_token');
  // Sub-second clusters are bot signatures
  let clusterCount = 0;
  for (let i = 1; i < sortedSwaps.length; i++) {
    if (sortedSwaps[i]!.ts - sortedSwaps[i - 1]!.ts <= 1) clusterCount++;
  }
  if (clusterCount >= 5) flags.push('bot_clustering');

  return {
    swapCount: sortedSwaps.length,
    distinctMints,
    timeToFirstSwapSec,
    totalSwapUsd,
    buySellRatio,
    flags,
  };
}

/**
 * Combine funding score with behavior metrics into the final rotation score.
 *
 * Behavior modifiers:
 *   - +15 if 2+ distinct mints traded (real trader, not single-token holder)
 *   - +10 if first swap happened within 24h of first funding (deliberate deploy)
 *   - +5  if buySellRatio between 0.7 and 1.5 (balanced, not just accumulation)
 *   - -25 if 'high_velocity' or 'bot_clustering' (bot, not human)
 *   - -15 if 'buy_only' (could be a HODLer not an active rotation)
 *   - drop entirely if totalSwapUsd == 0 AND swapCount > 0 (no priced data,
 *     can't validate — keep but mark)
 */
export function scoreRotationCandidate(
  profile: CandidateProfile,
  behavior: CandidateBehavior | null,
  now = Math.floor(Date.now() / 1000),
): RotationCandidate {
  const { score: baseScore, reason: baseReason } = scoreFundingProfile(profile, now);

  if (!behavior) {
    return {
      wallet: profile.wallet,
      profile,
      behavior,
      score: baseScore * 0.4, // heavy penalty: no swap activity at all
      reason: `${baseReason}; NO swaps (likely passive holder)`,
    };
  }

  let mod = 0;
  const reasonParts: string[] = [];

  if (behavior.distinctMints >= 2) {
    mod += 15;
    reasonParts.push(`${behavior.distinctMints} mints`);
  }
  if (behavior.timeToFirstSwapSec !== null && behavior.timeToFirstSwapSec <= 86_400) {
    mod += 10;
    reasonParts.push(`fast deploy (${Math.round(behavior.timeToFirstSwapSec / 60)}m)`);
  }
  if (behavior.buySellRatio !== null && behavior.buySellRatio >= 0.7 && behavior.buySellRatio <= 1.5) {
    mod += 5;
    reasonParts.push('balanced');
  }
  if (behavior.flags.includes('high_velocity') || behavior.flags.includes('bot_clustering')) {
    mod -= 25;
    reasonParts.push('bot-like');
  }
  if (behavior.flags.includes('buy_only')) {
    mod -= 15;
    reasonParts.push('buy-only');
  }
  if (behavior.flags.includes('single_token')) {
    mod -= 10;
    reasonParts.push('single-token');
  }

  const score = Math.max(0, baseScore + mod);
  const reason = `${baseReason}; ${behavior.swapCount} swaps${reasonParts.length > 0 ? '; ' + reasonParts.join(', ') : ''}`;
  return { wallet: profile.wallet, profile, behavior, score, reason };
}

/**
 * Anti-fleet collapse: when an operator deploys multiple parallel rotation
 * accounts, they often share the same FUNDER SET and are funded within a
 * short time window. Keep only the highest-scoring representative per fleet.
 *
 * Fleet key: sorted-funders + funding-window-bucket (5 minute window).
 */
export function collapseRotationFleets(
  candidates: RotationCandidate[],
  windowSec = 300,
): RotationCandidate[] {
  const byFleet = new Map<string, RotationCandidate>();
  for (const c of candidates) {
    const fundersKey = c.profile.funders.slice().sort().join(',');
    const bucket = Math.floor(c.profile.firstFundedTs / windowSec);
    const key = `${fundersKey}|${bucket}`;
    const existing = byFleet.get(key);
    if (!existing || c.score > existing.score) {
      byFleet.set(key, c);
    }
  }
  return Array.from(byFleet.values()).sort((a, b) => b.score - a.score);
}

/**
 * Build a compact note string for DB storage (text column).
 * Includes the funder shortlist, total capital, key behavior signal.
 */
export function formatRotationNote(c: RotationCandidate): string {
  const funderTags = c.profile.funders
    .slice(0, 3)
    .map((f) => f.slice(0, 4) + '..' + f.slice(-4))
    .join(',');
  const sol = c.profile.totalSol.toFixed(1);
  const score = c.score.toFixed(1);
  const beh = c.behavior;
  const behTag = beh
    ? `${beh.swapCount}sw/${beh.distinctMints}mt/$${Math.round(beh.totalSwapUsd).toLocaleString()}`
    : 'NO_SWAP';
  return `rot s=${score} f=[${funderTags}] cap=${sol}SOL ${behTag}`;
}
