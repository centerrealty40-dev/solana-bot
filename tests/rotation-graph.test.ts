import { describe, it, expect } from 'vitest';
import {
  buildRotationGraph,
  buildIncomingGraph,
  detectFanInOutliers,
  detectParentOperators,
  detectBidirectionalHubs,
  detectPassThroughRouters,
  computeBehavior,
  classifyBehavior,
  scoreFundingProfile,
  scoreRotationCandidate,
  collapseRotationFleets,
  clusterByOperator,
  formatRotationNote,
  type CandidateProfile,
  type RotationCandidate,
} from '../src/scoring/rotation-graph.js';
import type { TransferEvent } from '../src/collectors/wallet-transfers.js';
import type { SwapEvent } from '../src/collectors/helius-discovery.js';
import { QUOTE_MINTS } from '../src/core/constants.js';
import { CEX_HOT_WALLETS } from '../src/core/known-addresses.js';

function te(
  wallet: string,
  counterparty: string,
  amountSol: number,
  ts: number,
  direction: 'in' | 'out' = 'out',
): TransferEvent {
  return {
    wallet,
    counterparty,
    direction,
    amountSol,
    amountUsd: amountSol * 200, // treat 1 SOL = $200 for tests
    mint: QUOTE_MINTS.SOL,
    ts,
    signature: `${wallet.slice(0, 4)}-${counterparty.slice(0, 4)}-${ts}`,
  };
}

function sw(
  wallet: string,
  baseMint: string,
  side: 'buy' | 'sell',
  amountUsd: number,
  ts: number,
): SwapEvent {
  return {
    wallet,
    baseMint,
    side,
    amountUsd,
    solValue: amountUsd / 200,
    ts,
    signature: `${wallet.slice(0, 4)}-${baseMint.slice(0, 4)}-${ts}`,
  };
}

describe('buildRotationGraph', () => {
  it('aggregates funder→candidate edges across multiple seeds', () => {
    const seedToTransfers: Record<string, TransferEvent[]> = {
      seedA: [te('seedA', 'cand1', 1.5, 1_000), te('seedA', 'cand2', 0.8, 1_100)],
      seedB: [te('seedB', 'cand1', 2.0, 1_200)],
    };
    const { candidates } = buildRotationGraph(seedToTransfers);
    expect(candidates.size).toBe(2);
    const c1 = candidates.get('cand1')!;
    expect(c1.funders.sort()).toEqual(['seedA', 'seedB']);
    expect(c1.totalSol).toBeCloseTo(3.5, 5);
    expect(c1.edges).toHaveLength(2);
    expect(c1.firstFundedTs).toBe(1_000);
    expect(c1.lastFundedTs).toBe(1_200);

    const c2 = candidates.get('cand2')!;
    expect(c2.funders).toEqual(['seedA']);
    expect(c2.totalSol).toBeCloseTo(0.8, 5);
  });

  it('drops sub-threshold edges (anti-dust)', () => {
    const seedToTransfers: Record<string, TransferEvent[]> = {
      seedA: [te('seedA', 'cand1', 0.05, 1_000)], // below default 0.5 SOL
      seedB: [te('seedB', 'cand1', 1.0, 1_100)],
    };
    const { candidates } = buildRotationGraph(seedToTransfers);
    const c1 = candidates.get('cand1')!;
    expect(c1.funders).toEqual(['seedB']); // seedA edge dropped
    expect(c1.totalSol).toBeCloseTo(1.0, 5);
  });

  it('excludes CEX hot wallets and seed-to-seed transfers', () => {
    const cexWallet = Array.from(CEX_HOT_WALLETS)[0]!;
    const seedToTransfers: Record<string, TransferEvent[]> = {
      seedA: [
        te('seedA', cexWallet, 5, 1_000), // CEX recipient
        te('seedA', 'seedB', 5, 1_100), // seed-to-seed
        te('seedA', 'cand1', 5, 1_200),
      ],
      seedB: [],
    };
    const { candidates } = buildRotationGraph(seedToTransfers);
    expect(candidates.has(cexWallet)).toBe(false);
    expect(candidates.has('seedB')).toBe(false);
    expect(candidates.has('cand1')).toBe(true);
  });

  it('only considers outgoing transfers', () => {
    const seedToTransfers: Record<string, TransferEvent[]> = {
      seedA: [
        te('seedA', 'cand1', 5, 1_000, 'in'), // incoming, must be ignored
        te('seedA', 'cand2', 5, 1_100, 'out'),
      ],
    };
    const { candidates } = buildRotationGraph(seedToTransfers);
    expect(candidates.has('cand1')).toBe(false);
    expect(candidates.has('cand2')).toBe(true);
  });
});

describe('detectFanInOutliers', () => {
  it('flags candidates funded by >40% of seeds (suspected CEX/MM)', () => {
    const seedToTransfers: Record<string, TransferEvent[]> = {};
    for (let i = 0; i < 10; i++) {
      const seed = `seed${i}`;
      const transfers: TransferEvent[] = [te(seed, 'hotWallet', 1, 1_000 + i)];
      if (i < 3) transfers.push(te(seed, 'rotation1', 1, 2_000 + i));
      seedToTransfers[seed] = transfers;
    }
    const { candidates } = buildRotationGraph(seedToTransfers);
    // Default cap = max(15, ceil(10*0.4)) = 15. So only triggers on huge fan-in.
    // Override cap = 5 to test that hotWallet (10 funders) is flagged but
    // rotation1 (3 funders) is not.
    const outliers = detectFanInOutliers(candidates, 10, 5);
    expect(outliers.has('hotWallet')).toBe(true);
    expect(outliers.has('rotation1')).toBe(false);
  });

  it('uses sensible auto-cap when not overridden', () => {
    const seedToTransfers: Record<string, TransferEvent[]> = {};
    for (let i = 0; i < 50; i++) {
      const seed = `seed${i}`;
      seedToTransfers[seed] = [te(seed, 'hotWallet', 1, 1_000 + i)];
    }
    const { candidates } = buildRotationGraph(seedToTransfers);
    // Auto cap = max(15, ceil(50*0.4)) = 20. hotWallet has 50 funders → flagged.
    const outliers = detectFanInOutliers(candidates, 50);
    expect(outliers.has('hotWallet')).toBe(true);
  });
});

describe('scoreFundingProfile', () => {
  it('rewards distinct funders heavily', () => {
    const onlyOne: CandidateProfile = {
      wallet: 'cand',
      funders: ['s1'],
      edges: [],
      totalSol: 5,
      totalUsd: 1000,
      firstFundedTs: 1_000,
      lastFundedTs: 1_000,
    };
    const three: CandidateProfile = {
      ...onlyOne,
      funders: ['s1', 's2', 's3'],
    };
    const s1 = scoreFundingProfile(onlyOne, 1_000).score;
    const s3 = scoreFundingProfile(three, 1_000).score;
    expect(s3).toBeGreaterThan(s1 + 50);
  });

  it('grants wave bonus when funding events cluster within 7 days', () => {
    const tight: CandidateProfile = {
      wallet: 'cand',
      funders: ['s1', 's2'],
      edges: [],
      totalSol: 5,
      totalUsd: 1000,
      firstFundedTs: 1_000,
      lastFundedTs: 1_000 + 86_400 * 2, // 2-day spread
    };
    const wide: CandidateProfile = {
      ...tight,
      lastFundedTs: 1_000 + 86_400 * 60, // 60-day spread
    };
    const sTight = scoreFundingProfile(tight, 1_000 + 86_400 * 60).score;
    const sWide = scoreFundingProfile(wide, 1_000 + 86_400 * 60).score;
    expect(sTight).toBeGreaterThan(sWide);
  });
});

describe('computeBehavior', () => {
  const profile: CandidateProfile = {
    wallet: 'cand',
    funders: ['s1', 's2'],
    edges: [],
    totalSol: 5,
    totalUsd: 1000,
    firstFundedTs: 1_000,
    lastFundedTs: 1_500,
  };

  it('returns null when wallet has no swaps', () => {
    expect(computeBehavior([], profile)).toBeNull();
  });

  it('flags bot-clustering when many sub-second swaps observed', () => {
    const swaps: SwapEvent[] = [];
    for (let i = 0; i < 10; i++) {
      swaps.push(sw('cand', `mint${i % 3}`, 'buy', 50, 2_000 + i)); // 1s apart
    }
    const beh = computeBehavior(swaps, profile)!;
    expect(beh.flags).toContain('bot_clustering');
  });

  it('flags buy_only when no sells observed and 5+ buys', () => {
    const swaps: SwapEvent[] = [];
    for (let i = 0; i < 6; i++) {
      swaps.push(sw('cand', `mint${i}`, 'buy', 100, 2_000 + i * 100));
    }
    const beh = computeBehavior(swaps, profile)!;
    expect(beh.flags).toContain('buy_only');
  });

  it('computes time-to-first-swap from first funding event', () => {
    const swaps = [sw('cand', 'mintA', 'buy', 100, 1_500)];
    const beh = computeBehavior(swaps, profile)!;
    expect(beh.timeToFirstSwapSec).toBe(500);
  });
});

describe('scoreRotationCandidate', () => {
  const baseProfile: CandidateProfile = {
    wallet: 'cand',
    funders: ['s1', 's2'],
    edges: [],
    totalSol: 5,
    totalUsd: 1000,
    firstFundedTs: 1_000,
    lastFundedTs: 1_500,
  };

  it('penalizes candidates with no swap activity (passive holders)', () => {
    const c = scoreRotationCandidate(baseProfile, null, 1_500);
    const baseScore = scoreFundingProfile(baseProfile, 1_500).score;
    expect(c.score).toBeLessThan(baseScore * 0.5);
    expect(c.reason).toContain('NO swaps');
  });

  it('boosts balanced multi-token traders', () => {
    const swaps: SwapEvent[] = [
      sw('cand', 'mintA', 'buy', 100, 1_500),
      sw('cand', 'mintB', 'buy', 100, 1_700),
      sw('cand', 'mintA', 'sell', 100, 1_900),
    ];
    const beh = computeBehavior(swaps, baseProfile)!;
    const c = scoreRotationCandidate(baseProfile, beh, 2_000);
    const baseScore = scoreFundingProfile(baseProfile, 2_000).score;
    // Should get +15 (2 mints) + maybe +10 (fast deploy < 24h)
    expect(c.score).toBeGreaterThan(baseScore + 15);
  });

  it('drops to score 0 when last swap is older than maxStaleDays (DEAD wallet)', () => {
    // Wallet has 30 great-looking swaps from 6 months ago
    const oldTs = 100_000;
    const swaps: SwapEvent[] = [];
    for (let i = 0; i < 30; i++) {
      swaps.push(sw('cand', `mint${i % 5}`, i % 2 === 0 ? 'buy' : 'sell', 200, oldTs + i * 100));
    }
    const beh = computeBehavior(swaps, baseProfile)!;
    const now = oldTs + 86_400 * 180; // 180 days later
    const c = scoreRotationCandidate(baseProfile, beh, now, { maxStaleDays: 30 });
    expect(c.score).toBe(0);
    expect(c.reason).toContain('STALE: last swap');
  });

  it('drops no-swap wallet to score 0 when funding is older than maxFundingAgeDaysNoSwap', () => {
    const profile: CandidateProfile = {
      ...baseProfile,
      firstFundedTs: 1_000,
      lastFundedTs: 1_000,
    };
    const now = 1_000 + 86_400 * 60; // 60 days later
    const c = scoreRotationCandidate(profile, null, now, { maxFundingAgeDaysNoSwap: 14 });
    expect(c.score).toBe(0);
    expect(c.reason).toContain('STALE: funded');
  });

  it('keeps no-swap wallet when funding is fresh (recently funded, may deploy)', () => {
    const now = baseProfile.lastFundedTs + 86_400 * 3; // 3 days later
    const c = scoreRotationCandidate(baseProfile, null, now, { maxFundingAgeDaysNoSwap: 14 });
    expect(c.score).toBeGreaterThan(0);
    expect(c.reason).toContain('NO swaps yet');
    expect(c.reason).toContain('may deploy soon');
  });

  it('rewards fresh-swap candidates with extra bonus', () => {
    const now = 1_000_000;
    const swaps: SwapEvent[] = [
      sw('cand', 'mintA', 'buy', 100, now - 86_400), // 1 day ago
      sw('cand', 'mintB', 'sell', 100, now - 3_600), // 1 hour ago
    ];
    const profile: CandidateProfile = {
      ...baseProfile,
      firstFundedTs: now - 86_400 * 2,
      lastFundedTs: now - 86_400,
    };
    const beh = computeBehavior(swaps, profile)!;
    const c = scoreRotationCandidate(profile, beh, now);
    expect(c.reason).toContain('fresh-swap');
  });

  it('drops bot-like candidates significantly', () => {
    const now = 1_000_000;
    const profile: CandidateProfile = {
      ...baseProfile,
      firstFundedTs: now - 86_400,
      lastFundedTs: now - 3_600,
    };
    const swaps: SwapEvent[] = [];
    for (let i = 0; i < 100; i++) {
      swaps.push(sw('cand', `mint${i % 5}`, 'buy', 30, now - 100 + i)); // 1s apart, recent
    }
    const beh = computeBehavior(swaps, profile)!;
    const c = scoreRotationCandidate(profile, beh, now);
    const baseScore = scoreFundingProfile(profile, now).score;
    // -25 (bot_clustering) -15 (buy_only) > +5 (fresh) so net negative
    expect(c.score).toBeLessThan(baseScore);
    expect(c.reason).toContain('bot-like');
  });
});

describe('collapseRotationFleets', () => {
  it('keeps only the highest-scoring representative per same-funder cluster', () => {
    const profileBase: CandidateProfile = {
      wallet: '',
      funders: ['s1', 's2'],
      edges: [],
      totalSol: 5,
      totalUsd: 1000,
      firstFundedTs: 10_000,
      lastFundedTs: 10_100,
    };
    const candidates = [
      { wallet: 'cand1', profile: { ...profileBase, wallet: 'cand1' }, behavior: null, score: 50, reason: 'a' },
      { wallet: 'cand2', profile: { ...profileBase, wallet: 'cand2' }, behavior: null, score: 80, reason: 'b' },
      { wallet: 'cand3', profile: { ...profileBase, wallet: 'cand3' }, behavior: null, score: 30, reason: 'c' },
      // Different funder set → different fleet
      {
        wallet: 'cand4',
        profile: { ...profileBase, wallet: 'cand4', funders: ['s3', 's4'] },
        behavior: null,
        score: 40,
        reason: 'd',
      },
    ];
    const collapsed = collapseRotationFleets(candidates);
    const wallets = collapsed.map((c) => c.wallet).sort();
    expect(wallets).toEqual(['cand2', 'cand4']);
  });
});

describe('buildIncomingGraph', () => {
  it('aggregates parent→seed edges from incoming transfers', () => {
    const seedToTransfers: Record<string, TransferEvent[]> = {
      seedA: [
        te('seedA', 'parentP', 5, 1_000, 'in'),
        te('seedA', 'someoneElse', 1, 1_100, 'out'), // ignored
      ],
      seedB: [te('seedB', 'parentP', 3, 1_200, 'in')],
      seedC: [te('seedC', 'otherParent', 7, 1_300, 'in')],
    };
    const parents = buildIncomingGraph(seedToTransfers);
    expect(parents.size).toBe(2);
    const p = parents.get('parentP')!;
    expect(p.children.sort()).toEqual(['seedA', 'seedB']);
    expect(p.totalSol).toBeCloseTo(8, 5);
    expect(p.firstFundedTs).toBe(1_000);
    expect(p.lastFundedTs).toBe(1_200);
  });

  it('skips outgoing transfers and seed-to-seed funding', () => {
    const seedToTransfers: Record<string, TransferEvent[]> = {
      seedA: [
        te('seedA', 'seedB', 5, 1_000, 'in'), // seed-to-seed: skip
        te('seedA', 'parentP', 3, 1_100, 'in'),
      ],
      seedB: [],
    };
    const parents = buildIncomingGraph(seedToTransfers);
    expect(parents.has('seedB')).toBe(false);
    expect(parents.has('parentP')).toBe(true);
  });
});

describe('detectParentOperators', () => {
  it('returns only parents that funded >=minChildren seeds', () => {
    const seedToTransfers: Record<string, TransferEvent[]> = {
      s1: [te('s1', 'parent_multi', 5, 1_000, 'in')],
      s2: [te('s2', 'parent_multi', 5, 1_001, 'in')],
      s3: [te('s3', 'parent_multi', 5, 1_002, 'in')],
      s4: [te('s4', 'parent_single', 5, 1_003, 'in')],
    };
    const parents = buildIncomingGraph(seedToTransfers);
    const ops = detectParentOperators(parents, 4, { minChildren: 2 });
    expect(ops.map((p) => p.wallet)).toEqual(['parent_multi']);
  });

  it('drops fan-in outliers (likely CEX-like services)', () => {
    const seedToTransfers: Record<string, TransferEvent[]> = {};
    for (let i = 0; i < 10; i++) {
      seedToTransfers[`seed${i}`] = [te(`seed${i}`, 'cexLike', 5, 1_000 + i, 'in')];
    }
    seedToTransfers['seedA'] = [te('seedA', 'realParent', 5, 2_000, 'in')];
    seedToTransfers['seedB'] = [te('seedB', 'realParent', 5, 2_001, 'in')];
    const parents = buildIncomingGraph(seedToTransfers);
    const ops = detectParentOperators(parents, 12, { minChildren: 2, fanInCap: 5 });
    // cexLike has 10 children → exceeds fanInCap=5, so dropped.
    // realParent has 2 children → kept.
    expect(ops.map((p) => p.wallet)).toEqual(['realParent']);
  });

  it('sorts by children count desc, then total SOL desc', () => {
    const seedToTransfers: Record<string, TransferEvent[]> = {
      s1: [te('s1', 'parentBig', 100, 1_000, 'in'), te('s1', 'parentMore', 1, 1_001, 'in')],
      s2: [te('s2', 'parentBig', 100, 1_002, 'in'), te('s2', 'parentMore', 1, 1_003, 'in')],
      s3: [te('s3', 'parentMore', 1, 1_004, 'in')],
    };
    const parents = buildIncomingGraph(seedToTransfers);
    const ops = detectParentOperators(parents, 3, { minChildren: 2 });
    // parentMore has 3 children, parentBig has 2 → parentMore comes first.
    expect(ops.map((p) => p.wallet)).toEqual(['parentMore', 'parentBig']);
  });
});

describe('detectBidirectionalHubs', () => {
  it('flags wallets that appear in BOTH out-graph (as candidate) and in-graph (as parent)', () => {
    const seedToTransfers: Record<string, TransferEvent[]> = {
      s1: [te('s1', 'hubW', 3, 1_000, 'out'), te('s1', 'hubW', 2, 1_500, 'in')],
      s2: [te('s2', 'hubW', 1, 1_100, 'out'), te('s2', 'hubW', 4, 1_600, 'in')],
      s3: [te('s3', 'plainCand', 5, 1_200, 'out')],
    };
    const { candidates } = buildRotationGraph(seedToTransfers);
    const parents = buildIncomingGraph(seedToTransfers);
    const hubs = detectBidirectionalHubs(candidates, parents, 2);
    expect(hubs.has('hubW')).toBe(true);
    expect(hubs.has('plainCand')).toBe(false);
  });

  it('does not flag wallet that is only a single-direction match', () => {
    const seedToTransfers: Record<string, TransferEvent[]> = {
      s1: [te('s1', 'onlyOut', 3, 1_000, 'out')],
      s2: [te('s2', 'onlyOut', 3, 1_100, 'out')],
      s3: [te('s3', 'onlyIn', 5, 1_200, 'in')],
      s4: [te('s4', 'onlyIn', 5, 1_300, 'in')],
    };
    const { candidates } = buildRotationGraph(seedToTransfers);
    const parents = buildIncomingGraph(seedToTransfers);
    const hubs = detectBidirectionalHubs(candidates, parents, 2);
    expect(hubs.size).toBe(0);
  });
});

describe('detectPassThroughRouters', () => {
  function makeBidirectional(
    wallet: string,
    edges: number,
    totalSol: number,
  ): { candidates: Map<string, CandidateProfile>; parents: Map<string, ReturnType<typeof buildIncomingGraph> extends Map<string, infer V> ? V : never> } {
    const seedToTransfers: Record<string, TransferEvent[]> = {};
    for (let i = 0; i < edges; i++) {
      seedToTransfers[`s${i}`] = [
        te(`s${i}`, wallet, totalSol / edges, 1_000 + i, 'out'),
        te(`s${i}`, wallet, totalSol / edges, 2_000 + i, 'in'),
      ];
    }
    const { candidates } = buildRotationGraph(seedToTransfers);
    const parents = buildIncomingGraph(seedToTransfers);
    return { candidates, parents };
  }

  it('flags wallets with high BI-HUB AND big flow AND zero own swaps', () => {
    const { candidates, parents } = makeBidirectional('routerW', 6, 120);
    const routers = detectPassThroughRouters(candidates, parents, {});
    expect(routers.has('routerW')).toBe(true);
  });

  it('does NOT flag wallet that has any swap activity (real trader)', () => {
    const { candidates, parents } = makeBidirectional('traderW', 6, 120);
    const swaps = { traderW: [sw('traderW', 'mintA', 'buy', 50, 5_000)] };
    const routers = detectPassThroughRouters(candidates, parents, swaps);
    expect(routers.has('traderW')).toBe(false);
  });

  it('does NOT flag wallet below the SOL flow threshold (small operators)', () => {
    const { candidates, parents } = makeBidirectional('smallW', 6, 10);
    const routers = detectPassThroughRouters(candidates, parents, {});
    expect(routers.has('smallW')).toBe(false);
  });

  it('does NOT flag wallet with low fan-in/fan-out (could be small rotation)', () => {
    const { candidates, parents } = makeBidirectional('focusedW', 3, 200);
    const routers = detectPassThroughRouters(candidates, parents, {});
    expect(routers.has('focusedW')).toBe(false);
  });
});

describe('classifyBehavior', () => {
  it('returns UNCLASSIFIED for zero swaps', () => {
    expect(
      classifyBehavior({
        buyCount: 0, sellCount: 0, distinctMints: 0,
        avgBuyUsd: 0, medianBuyUsd: 0, pricedBuyCount: 0,
      }),
    ).toBe('UNCLASSIFIED');
  });

  it('returns RETAIL-MICRO only for ultra-tiny avg (<$5)', () => {
    expect(
      classifyBehavior({
        buyCount: 10, sellCount: 5, distinctMints: 4,
        avgBuyUsd: 3, medianBuyUsd: 3, pricedBuyCount: 10,
      }),
    ).toBe('RETAIL-MICRO');
  });

  it('returns RETAIL-MICRO for small avg + low conviction (<5 buys, <2 mints)', () => {
    expect(
      classifyBehavior({
        buyCount: 3, sellCount: 1, distinctMints: 1,
        avgBuyUsd: 15, medianBuyUsd: 15, pricedBuyCount: 3,
      }),
    ).toBe('RETAIL-MICRO');
  });

  it('does NOT classify as RETAIL-MICRO when activity + multi-mint present', () => {
    expect(
      classifyBehavior({
        buyCount: 10, sellCount: 4, distinctMints: 4,
        avgBuyUsd: 16, medianBuyUsd: 12, pricedBuyCount: 10,
      }),
    ).not.toBe('RETAIL-MICRO');
  });

  it('returns MEMECOIN-OP for micro-sniper operator pattern', () => {
    expect(
      classifyBehavior({
        buyCount: 10, sellCount: 4, distinctMints: 4,
        avgBuyUsd: 16, medianBuyUsd: 12, pricedBuyCount: 10,
      }),
    ).toBe('MEMECOIN-OP');
  });

  it('returns MEMECOIN-OP for the CnjzwkRh case', () => {
    expect(
      classifyBehavior({
        buyCount: 11, sellCount: 3, distinctMints: 3,
        avgBuyUsd: 14, medianBuyUsd: 5, pricedBuyCount: 11,
      }),
    ).toBe('MEMECOIN-OP');
  });

  it('does NOT return MEMECOIN-OP if not enough mints', () => {
    expect(
      classifyBehavior({
        buyCount: 10, sellCount: 4, distinctMints: 1,
        avgBuyUsd: 16, medianBuyUsd: 12, pricedBuyCount: 10,
      }),
    ).not.toBe('MEMECOIN-OP');
  });

  it('returns OP-SOURCE for buy-heavy + multi-mint + meaningful size', () => {
    expect(
      classifyBehavior({
        buyCount: 10, sellCount: 1, distinctMints: 4,
        avgBuyUsd: 80, medianBuyUsd: 70, pricedBuyCount: 10,
      }),
    ).toBe('OP-SOURCE');
  });

  it('returns OP-SOURCE for unpriced buy-heavy multi-mint (memecoin trades)', () => {
    expect(
      classifyBehavior({
        buyCount: 8, sellCount: 0, distinctMints: 3,
        avgBuyUsd: 0, medianBuyUsd: 0, pricedBuyCount: 0,
      }),
    ).toBe('OP-SOURCE');
  });

  it('returns BUY-HEAVY for single-mint buy-heavy (not OP-SOURCE)', () => {
    expect(
      classifyBehavior({
        buyCount: 8, sellCount: 1, distinctMints: 1,
        avgBuyUsd: 100, medianBuyUsd: 100, pricedBuyCount: 8,
      }),
    ).toBe('BUY-HEAVY');
  });

  it('returns SELL-HEAVY for offload wallets', () => {
    expect(
      classifyBehavior({
        buyCount: 1, sellCount: 8, distinctMints: 3,
        avgBuyUsd: 50, medianBuyUsd: 50, pricedBuyCount: 1,
      }),
    ).toBe('SELL-HEAVY');
  });

  it('returns BALANCED otherwise', () => {
    expect(
      classifyBehavior({
        buyCount: 5, sellCount: 5, distinctMints: 4,
        avgBuyUsd: 80, medianBuyUsd: 70, pricedBuyCount: 5,
      }),
    ).toBe('BALANCED');
  });

  it('respects minMemecoinOpBuys threshold (4 buys not enough by default)', () => {
    expect(
      classifyBehavior({
        buyCount: 4, sellCount: 1, distinctMints: 3,
        avgBuyUsd: 15, medianBuyUsd: 15, pricedBuyCount: 4,
      }),
    ).not.toBe('MEMECOIN-OP');
    expect(
      classifyBehavior({
        buyCount: 4, sellCount: 1, distinctMints: 3,
        avgBuyUsd: 15, medianBuyUsd: 15, pricedBuyCount: 4,
        minMemecoinOpBuys: 4,
      }),
    ).toBe('MEMECOIN-OP');
  });
});

describe('scoreRotationCandidate behavior-class integration', () => {
  const baseProfile: CandidateProfile = {
    wallet: 'cand',
    funders: ['s1', 's2'],
    edges: [],
    totalSol: 8,
    totalUsd: 1600,
    firstFundedTs: 100,
    lastFundedTs: 200,
  };
  const now = 1_000_000;
  const recentProfile: CandidateProfile = {
    ...baseProfile,
    firstFundedTs: now - 86_400 * 5,
    lastFundedTs: now - 3_600,
  };

  it('drops RETAIL-MICRO wallets entirely (default) — ultra-tiny avg', () => {
    const swaps: SwapEvent[] = [];
    for (let i = 0; i < 5; i++) {
      swaps.push(sw('cand', `m${i}`, 'buy', 3, now - 1000 - i * 100));
    }
    const beh = computeBehavior(swaps, recentProfile)!;
    expect(beh.behaviorClass).toBe('RETAIL-MICRO');
    const c = scoreRotationCandidate(recentProfile, beh, now);
    expect(c.score).toBe(0);
    expect(c.reason).toContain('RETAIL-MICRO');
  });

  it('keeps RETAIL-MICRO if dropRetailMicro=false', () => {
    const swaps: SwapEvent[] = [];
    for (let i = 0; i < 5; i++) {
      swaps.push(sw('cand', `m${i}`, 'buy', 3, now - 1000 - i * 100));
    }
    const beh = computeBehavior(swaps, recentProfile)!;
    const c = scoreRotationCandidate(recentProfile, beh, now, { dropRetailMicro: false });
    expect(c.score).toBeGreaterThan(0);
  });

  it('strongly boosts MEMECOIN-OP class (the GoorwtjW pattern)', () => {
    const swaps: SwapEvent[] = [];
    for (let i = 0; i < 10; i++) {
      swaps.push(sw('cand', `m${i % 4}`, 'buy', 15, now - 1000 - i * 100));
    }
    for (let i = 0; i < 4; i++) {
      swaps.push(sw('cand', `m${i % 4}`, 'sell', 20, now - 500 + i * 50));
    }
    const beh = computeBehavior(swaps, recentProfile)!;
    expect(beh.behaviorClass).toBe('MEMECOIN-OP');
    const c = scoreRotationCandidate(recentProfile, beh, now);
    const baseScore = scoreFundingProfile(recentProfile, now).score;
    expect(c.score).toBeGreaterThan(baseScore + 25);
    expect(c.reason).toContain('MEMECOIN-OP');
  });

  it('boosts OP-SOURCE class significantly', () => {
    const swaps: SwapEvent[] = [];
    for (let i = 0; i < 8; i++) {
      swaps.push(sw('cand', `m${i % 4}`, 'buy', 100, now - 1000 - i * 100));
    }
    const beh = computeBehavior(swaps, recentProfile)!;
    expect(beh.behaviorClass).toBe('OP-SOURCE');
    const c = scoreRotationCandidate(recentProfile, beh, now);
    const baseScore = scoreFundingProfile(recentProfile, now).score;
    expect(c.score).toBeGreaterThan(baseScore + 20);
    expect(c.reason).toContain('OP-SOURCE');
  });

  it('does NOT boost OP-SOURCE if wallet looks like a bot (high velocity)', () => {
    const swaps: SwapEvent[] = [];
    for (let i = 0; i < 100; i++) {
      swaps.push(sw('cand', `m${i % 5}`, 'buy', 100, now - 100 + i));
    }
    const beh = computeBehavior(swaps, recentProfile)!;
    expect(beh.flags).toContain('bot_clustering');
    const c = scoreRotationCandidate(recentProfile, beh, now);
    expect(c.reason).not.toContain('OP-SOURCE');
    expect(c.reason).toContain('bot-like');
  });
});

describe('clusterByOperator', () => {
  function makeCand(wallet: string, funder: string, totalSol: number, score = 50): RotationCandidate {
    return {
      wallet,
      profile: {
        wallet,
        funders: [funder],
        edges: [{ seed: funder, candidate: wallet, amountSol: totalSol, amountUsd: totalSol * 200, ts: 1000, signature: 'sig' }],
        totalSol,
        totalUsd: totalSol * 200,
        firstFundedTs: 1000,
        lastFundedTs: 1000,
      },
      behavior: null,
      score,
      reason: '',
    };
  }

  it('groups same-funder same-amount-bucket wallets into one cluster', () => {
    const cands = [
      makeCand('w1', 'fX', 9.5),
      makeCand('w2', 'fX', 10.1),
      makeCand('w3', 'fX', 9.8),
      makeCand('w4', 'fY', 10.0),
    ];
    const clusters = clusterByOperator(cands, 1.0);
    const fxCluster = clusters.find((c) => c.funder === 'fX');
    expect(fxCluster?.members.length).toBe(3);
    const fyCluster = clusters.find((c) => c.funder === 'fY');
    expect(fyCluster?.members.length).toBe(1);
  });

  it('separates clusters by amount bucket', () => {
    const cands = [
      makeCand('w1', 'fX', 9.5),
      makeCand('w2', 'fX', 50.0),
    ];
    const clusters = clusterByOperator(cands, 1.0);
    expect(clusters.length).toBe(2);
  });

  it('picks highest-scoring member as representative', () => {
    const cands = [
      makeCand('w1', 'fX', 9.5, 30),
      makeCand('w2', 'fX', 10.1, 80),
      makeCand('w3', 'fX', 9.8, 50),
    ];
    const clusters = clusterByOperator(cands, 1.0);
    expect(clusters[0]?.representative.wallet).toBe('w2');
  });

  it('sorts clusters by member count desc', () => {
    const cands = [
      makeCand('w1', 'fA', 5),
      makeCand('w2', 'fB', 5),
      makeCand('w3', 'fB', 5),
      makeCand('w4', 'fB', 5),
    ];
    const clusters = clusterByOperator(cands, 1.0);
    expect(clusters[0]?.funder).toBe('fB');
    expect(clusters[0]?.members.length).toBe(3);
  });
});

describe('formatRotationNote', () => {
  it('produces a compact, parseable note', () => {
    const profile: CandidateProfile = {
      wallet: 'cand1234567890longwallet',
      funders: ['seed111111111111111aaaa', 'seed222222222222222bbbb'],
      edges: [],
      totalSol: 12.7,
      totalUsd: 2540,
      firstFundedTs: 1_000,
      lastFundedTs: 2_000,
    };
    const c = scoreRotationCandidate(profile, null, 2_000);
    const note = formatRotationNote(c);
    expect(note).toContain('rot s=');
    expect(note).toContain('cap=12.7SOL');
    expect(note).toContain('NO_SWAP');
  });
});
