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
  /** unix-sec of the FIRST swap by this wallet in the verification window */
  firstSwapTs: number;
  /** unix-sec of the MOST RECENT swap (critical for staleness check — a wallet
   * with 30 swaps from 6 months ago is NOT an active trader) */
  lastSwapTs: number;
  /** seconds between firstFundedTs and the first swap (lower = more deliberate) */
  timeToFirstSwapSec: number | null;
  /** total USD swap volume observed */
  totalSwapUsd: number;
  /** ratio of buys to sells (close to 1 = balanced trader; >>1 = accumulator) */
  buySellRatio: number | null;
  /** number of buys */
  buyCount: number;
  /** number of sells */
  sellCount: number;
  /** average USD per buy (excluding 0-priced events) — critical for retail-noise detection */
  avgBuyUsd: number;
  /** median USD per buy — more robust than average for skewed distributions */
  medianBuyUsd: number;
  /** behavior class: OP-SOURCE / BUY-HEAVY / BALANCED / SELL-HEAVY / RETAIL-MICRO / UNCLASSIFIED */
  behaviorClass: BehaviorClass;
  /** suspicious patterns detected during verification */
  flags: string[];
}

/**
 * High-level behavior classification used for filtering and scoring.
 *   MEMECOIN-OP   — micro buys ($5-$30 avg) BUT high activity + multi-mint
 *                   + buy-heavy. The "micro-sniper" operator pattern: small
 *                   targeted entries into fresh memecoins, then transferred
 *                   to a sell-wallet. Critical signal — these wallets look
 *                   like noise by size alone but ARE alpha.
 *   OP-SOURCE     — buy-heavy + multi-mint + larger sizes ($50+ avg):
 *                   classic buy-leg of a multi-wallet operator (purchases
 *                   accumulate here, then transferred to a sell-wallet).
 *   BUY-HEAVY     — mostly buys but few mints / mid sizes
 *   BALANCED      — normal trader doing both buys and sells
 *   SELL-HEAVY    — mostly sells (the offload wallet of an operator,
 *                   useful for exit timing)
 *   RETAIL-MICRO  — small avg AND low conviction (<5 buys, <2 mints)
 *                   — manual dust trader with no operator pattern
 *   UNCLASSIFIED  — too few priced events to decide
 */
export type BehaviorClass =
  | 'MEMECOIN-OP'
  | 'OP-SOURCE'
  | 'BUY-HEAVY'
  | 'BALANCED'
  | 'SELL-HEAVY'
  | 'RETAIL-MICRO'
  | 'UNCLASSIFIED';

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
 * A parent operator: an external wallet that funded 2+ of our seeds. Strong
 * signal that all those seeds are themselves rotation accounts of one human.
 *
 * Knowing a parent gives us two new discovery surfaces:
 *   1. The parent itself is a high-value watchlist target (the human's "treasury")
 *   2. The parent's OTHER outgoing transfers (siblings) are likely additional
 *      rotation accounts of the same operator we don't know about yet
 */
export interface ParentOperator {
  wallet: string;
  /** distinct seeds this parent funded */
  children: string[];
  /** all funding edges from parent to children, sorted by ts ascending */
  edges: FundingEdge[];
  /** sum of amountSol across edges */
  totalSol: number;
  /** sum of amountUsd across edges */
  totalUsd: number;
  /** earliest funding ts across children */
  firstFundedTs: number;
  /** latest funding ts across children */
  lastFundedTs: number;
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
 * Build the parent→seed graph by inspecting INCOMING transfers. Mirror of
 * buildRotationGraph but on the 'in' direction: who funded our seed wallets?
 *
 * A "parent operator" is any external wallet that funded 2+ of our seeds —
 * meaning the seeds themselves are likely rotation accounts of one human, and
 * the parent is the human's primary wallet (treasury). Discovering parents
 * effectively lets us climb one level up the rotation tree.
 *
 * Same exclusion rules as buildRotationGraph apply (CEX, programs, self).
 */
export function buildIncomingGraph(
  seedToTransfers: Record<string, TransferEvent[]>,
  opts: {
    minSolPerEdge?: number;
    excludeAdditional?: ReadonlySet<string>;
  } = {},
): Map<string, ParentOperator> {
  const minSolPerEdge = opts.minSolPerEdge ?? 0.5;
  const seedSet = new Set(Object.keys(seedToTransfers));
  const exclude = opts.excludeAdditional ?? new Set<string>();

  const parents = new Map<string, ParentOperator>();

  for (const [seed, transfers] of Object.entries(seedToTransfers)) {
    for (const t of transfers) {
      if (t.direction !== 'in') continue;
      if (t.amountSol < minSolPerEdge) continue;
      const funder = t.counterparty;
      if (funder === seed) continue;
      if (seedSet.has(funder)) continue; // intra-seed transfers tracked elsewhere
      if (isExcludedAddress(funder)) continue;
      if (exclude.has(funder)) continue;

      const edge: FundingEdge = {
        seed: funder, // parent is the funder
        candidate: seed,
        amountSol: t.amountSol,
        amountUsd: t.amountUsd,
        ts: t.ts,
        signature: t.signature,
      };

      let parent = parents.get(funder);
      if (!parent) {
        parent = {
          wallet: funder,
          children: [],
          edges: [],
          totalSol: 0,
          totalUsd: 0,
          firstFundedTs: edge.ts,
          lastFundedTs: edge.ts,
        };
        parents.set(funder, parent);
      }
      parent.edges.push(edge);
      parent.totalSol += edge.amountSol;
      parent.totalUsd += edge.amountUsd;
      if (edge.ts < parent.firstFundedTs) parent.firstFundedTs = edge.ts;
      if (edge.ts > parent.lastFundedTs) parent.lastFundedTs = edge.ts;
      if (!parent.children.includes(seed)) parent.children.push(seed);
    }
  }

  for (const p of parents.values()) {
    p.edges.sort((a, b) => a.ts - b.ts);
  }

  return parents;
}

/**
 * Filter parent map to only those that funded >= minChildren distinct seeds,
 * then drop fan-in outliers (CEX-like wallets funding everyone). Sorted by
 * children count descending, then totalSol descending.
 *
 * @param totalSeeds size of the seed pool, used to set the fan-in cap
 */
export function detectParentOperators(
  parents: Map<string, ParentOperator>,
  totalSeeds: number,
  opts: { minChildren?: number; fanInCap?: number } = {},
): ParentOperator[] {
  const minChildren = opts.minChildren ?? 2;
  const cap = opts.fanInCap ?? Math.max(15, Math.ceil(totalSeeds * 0.5));
  return Array.from(parents.values())
    .filter((p) => p.children.length >= minChildren && p.children.length < cap)
    .sort((a, b) => {
      if (b.children.length !== a.children.length) return b.children.length - a.children.length;
      return b.totalSol - a.totalSol;
    });
}

/**
 * Bidirectional rotation: a wallet that BOTH (a) was funded by our seeds
 * (out-graph candidate) AND (b) sent value to multiple of our seeds (in-graph
 * parent). This is the rare strongest signal — the wallet is an active hub
 * in the operator's rotation network, both receiving and dispatching capital.
 *
 * Returns the set of wallets to boost.
 */
export function detectBidirectionalHubs(
  candidates: Map<string, CandidateProfile>,
  parents: Map<string, ParentOperator>,
  minSeedFanIn = 2,
): Set<string> {
  const hubs = new Set<string>();
  for (const w of candidates.keys()) {
    const p = parents.get(w);
    if (p && p.children.length >= minSeedFanIn) hubs.add(w);
  }
  return hubs;
}

/**
 * Detect "pass-through routers": wallets that receive AND send capital across
 * many counterparties but never trade. This is the classic CEX hot-wallet
 * pattern (Binance/Bybit/OKX hot wallets we don't have in our blacklist),
 * NFT marketplace withdrawal aggregators, or fund mixers.
 *
 * A real operator's treasury can also look like this — they disburse capital
 * without trading themselves. The distinguishing factor is volume and
 * counterparty diversity, but at our scale we can't reliably tell them apart
 * automatically. Default behavior is to flag them so the user can manually
 * spot-check on Solscan rather than auto-promoting them as alpha.
 *
 * Triggers:
 *   - candidate has >= minBidirectionalEdges distinct funders (out-graph)
 *   - same wallet is parent of >= minBidirectionalEdges distinct seeds (in-graph)
 *   - total SOL flow >= minSolFlow (i.e., not a small operator)
 *   - candidate has zero swap activity in our verification window
 *
 * @param candidateToSwaps swap history per candidate (from verification step)
 */
export function detectPassThroughRouters(
  candidates: Map<string, CandidateProfile>,
  parents: Map<string, ParentOperator>,
  candidateToSwaps: Record<string, SwapEvent[]>,
  opts: { minBidirectionalEdges?: number; minSolFlow?: number } = {},
): Set<string> {
  const minEdges = opts.minBidirectionalEdges ?? 5;
  const minSolFlow = opts.minSolFlow ?? 50;
  const flagged = new Set<string>();
  for (const [w, c] of candidates) {
    const p = parents.get(w);
    if (!p) continue;
    if (c.funders.length < minEdges) continue;
    if (p.children.length < minEdges) continue;
    if (c.totalSol < minSolFlow) continue;
    const swaps = candidateToSwaps[w] ?? [];
    if (swaps.length > 0) continue;
    flagged.add(w);
  }
  return flagged;
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
  const lastSwapTs = sortedSwaps[sortedSwaps.length - 1]!.ts;
  let timeToFirstSwapSec: number | null = null;
  if (firstSwapTs >= profile.firstFundedTs) {
    timeToFirstSwapSec = firstSwapTs - profile.firstFundedTs;
  }

  const totalSwapUsd = sortedSwaps.reduce((s, sw) => s + sw.amountUsd, 0);
  const buyEvents = sortedSwaps.filter((s) => s.side === 'buy');
  const sellEvents = sortedSwaps.filter((s) => s.side === 'sell');
  const buys = buyEvents.length;
  const sells = sellEvents.length;
  const buySellRatio = sells > 0 ? buys / sells : null;

  // Avg/median buy size (priced only — drops events with amountUsd=0 from
  // unpriced memecoins). If we have no priced buys we leave both at 0,
  // which the classifier treats as UNCLASSIFIED rather than RETAIL-MICRO.
  const pricedBuyUsds = buyEvents.map((e) => e.amountUsd).filter((u) => u > 0).sort((a, b) => a - b);
  const avgBuyUsd =
    pricedBuyUsds.length > 0
      ? pricedBuyUsds.reduce((s, v) => s + v, 0) / pricedBuyUsds.length
      : 0;
  const medianBuyUsd =
    pricedBuyUsds.length > 0 ? pricedBuyUsds[Math.floor(pricedBuyUsds.length / 2)]! : 0;

  const flags: string[] = [];
  if (sortedSwaps.length > 80) flags.push('high_velocity');
  if (sells === 0 && buys >= 5) flags.push('buy_only');
  if (distinctMints === 1 && sortedSwaps.length >= 5) flags.push('single_token');
  let clusterCount = 0;
  for (let i = 1; i < sortedSwaps.length; i++) {
    if (sortedSwaps[i]!.ts - sortedSwaps[i - 1]!.ts <= 1) clusterCount++;
  }
  if (clusterCount >= 5) flags.push('bot_clustering');

  const behaviorClass = classifyBehavior({
    buyCount: buys,
    sellCount: sells,
    distinctMints,
    avgBuyUsd,
    medianBuyUsd,
    pricedBuyCount: pricedBuyUsds.length,
    totalSwapUsd,
  });

  return {
    swapCount: sortedSwaps.length,
    distinctMints,
    firstSwapTs,
    lastSwapTs,
    timeToFirstSwapSec,
    totalSwapUsd,
    buySellRatio,
    buyCount: buys,
    sellCount: sells,
    avgBuyUsd,
    medianBuyUsd,
    behaviorClass,
    flags,
  };
}

/**
 * Classify wallet behavior from raw counts.
 *
 * CRITICAL LESSON from manual review: avg buy size alone is a TERRIBLE filter
 * for memecoin-era operators. Wallets like GoorwtjW (avg $16, 10 buys, 4 mints,
 * fresh) and CnjzwkRh (avg $14, 11 buys, 3 mints) are confirmed alpha — they
 * micro-snipe fresh memecoins on the buy-leg, then transfer tokens out to a
 * sell-leg wallet. Their per-trade size is small BY DESIGN.
 *
 * Conversely EprMqnDB (avg $78, 3 buys, 4 mints) has bigger avg but is just
 * a sporadic manual retail trader.
 *
 * → Size + activity together. Not size alone.
 *
 * Decision logic (in order):
 *   1. RETAIL-MICRO only when truly tiny AND no operator pattern:
 *        a) ultra-tiny (<$5 avg) — almost always dust regardless of activity
 *        b) small avg (<$30) AND <5 buys AND <2 mints — low-conviction retail
 *   2. MEMECOIN-OP — small avg ($5-30) + high activity + multi-mint + buy-heavy
 *      → the micro-sniper operator pattern. STRONG ALPHA SIGNAL.
 *   3. OP-SOURCE — buy-heavy + multi-mint + buyCount>=3 + avg>=$50
 *      → the larger-position operator pattern (or unpriced)
 *   4. BUY-HEAVY — buyRatio >= 0.75 (mid signal)
 *   5. SELL-HEAVY — sellRatio >= 0.75 (offload-leg of an operator)
 *   6. BALANCED — fallback (normal trader, no specific pattern)
 */
export interface ClassifyMetrics {
  buyCount: number;
  sellCount: number;
  distinctMints: number;
  avgBuyUsd: number;
  medianBuyUsd: number;
  pricedBuyCount: number;
  /** lifetime USD across all swaps (buys + sells) */
  totalSwapUsd?: number;
  minOpSourceBuys?: number;
  /** memecoin-op activity threshold (default: 5 buys) */
  minMemecoinOpBuys?: number;
}

export function classifyBehavior(m: ClassifyMetrics): BehaviorClass {
  const minOpSourceBuys = m.minOpSourceBuys ?? 3;
  const minMemecoinOpBuys = m.minMemecoinOpBuys ?? 5;
  const total = m.buyCount + m.sellCount;
  if (total === 0) return 'UNCLASSIFIED';

  const buyRatio = m.buyCount / total;
  const sellRatio = m.sellCount / total;

  // RETAIL-MICRO — truly negligible. Two narrow gates.
  if (m.pricedBuyCount >= 2 && m.avgBuyUsd > 0 && m.avgBuyUsd < 5) {
    return 'RETAIL-MICRO';
  }
  if (
    m.pricedBuyCount >= 2 &&
    m.avgBuyUsd > 0 && m.avgBuyUsd < 30 &&
    m.buyCount < 5 &&
    m.distinctMints < 2
  ) {
    return 'RETAIL-MICRO';
  }

  // MEMECOIN-OP — micro buys but real operator activity (the GoorwtjW pattern)
  if (
    m.avgBuyUsd > 0 && m.avgBuyUsd < 30 &&
    m.buyCount >= minMemecoinOpBuys &&
    m.distinctMints >= 2 &&
    buyRatio >= 0.6
  ) {
    return 'MEMECOIN-OP';
  }

  // OP-SOURCE — larger-position buy-heavy operator
  if (
    buyRatio >= 0.85 &&
    m.distinctMints >= 2 &&
    m.buyCount >= minOpSourceBuys &&
    (m.pricedBuyCount === 0 || m.avgBuyUsd >= 50)
  ) {
    return 'OP-SOURCE';
  }

  if (buyRatio >= 0.75) return 'BUY-HEAVY';
  if (sellRatio >= 0.75) return 'SELL-HEAVY';
  return 'BALANCED';
}

/**
 * Combine funding score with behavior metrics into the final rotation score.
 *
 * Staleness gate (CRITICAL):
 *   - For wallets WITH swaps: drop to score 0 if last swap > maxStaleDays old.
 *     A wallet with 30 swaps from 6 months ago is dead, regardless of how
 *     "balanced" or "multi-token" those ancient swaps look.
 *   - For wallets WITH NO swaps: drop to score 0 if first funding > maxFundingAgeDaysNoSwap
 *     old. They've been funded but never deployed = abandoned.
 *
 * Behavior modifiers (only applied if not stale):
 *   - +30 if behaviorClass = MEMECOIN-OP (micro-sniper operator — strongest)
 *   - +25 if behaviorClass = OP-SOURCE (larger-position operator buy-leg)
 *   - +10 if behaviorClass = SELL-HEAVY (exit wallet, useful for timing)
 *   - +5  if behaviorClass = BUY-HEAVY (modest signal)
 *   - DROP to 0 if behaviorClass = RETAIL-MICRO and dropRetailMicro=true
 *   - +15 if 2+ distinct mints traded (real trader, not single-token holder)
 *   - +10 if first swap happened within 24h of first funding (deliberate deploy)
 *   - +5  if buySellRatio between 0.7 and 1.5 (balanced, not just accumulation)
 *   - +5  if last swap is fresh (< 7 days old) → bonus for actively trading
 *   - -25 if 'high_velocity' or 'bot_clustering' (bot, not human)
 *   - DROPPED handling for 'buy_only' — the OP-SOURCE class supersedes the
 *     old "buy-only" penalty. NOT penalized anymore: buy-only is the desired
 *     signal for a multi-wallet operator (purchases here, sells elsewhere).
 *   - -10 if 'single_token' (probably a one-shot deployment, not a rotation)
 */
export function scoreRotationCandidate(
  profile: CandidateProfile,
  behavior: CandidateBehavior | null,
  now = Math.floor(Date.now() / 1000),
  opts: {
    maxStaleDays?: number;
    maxFundingAgeDaysNoSwap?: number;
    /** drop RETAIL-MICRO entirely (default: drop). Set to 0 to keep them */
    dropRetailMicro?: boolean;
  } = {},
): RotationCandidate {
  const maxStaleDays = opts.maxStaleDays ?? 30;
  const maxFundingAgeDaysNoSwap = opts.maxFundingAgeDaysNoSwap ?? 14;
  const dropRetailMicro = opts.dropRetailMicro ?? true;
  const { score: baseScore, reason: baseReason } = scoreFundingProfile(profile, now);

  if (!behavior) {
    // No swap activity. If the funding is also old, the wallet is dead/abandoned.
    const fundingAgeDays = (now - profile.lastFundedTs) / 86_400;
    if (fundingAgeDays > maxFundingAgeDaysNoSwap) {
      return {
        wallet: profile.wallet,
        profile,
        behavior,
        score: 0,
        reason: `${baseReason}; STALE: funded ${fundingAgeDays.toFixed(0)}d ago, never traded`,
      };
    }
    return {
      wallet: profile.wallet,
      profile,
      behavior,
      score: baseScore * 0.4,
      reason: `${baseReason}; NO swaps yet (funded ${fundingAgeDays.toFixed(0)}d ago, may deploy soon)`,
    };
  }

  // Staleness check on last swap — the most critical gate.
  const lastSwapAgeDays = (now - behavior.lastSwapTs) / 86_400;
  if (lastSwapAgeDays > maxStaleDays) {
    return {
      wallet: profile.wallet,
      profile,
      behavior,
      score: 0,
      reason: `${baseReason}; STALE: last swap ${lastSwapAgeDays.toFixed(0)}d ago (${behavior.swapCount} historical swaps)`,
    };
  }

  // Retail-micro filter — manual retail trader with sub-threshold avg buys.
  // Per user feedback: "$24 two weeks ago, $90 an hour ago" type wallets
  // are noise, not alpha.
  if (dropRetailMicro && behavior.behaviorClass === 'RETAIL-MICRO') {
    return {
      wallet: profile.wallet,
      profile,
      behavior,
      score: 0,
      reason: `${baseReason}; RETAIL-MICRO: avg buy $${behavior.avgBuyUsd.toFixed(0)} (${behavior.buyCount} buys, ${behavior.sellCount} sells)`,
    };
  }

  let mod = 0;
  const reasonParts: string[] = [];
  const isBot =
    behavior.flags.includes('high_velocity') || behavior.flags.includes('bot_clustering');

  // Behavior-class bonuses — the primary alpha signal.
  // Suppressed for bot-like wallets: a bot doing 100 buys on 5 mints isn't OP-SOURCE,
  // it's an MEV/arb bot. Only humans get the class bonus.
  if (!isBot) {
    switch (behavior.behaviorClass) {
      case 'MEMECOIN-OP':
        mod += 30;
        reasonParts.push(
          `MEMECOIN-OP (${behavior.buyCount}b avg $${behavior.avgBuyUsd.toFixed(0)} ${behavior.distinctMints}mints)`,
        );
        break;
      case 'OP-SOURCE':
        mod += 25;
        reasonParts.push(`OP-SOURCE (avg $${behavior.avgBuyUsd.toFixed(0)})`);
        break;
      case 'SELL-HEAVY':
        mod += 10;
        reasonParts.push(`SELL-HEAVY (exit-leg)`);
        break;
      case 'BUY-HEAVY':
        mod += 5;
        reasonParts.push(`BUY-HEAVY`);
        break;
      case 'BALANCED':
        reasonParts.push(`BALANCED`);
        break;
      case 'UNCLASSIFIED':
        reasonParts.push(`unpriced (${behavior.buyCount}b/${behavior.sellCount}s)`);
        break;
    }
  }

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
    reasonParts.push('balanced-bs');
  }
  if (lastSwapAgeDays <= 7) {
    mod += 5;
    reasonParts.push(`fresh-swap (${lastSwapAgeDays.toFixed(0)}d)`);
  }
  if (isBot) {
    // Strong penalty: MEV/arb bots have nothing to do with rotation alpha.
    mod -= 50;
    reasonParts.push('bot-like');
  }
  if (behavior.flags.includes('single_token')) {
    mod -= 10;
    reasonParts.push('single-token');
  }

  const score = Math.max(0, baseScore + mod);
  const reason = `${baseReason}; ${behavior.swapCount} swaps (last ${lastSwapAgeDays.toFixed(1)}d ago)${reasonParts.length > 0 ? '; ' + reasonParts.join(', ') : ''}`;
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
 * Operator cluster: a group of candidate wallets that share the same funder
 * AND received similarly-sized funding (within a tolerance). These are likely
 * different rotation accounts of the SAME operator and should be treated as
 * one alpha source for copy-trade signal de-duplication.
 *
 * NOTE: This is wider than collapseRotationFleets — fleets are time-clustered,
 * but an operator may deploy wallets sequentially over hours/days yet still
 * be ONE operator. Cluster-key uses funder + amount-bucket only (no time).
 */
export interface OperatorCluster {
  /** synthetic cluster id (funder + amount bucket) */
  id: string;
  /** the dominant funder for this cluster (highest aggregate flow) */
  funder: string;
  /** approximate per-wallet funding size in SOL (bucket label) */
  fundingSizeSol: number;
  /** all member wallets ordered by individual score desc */
  members: RotationCandidate[];
  /** total swaps across all members (signal strength) */
  totalSwaps: number;
  /** total funding received across all members */
  totalSol: number;
  /** the single best representative (highest individual score) */
  representative: RotationCandidate;
}

/**
 * Group candidates into operator clusters by SHARED FUNDER + similar
 * funding amount (rounded to 0.5-SOL bucket). Wallets with multiple funders
 * are clustered by their primary (largest) funding edge.
 */
export function clusterByOperator(
  candidates: RotationCandidate[],
  amountBucketSol = 1.0,
): OperatorCluster[] {
  const groups = new Map<string, RotationCandidate[]>();
  for (const c of candidates) {
    if (c.profile.funders.length === 0) continue;
    // Pick primary funder = the one with the largest cumulative SOL inflow
    const flowByFunder = new Map<string, number>();
    for (const e of c.profile.edges) {
      flowByFunder.set(e.seed, (flowByFunder.get(e.seed) ?? 0) + e.amountSol);
    }
    let primaryFunder = c.profile.funders[0]!;
    let maxFlow = 0;
    for (const [f, v] of flowByFunder) {
      if (v > maxFlow) {
        maxFlow = v;
        primaryFunder = f;
      }
    }
    const sizeBucket = Math.round(c.profile.totalSol / amountBucketSol) * amountBucketSol;
    const key = `${primaryFunder}|${sizeBucket.toFixed(1)}`;
    const arr = groups.get(key) ?? [];
    arr.push(c);
    groups.set(key, arr);
  }

  const clusters: OperatorCluster[] = [];
  for (const [id, members] of groups) {
    if (members.length === 0) continue;
    members.sort((a, b) => b.score - a.score);
    const [funder, sizeStr] = id.split('|');
    const fundingSizeSol = Number(sizeStr);
    const totalSwaps = members.reduce(
      (s, m) => s + (m.behavior?.swapCount ?? 0),
      0,
    );
    const totalSol = members.reduce((s, m) => s + m.profile.totalSol, 0);
    clusters.push({
      id,
      funder: funder!,
      fundingSizeSol,
      members,
      totalSwaps,
      totalSol,
      representative: members[0]!,
    });
  }

  // Sort by (cluster size desc, then by representative score desc)
  clusters.sort((a, b) => {
    if (b.members.length !== a.members.length) return b.members.length - a.members.length;
    return b.representative.score - a.representative.score;
  });
  return clusters;
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
