import { describe, expect, it } from 'vitest';
import {
  evaluateLeaderMirrorObservation,
  leaderMirrorDecisionSuppressed,
  LEADER_MIRROR_WALLET,
  leaderMirrorHitKey,
  leaderMirrorObservationWindowMs,
  leaderMirrorObservationFresh,
  leaderMirrorQuoteMintsCap,
  leaderMirrorQuoteCoverage,
  evictFundingParkedWatchKeys,
  mirrorPremiumCapPct,
  mirrorQuoteWithinPremiumCap,
  selectLeaderMirrorQuoteKeys,
  type LeaderMirrorGates,
} from '../../src/milddip/leader-mirror.js';
import { decideMarkExit } from '../../src/milddip/exit-engine.js';
import {
  mirrorEntryAttemptOutcome,
  mirrorEntryStructuralDataVetoIsTransient,
  fundingShortageEntryResult,
  isFundingShortageReason,
  type EntryAttemptResult,
} from '../../src/milddip/entry-attempt.js';

const gates: LeaderMirrorGates = {
  enabled: true,
  greenCopyEnabled: false,
  greenCorridorPct: 1.5,
  greenCopyMaxPc5mPct: 40,
  leaders: [LEADER_MIRROR_WALLET],
  hitMaxAgeMs: 45_000,
  observeMs: 45_000,
  quoteMaxAgeMs: 10_000,
  greenImpulsePct: 5,
  runUpPc5mPct: 10,
  knifeWaitEnabled: true,
  knifeWaitPc5mPct: -10,
  knifeWaitDiscountPct: 5,
  knifeWaitWindowMs: 600_000,
  knifeWaitQuoteSlots: 3,
  maxPremiumPct: 2,
  entryGraceMs: 60_000,
  entryGraceMaxPremiumPct: 1,
  maxEntryPc5mPct: 0,
  maxPreEntryPc5mPct: 0,
  minPc1hPct: -1000,
  minPreEntryPc5mPct: -1000,
  requireDeepDump: false,
  deepDumpPc5mPct: -8,
  minLiquidityUsd: 8_000,
  minPairAgeHours: 0.5,
  minMcapUsd: 5_000,
  maxOpen: 3,
  maxQuoteMints: 8,
  tickIntervalMs: 2_000,
  structuralMaxMints: 4,
  structuralGapMs: 5_000,
  positionUsd: 2,
  cooldownMs: 900_000,
};
const SECOND_LEADER = '8zkgFGVZrDLieViwqiXFCydSX6WL5hsxmUu55yBdsNsZ';

const hit = (overrides: Record<string, unknown> = {}) => ({
  mint: 'So11111111111111111111111111111111111111112',
  lastSeenAtMs: 100_000,
  leader: LEADER_MIRROR_WALLET,
  fillPriceUsd: 100,
  pc5m: -8,
  pc1h: 20,
  liq: 10_000,
  ageHours: 1,
  mcap: 100_000,
  isAdd: false,
  ...overrides,
});

describe('leader mirror quote slot rotation', () => {
  const candidate = (
    n: number,
    startedAtMs: number,
    knifeWaitPending = true,
    knifeWaitDue = true,
  ) => ({
    watchKey: `watch-${n}`,
    startedAtMs,
    knifeWaitPending,
    knifeWaitDue,
  });

  it('gives knife-wait slots to the least recently quoted watches', () => {
    expect(
      selectLeaderMirrorQuoteKeys({
        entries: [
          candidate(1, 1_000),
          candidate(2, 2_000),
          candidate(3, 3_000),
          candidate(4, 4_000),
        ],
        nowMs: 10_000,
        entryGraceMs: 60_000,
        maxQuoteMints: 3,
        knifeWaitQuoteSlots: 2,
        lastQuotedAtMs: new Map([
          ['watch-1', 9_000],
          ['watch-2', 8_000],
        ]),
      }),
    ).toEqual(['watch-3', 'watch-4']);
  });

  it('keeps fresh leader entries ahead of knife-wait slots', () => {
    expect(
      selectLeaderMirrorQuoteKeys({
        entries: [
          candidate(1, 1_000, false),
          candidate(2, 2_000, false),
          candidate(3, 3_000),
          candidate(4, 4_000),
        ],
        nowMs: 10_000,
        entryGraceMs: 60_000,
        maxQuoteMints: 3,
        knifeWaitQuoteSlots: 3,
        lastQuotedAtMs: new Map(),
      }),
    ).toEqual(['watch-1', 'watch-2', 'watch-3']);
  });

  it('does not let knife-wait displace a full fresh cap', () => {
    expect(
      selectLeaderMirrorQuoteKeys({
        entries: [
          candidate(1, 1_000, false),
          candidate(2, 2_000, false),
          candidate(3, 3_000, false),
          candidate(4, 4_000),
        ],
        nowMs: 10_000,
        entryGraceMs: 60_000,
        maxQuoteMints: 3,
        knifeWaitQuoteSlots: 3,
        lastQuotedAtMs: new Map(),
      }),
    ).toEqual(['watch-1', 'watch-2', 'watch-3']);
  });

  it('reports uncovered knife-wait observations', () => {
    const entries = [
      candidate(1, 1_000),
      candidate(2, 2_000),
      candidate(3, 3_000),
    ];
    expect(
      leaderMirrorQuoteCoverage(entries, new Set(['watch-1'])),
    ).toEqual({ waiting: 3, uncovered: 2 });
  });

  it('does not quote a knife-wait watch before its stale interval', () => {
    expect(
      selectLeaderMirrorQuoteKeys({
        entries: [candidate(1, 1_000, true, false)],
        nowMs: 10_000,
        entryGraceMs: 60_000,
        maxQuoteMints: 8,
        knifeWaitQuoteSlots: 3,
        lastQuotedAtMs: new Map([['watch-1', 9_000]]),
      }),
    ).toEqual([]);
  });

  it('keeps the knife request budget aggregate while rotating watches', () => {
    const entries = Array.from({ length: 24 }, (_, i) =>
      candidate(i, i + 1),
    );
    const lastQuotedAtMs = new Map<string, number>();
    const selectedOverTime: string[] = [];
    let intervalStart = 0;
    let requestsInInterval = 0;
    for (const nowMs of [0, 1_000, 2_000, 3_000, 4_000, 5_000, 6_000, 7_000, 8_000, 9_000]) {
      if (nowMs - intervalStart >= 5_000) {
        intervalStart = nowMs;
        requestsInInterval = 0;
      }
      const selected = selectLeaderMirrorQuoteKeys({
        entries,
        nowMs,
        entryGraceMs: 0,
        maxQuoteMints: 8,
        knifeWaitQuoteSlots: Math.max(0, 3 - requestsInInterval),
        lastQuotedAtMs,
      });
      const knifeSelected = selected.filter((key) => key.startsWith('watch-'));
      selectedOverTime.push(...knifeSelected);
      requestsInInterval += knifeSelected.length;
      for (const key of knifeSelected) lastQuotedAtMs.set(key, nowMs);
    }
    expect(selectedOverTime.slice(0, 3)).toHaveLength(3);
    expect(selectedOverTime.slice(3, 6)).toHaveLength(3);
    expect(new Set(selectedOverTime.slice(0, 3))).not.toEqual(
      new Set(selectedOverTime.slice(3, 6)),
    );
  });

  it('uses parked watches only after fresh and knife-wait candidates', () => {
    expect(
      selectLeaderMirrorQuoteKeys({
        entries: [
          candidate(1, 1_000, false),
          { ...candidate(2, 2_000), fundingParked: true },
          { ...candidate(3, 3_000, false), fundingParked: true },
        ],
        nowMs: 10_000,
        entryGraceMs: 60_000,
        maxQuoteMints: 2,
        knifeWaitQuoteSlots: 1,
        lastQuotedAtMs: new Map(),
      }),
    ).toEqual(['watch-1', 'watch-2']);
  });

  it('evicts the oldest parked watches over the cap', () => {
    expect(
      evictFundingParkedWatchKeys(
        [
          { watchKey: 'old', fundingParkedAtMs: 100 },
          { watchKey: 'new', fundingParkedAtMs: 200 },
          { watchKey: 'fresh' },
        ],
        1,
      ),
    ).toEqual(['old']);
  });
});

const at = (
  h = hit(),
  quote: number | null = 101,
  now = 110_000,
  start = 100_000,
  decisionGates = gates,
  leaderBuyTsMs: number | null | undefined = undefined,
  firstClipPending: boolean | undefined = undefined,
) =>
  evaluateLeaderMirrorObservation({
    hit: h,
    quotePriceUsd: quote,
    quoteTsMs: now,
    nowMs: now,
    watchStartedAtMs: start,
    gates: decisionGates,
    leaderBuyTsMs,
    firstClipPending,
  });

describe('mirror premium cap', () => {
  const caps = { maxPremiumPct: 1, entryGraceMaxPremiumPct: 5 };

  it('grants the grace cap only to the pending first clip', () => {
    expect(
      mirrorPremiumCapPct({ ...caps, entryGraceActive: true, firstClipPending: true }),
    ).toBe(5);
    expect(
      mirrorPremiumCapPct({ ...caps, entryGraceActive: true, firstClipPending: false }),
    ).toBe(1);
    expect(
      mirrorPremiumCapPct({ ...caps, entryGraceActive: false, firstClipPending: true }),
    ).toBe(1);
  });

  it('falls back to the steady cap when no grace cap is configured', () => {
    expect(
      mirrorPremiumCapPct({
        maxPremiumPct: 1,
        entryGraceActive: true,
        firstClipPending: true,
      }),
    ).toBe(1);
  });

  it('raises the cap only for green candles when configured', () => {
    expect(
      mirrorPremiumCapPct({
        maxPremiumPct: -0.5,
        greenMaxPremiumPct: 10,
        greenCandle: true,
        entryGraceActive: false,
        firstClipPending: true,
      }),
    ).toBe(10);
    expect(
      mirrorPremiumCapPct({
        maxPremiumPct: -0.5,
        greenMaxPremiumPct: 10,
        greenCandle: false,
        entryGraceActive: false,
        firstClipPending: true,
      }),
    ).toBe(-0.5);
    expect(
      mirrorPremiumCapPct({
        maxPremiumPct: -0.5,
        greenMaxPremiumPct: -1000,
        greenCandle: true,
        entryGraceActive: false,
        firstClipPending: true,
      }),
    ).toBe(-0.5);
  });

  it('measures the quote against the leader fill', () => {
    // Leg 2 of the production incident: +8.67% over the leader fill.
    expect(
      mirrorQuoteWithinPremiumCap({
        quotePriceUsd: 0.00016274565762032473,
        leaderFillPriceUsd: 0.00014976183514721602,
        maxPremiumPct: 1,
      }),
    ).toBe(false);
    expect(
      mirrorQuoteWithinPremiumCap({
        quotePriceUsd: 101,
        leaderFillPriceUsd: 100,
        maxPremiumPct: 1,
      }),
    ).toBe(true);
    // Unknown leader fill cannot block the buy; a missing quote always does.
    expect(
      mirrorQuoteWithinPremiumCap({
        quotePriceUsd: 101,
        leaderFillPriceUsd: null,
        maxPremiumPct: 1,
      }),
    ).toBe(true);
    expect(
      mirrorQuoteWithinPremiumCap({
        quotePriceUsd: 0,
        leaderFillPriceUsd: 100,
        maxPremiumPct: 1,
      }),
    ).toBe(false);
  });
});

describe('leader mirror observation decisions', () => {
  it('keeps optional momentum floors disabled at the sentinel', () => {
    expect(at(hit({ pc1h: -50, pc5m: -8 }))).toEqual({
      action: 'buy',
      quotePriceUsd: 101,
    });
  });

  it('buys without structural data when structural gates are disabled', () => {
    expect(
      at(
        hit({ liq: undefined, mcap: undefined, ageHours: undefined, pc5m: undefined }),
        101,
        110_000,
        100_000,
        {
          ...gates,
          structuralGatesEnabled: false,
          greenImpulsePct: 50,
        },
      ),
    ).toEqual({ action: 'buy', quotePriceUsd: 101 });
    expect(
      at(
        hit({ liq: undefined, mcap: undefined, ageHours: undefined, pc5m: undefined }),
        104,
        110_000,
        100_000,
        { ...gates, structuralGatesEnabled: false },
      ),
    ).toEqual({ action: 'wait', waitReason: 'premium_cap' });
  });

  it('applies the optional 5m volume floor and stays open when volume is unknown', () => {
    const volumeGates = { ...gates, minVol5mUsd: 2_000 };
    expect(at(hit({ vol5m: 1_999 }), 101, 110_000, 100_000, volumeGates)).toEqual({
      action: 'skip',
      reason: 'leader_mirror_vol5m_floor=1999<2000',
    });
    expect(at(hit({ vol5m: 2_001 }), 101, 110_000, 100_000, volumeGates)).toEqual({
      action: 'buy',
      quotePriceUsd: 101,
    });
    expect(at(hit({ vol5m: null }), 101, 110_000, 100_000, volumeGates)).toEqual({
      action: 'buy',
      quotePriceUsd: 101,
    });
  });

  it('refuses a 1h move below the configured floor', () => {
    expect(at(hit({ pc1h: 9 }), 101, 110_000, 100_000, {
      ...gates,
      minPc1hPct: 10,
    })).toEqual({
      action: 'skip',
      reason: 'leader_mirror_pc1h_too_low=9.00<10',
    });
  });

  it('admits candidates rejected only by age or market cap into the tier lane', () => {
    expect(at(hit({ ageHours: 0.25 }), 101, 110_000, 100_000, {
      ...gates,
      tierEnabled: true,
      minPairAgeHours: 1,
    })).toEqual({
      action: 'buy',
      quotePriceUsd: 101,
      mirrorBranch: 'tier',
    });
    expect(at(hit({ mcap: 4_000 }), 101, 110_000, 100_000, {
      ...gates,
      tierEnabled: true,
      minMcapUsd: 5_000,
    })).toEqual({
      action: 'buy',
      quotePriceUsd: 101,
      mirrorBranch: 'tier',
    });
    expect(at(hit({ ageHours: 0.25, mcap: 4_000 }), 101, 110_000, 100_000, {
      ...gates,
      tierEnabled: true,
      minPairAgeHours: 1,
      minMcapUsd: 5_000,
    })).toMatchObject({ action: 'buy', mirrorBranch: 'tier' });
  });

  it('keeps age and market-cap floors unchanged when tier is disabled', () => {
    expect(at(hit({ ageHours: 0.25 }), 101, 110_000, 100_000, {
      ...gates,
      minPairAgeHours: 1,
    })).toEqual({
      action: 'skip',
      reason: 'leader_mirror_pair_age_floor',
    });
    expect(at(hit({ mcap: 4_000 }), 101, 110_000, 100_000, {
      ...gates,
      minMcapUsd: 5_000,
    })).toEqual({
      action: 'skip',
      reason: 'leader_mirror_mcap_floor',
    });
  });

  it('does not admit liquidity failures into tier', () => {
    expect(at(hit({ liq: 7_999, ageHours: 0.25, mcap: 4_000 }), 101, 110_000, 100_000, {
      ...gates,
      tierEnabled: true,
      minLiquidityUsd: 8_000,
      minPairAgeHours: 1,
      minMcapUsd: 5_000,
    })).toEqual({
      action: 'skip',
      reason: 'leader_mirror_liquidity_floor',
    });
  });

  it('allows tier to ignore liquidity and pre-entry pc5m floors when configured', () => {
    const ignoreFloors = {
      ...gates,
      tierEnabled: true,
      tierIgnoreStructuralFloors: true,
      minLiquidityUsd: 8_000,
      minPreEntryPc5mPct: -5,
    };
    expect(at(hit({ liq: 7_999 }), 101, 110_000, 100_000, ignoreFloors)).toMatchObject({
      action: 'buy',
      mirrorBranch: 'tier',
    });
    expect(at(hit({ pc5m: -6 }), 101, 110_000, 100_000, ignoreFloors)).toMatchObject({
      action: 'buy',
      mirrorBranch: 'tier',
    });
    expect(at(hit({ pc5m: undefined }), 101, 110_000, 100_000, ignoreFloors)).toMatchObject({
      action: 'buy',
      mirrorBranch: 'tier',
    });
  });

  it('keeps liquidity and pre-entry pc5m floors hard without tier floor override', () => {
    expect(at(hit({ liq: 7_999 }), 101, 110_000, 100_000, {
      ...gates,
      tierEnabled: true,
      minLiquidityUsd: 8_000,
    })).toEqual({ action: 'skip', reason: 'leader_mirror_liquidity_floor' });
    expect(at(hit({ pc5m: -6 }), 101, 110_000, 100_000, {
      ...gates,
      tierEnabled: true,
      minPreEntryPc5mPct: -5,
    })).toEqual({
      action: 'skip',
      reason: 'leader_mirror_pc5m_too_deep=-6.00<-5',
    });
    expect(at(hit({ pc5m: undefined }), 101, 110_000, 100_000, {
      ...gates,
      tierEnabled: true,
      minPreEntryPc5mPct: -5,
    })).toEqual({ action: 'skip', reason: 'leader_mirror_pc5m_missing' });
  });

  it('refuses when the configured 1h floor has no metric', () => {
    expect(at(hit({ pc1h: undefined }), 101, 110_000, 100_000, {
      ...gates,
      minPc1hPct: 10,
    })).toEqual({
      action: 'skip',
      reason: 'leader_mirror_pc1h_missing',
    });
  });

  it('refuses a pre-entry 5m move deeper than the configured floor', () => {
    expect(at(hit({ pc5m: -11 }), 101, 110_000, 100_000, {
      ...gates,
      minPreEntryPc5mPct: -10,
    })).toEqual({
      action: 'skip',
      reason: 'leader_mirror_pc5m_too_deep=-11.00<-10',
    });
  });

  it('accepts candidates above both momentum floors and liquidity floor', () => {
    expect(at(hit({ pc1h: 10, pc5m: -9, liq: 40_000 }), 101, 110_000, 100_000, {
      ...gates,
      minPc1hPct: 10,
      minPreEntryPc5mPct: -10,
      minLiquidityUsd: 40_000,
    })).toEqual({
      action: 'buy',
      quotePriceUsd: 101,
    });
  });

  it('rejects stale and synthetic leader observations', () => {
    expect(leaderMirrorObservationFresh({ leaderBuyTsMs: null, nowMs: 120_000, maxAgeMs: 120_000 })).toBe(false);
    expect(leaderMirrorObservationFresh({ leaderBuyTsMs: 1, nowMs: 120_002, maxAgeMs: 120_000 })).toBe(false);
    expect(leaderMirrorObservationFresh({ leaderBuyTsMs: 100_000, nowMs: 110_000, maxAgeMs: 120_000 })).toBe(true);
  });

  it('still allows an accepted watch to buy after the observation-age threshold', () => {
    expect(
      at(hit({ pc5m: -10 }), 90, 700_000, 100_000, gates, 100_000),
    ).toEqual({
      action: 'buy',
      quotePriceUsd: 90,
      knifeWait: {
        enteredByDiscount: true,
        enteredByWindowExpiry: false,
        waitedMs: 600_000,
        leaderPc5m: -10,
        leaderFillPriceUsd: 100,
      },
    });
  });
  it('retries execution failures but suppresses genuine refusals', () => {
    expect(mirrorEntryAttemptOutcome('exec_failed')).toBe('retry');
    expect(mirrorEntryAttemptOutcome('skip')).toBe('refused');
    expect(mirrorEntryAttemptOutcome('filled')).toBe('filled');
    const result: EntryAttemptResult = 'exec_failed';
    expect(mirrorEntryAttemptOutcome(result)).toBe('retry');
    expect(mirrorEntryAttemptOutcome('no_funds')).toBe('parked');
    expect(isFundingShortageReason('usdc_exhausted')).toBe(true);
    expect(isFundingShortageReason('insufficient_usdc')).toBe(true);
    expect(isFundingShortageReason('insufficient_fee_sol')).toBe(true);
    expect(isFundingShortageReason('premium_cap')).toBe(false);
    expect(fundingShortageEntryResult(true, 'insufficient_fee_sol')).toBe(
      'no_funds',
    );
    expect(fundingShortageEntryResult(true, 'usdc_exhausted')).toBe('no_funds');
    expect(fundingShortageEntryResult(false, 'insufficient_fee_sol')).toBe(
      'skip',
    );
    expect(fundingShortageEntryResult(false, 'usdc_exhausted')).toBe('stop');
  });

  it('treats a missing Dex snapshot as retryable, other vetoes as final', () => {
    expect(
      mirrorEntryStructuralDataVetoIsTransient([
        'mirror_missing_live_structural_data',
      ]),
    ).toBe(true);
    expect(
      mirrorEntryStructuralDataVetoIsTransient([
        'mirror_missing_live_structural_data',
        'liquidity_floor',
      ]),
    ).toBe(false);
    expect(mirrorEntryStructuralDataVetoIsTransient(['liquidity_floor'])).toBe(
      false,
    );
    expect(mirrorEntryStructuralDataVetoIsTransient([])).toBe(false);
  });
  it('buys after a fresh quote on a dump', () => {
    expect(at()).toEqual({ action: 'buy', quotePriceUsd: 101 });
  });

  it('waits for a deep-knife discount during the wait window', () => {
    expect(at(hit({ pc5m: -10 }), 100, 200_000, 100_000, gates, 100_000)).toEqual({
      action: 'wait',
      waitReason: 'knife_discount',
    });
    expect(at(hit({ pc5m: -10 }), 95, 200_000, 100_000, gates, 100_000)).toMatchObject({
      action: 'buy',
      quotePriceUsd: 95,
      knifeWait: {
        enteredByDiscount: true,
        enteredByWindowExpiry: false,
      },
    });
  });

  it('uses blockTime for knife waiting without enabling entry grace', () => {
    expect(at(hit({ pc5m: -10, blockTime: 100 }), 100, 200_000)).toEqual({
      action: 'wait',
      waitReason: 'knife_discount',
    });
    expect(
      at(
        hit({ pc5m: -10, blockTime: 100 }),
        102.5,
        700_001,
        100_000,
        { ...gates, entryGraceMaxPremiumPct: 3 },
      ),
    ).toMatchObject({
      action: 'skip',
      reason: 'leader_mirror_premium_cap',
    });
  });

  it('pays the entry-grace premium on the first clip instead of waiting out the knife', () => {
    const prod = {
      ...gates,
      requireDipCandle: false,
      retryWhileLeaderHolds: true,
      entryGraceMaxPremiumPct: 5,
    };
    // 30 s after the leader fill: +3% premium is inside the grace cap.
    expect(at(hit({ pc5m: -10 }), 103, 130_000, 100_000, prod, 100_000)).toEqual({
      action: 'buy',
      quotePriceUsd: 103,
    });
    // Above the grace cap the knife wait keeps holding the entry.
    expect(at(hit({ pc5m: -10 }), 106, 130_000, 100_000, prod, 100_000)).toEqual({
      action: 'wait',
      waitReason: 'knife_discount',
    });
    // Without a knife the grace cap itself is the boundary.
    expect(at(hit({ pc5m: -5 }), 106, 130_000, 100_000, prod, 100_000)).toEqual({
      action: 'wait',
      waitReason: 'premium_cap',
    });
    expect(at(hit({ pc5m: -5 }), 104, 130_000, 100_000, prod, 100_000)).toEqual({
      action: 'buy',
      quotePriceUsd: 104,
    });
    // Past the grace window the knife wait still holds the entry.
    expect(at(hit({ pc5m: -10 }), 103, 200_000, 100_000, prod, 100_000)).toEqual({
      action: 'wait',
      waitReason: 'knife_discount',
    });
  });

  it('keeps the steady premium cap once the first clip leg is filled', () => {
    const prod = {
      ...gates,
      requireDipCandle: false,
      retryWhileLeaderHolds: true,
      maxPremiumPct: 1,
      entryGraceMaxPremiumPct: 5,
    };
    // Same instant and same +3% quote as the first leg, but the clip already
    // has a filled leg: only the steady +1% cap applies.
    expect(
      at(hit({ pc5m: -5 }), 103, 130_000, 100_000, prod, 100_000, false),
    ).toEqual({ action: 'wait', waitReason: 'premium_cap' });
    expect(
      at(hit({ pc5m: -5 }), 100.5, 130_000, 100_000, prod, 100_000, false),
    ).toEqual({ action: 'buy', quotePriceUsd: 100.5 });
    // A knife cannot be bypassed by the grace cap for a follow-up buy either.
    expect(
      at(hit({ pc5m: -10 }), 103, 130_000, 100_000, prod, 100_000, false),
    ).toEqual({ action: 'wait', waitReason: 'knife_discount' });
  });

  it('leaves shallow dips unchanged and waits on green leaders', () => {
    expect(at(hit({ pc5m: -5 }), 101, 200_000, 100_000, gates, 100_000)).toEqual({
      action: 'buy',
      quotePriceUsd: 101,
    });
    const green = { ...gates, maxEntryPc5mPct: 100, requireDipCandle: false };
    expect(at(hit({ pc5m: 5 }), 100, 200_000, 100_000, green, 100_000)).toEqual({
      action: 'wait',
      waitReason: 'knife_discount',
    });
  });

  it('falls back to the ordinary entry after the knife wait expires', () => {
    expect(at(hit({ pc5m: -10 }), 101, 800_001, 100_000, gates, 100_000)).toMatchObject({
      action: 'buy',
      quotePriceUsd: 101,
      knifeWait: {
        enteredByDiscount: false,
        enteredByWindowExpiry: true,
      },
    });
    expect(at(hit({ pc5m: -10 }), 93, 800_001, 100_000, gates, 100_000)).toMatchObject({
      action: 'buy',
      knifeWait: {
        enteredByDiscount: true,
        enteredByWindowExpiry: false,
      },
    });
  });

  it('fails open when the leader purchase timestamp is unavailable', () => {
    expect(at(hit({ pc5m: -10 }), 101)).toEqual({
      action: 'buy',
      quotePriceUsd: 101,
    });
  });

  it('rejects green impulse and run-up', () => {
    expect(at(hit(), 106)).toMatchObject({ action: 'skip', reason: 'leader_mirror_green_impulse' });
    expect(at(hit(), 106, 110_000, 100_000, { ...gates, retryWhileLeaderHolds: true }))
      .toEqual({ action: 'wait', waitReason: 'premium_cap' });
    expect(at(hit({ pc5m: 10 }), 101)).toMatchObject({ action: 'skip', reason: 'leader_mirror_green_direction' });
  });

  it('allows configured premium for green candles but not dips', () => {
    const greenPremiumGates = {
      ...gates,
      requireDipCandle: false,
      maxEntryPc5mPct: 1_000,
      greenMaxPremiumPct: 10,
    };
    expect(at(hit({ pc5m: 5 }), 108, 110_000, 100_000, greenPremiumGates)).toEqual({
      action: 'buy',
      quotePriceUsd: 108,
    });
    expect(at(hit({ pc5m: -5 }), 108, 110_000, 100_000, greenPremiumGates)).toEqual({
      action: 'wait',
      waitReason: 'premium_cap',
    });
  });

  it('allows green premium during knife-wait after entry grace expires', () => {
    const knifePremiumGates = {
      ...gates,
      requireDipCandle: false,
      maxEntryPc5mPct: 1_000,
      greenMaxPremiumPct: 10,
    };
    expect(
      at(
        hit({ pc5m: 5, blockTime: 109 }),
        108,
        110_000,
        100_000,
        knifePremiumGates,
        undefined,
      ),
    ).toEqual({ action: 'buy', quotePriceUsd: 108 });
    expect(
      at(
        hit({ pc5m: -11, blockTime: 109 }),
        108,
        110_000,
        100_000,
        knifePremiumGates,
        undefined,
      ),
    ).toEqual({ action: 'wait', waitReason: 'knife_discount' });
  });

  it('waits through premium and refuses after the window', () => {
    expect(at(hit(), 103, 110_000)).toEqual({ action: 'wait', waitReason: 'premium_cap' });
    expect(at(hit(), 103, 150_000)).toMatchObject({ action: 'skip', reason: 'leader_mirror_premium_cap' });
  });

  it('allows a small premium during the leader-buy grace window', () => {
    expect(at(hit(), 100.9, 110_000, 100_000, {
      ...gates,
      maxPremiumPct: -1,
      retryWhileLeaderHolds: true,
    }, 100_000)).toEqual({ action: 'buy', quotePriceUsd: 100.9 });
    expect(at(hit(), 101.5, 110_000, 100_000, {
      ...gates,
      maxPremiumPct: -1,
      retryWhileLeaderHolds: true,
    }, 100_000)).toEqual({ action: 'wait', waitReason: 'premium_cap' });
    expect(at(hit(), 99.5, 160_001, 100_000, {
      ...gates,
      maxPremiumPct: -1,
      retryWhileLeaderHolds: true,
    }, 100_000)).toEqual({ action: 'wait', waitReason: 'premium_cap' });
    expect(at(hit(), 98.5, 160_001, 100_000, {
      ...gates,
      maxPremiumPct: -1,
      retryWhileLeaderHolds: true,
    }, 100_000)).toEqual({ action: 'buy', quotePriceUsd: 98.5 });
  });

  it('does not apply grace without a leader-buy timestamp', () => {
    expect(at(hit(), 100.9, 110_000, 100_000, {
      ...gates,
      maxPremiumPct: -1,
    })).toEqual({ action: 'wait', waitReason: 'premium_cap' });
  });

  it('allows unknown pc5m while failing closed without structural data or a quote', () => {
    expect(at(hit({ pc5m: undefined }), 101)).toEqual({ action: 'buy', quotePriceUsd: 101 });
    expect(at(hit(), null, 150_000, 100_000)).toMatchObject({ action: 'skip', reason: 'leader_mirror_no_data' });
  });

  it('gracefully waits for a leader fill, then rejects the non-buy hit', () => {
    const missingFill = hit({ fillPriceUsd: undefined, blockTime: 100 });
    expect(at(missingFill, 101, 150_000, 100_000)).toEqual({
      action: 'wait',
      waitReason: 'no_structural',
    });
    expect(at(missingFill, 101, 161_000, 100_000)).toEqual({
      action: 'skip',
      reason: 'leader_mirror_no_leader_fill',
    });
  });

  it('rejects known leader transfers below the configured size floor', () => {
    const guarded = { ...gates, minLeaderSizeUsd: 20 };
    expect(at(hit({ sizeUsd: 0.02 }), 99, 110_000, 100_000, guarded)).toEqual({
      action: 'skip',
      reason: 'leader_mirror_leader_size_floor',
    });
    expect(at(hit({ sizeUsd: 200 }), 98.8, 110_000, 100_000, guarded)).toEqual({
      action: 'buy',
      quotePriceUsd: 98.8,
    });
    expect(at(hit({ sizeUsd: 0.02 }), 98.8, 110_000, 100_000, {
      ...guarded,
      minLeaderSizeUsd: 0,
    })).toEqual({
      action: 'buy',
      quotePriceUsd: 98.8,
    });
  });

  it('rejects adds and other wallets', () => {
    expect(at(hit({ isAdd: true }))).toMatchObject({ action: 'skip', reason: 'leader_mirror_add' });
    expect(at(hit({ leader: 'other' }))).toMatchObject({ action: 'skip', reason: 'leader_mirror_wallet' });
  });

  it('accepts either configured leader and retries soft quality refusals', () => {
    const retry = {
      ...gates,
      leaders: [LEADER_MIRROR_WALLET, SECOND_LEADER],
      retryWhileLeaderHolds: true,
      minMcapUsd: 120_000,
    };
    expect(at(hit({ leader: SECOND_LEADER, mcap: 200_000 }), 101, 110_000, 100_000, retry)).toMatchObject({ action: 'buy' });
    expect(at(hit({ leader: 'third' }))).toMatchObject({ action: 'skip', reason: 'leader_mirror_wallet' });
    expect(at(hit({ mcap: 119_999 }), 90, 150_000, 100_000, retry)).toMatchObject({
      action: 'skip',
      reason: 'leader_mirror_mcap_floor',
    });
    expect(at(hit({ mcap: null }), 90, 150_000, 100_000, retry)).toEqual({
      action: 'wait',
      waitReason: 'no_structural',
    });
    expect(at(hit({ ageHours: 3.9 }), 90, 150_000, 100_000, { ...retry, minPairAgeHours: 4 }))
      .toMatchObject({ action: 'skip', reason: 'leader_mirror_pair_age_floor' });
    expect(at(hit({ ageHours: null, mcap: 200_000 }), 90, 150_000, 100_000, { ...retry, minPairAgeHours: 4 }))
      .toEqual({ action: 'wait', waitReason: 'no_structural' });
    expect(at(hit({ ageHours: 4, mcap: 200_000 }), 99, 150_000, 100_000, { ...retry, minPairAgeHours: 4 }))
      .toMatchObject({ action: 'buy' });
  });

  it('can accept any candle direction when dip-candle gating is disabled', () => {
    const noDip = { ...gates, requireDipCandle: false, maxPremiumPct: -1 };
    expect(at(hit({ pc5m: 12 }), 98.8, 110_000, 100_000, noDip)).toEqual({
      action: 'skip',
      reason: 'leader_mirror_green_direction',
    });
    expect(at(hit({ pc5m: 12 }), 99.6, 110_000, 100_000, noDip)).toEqual({
      action: 'skip',
      reason: 'leader_mirror_green_direction',
    });
    expect(at(hit({ pc5m: undefined }), 98.8, 110_000, 100_000, noDip)).toEqual({
      action: 'buy',
      quotePriceUsd: 98.8,
    });
    expect(at(hit({ mcap: undefined, pc5m: 12 }), 98.8, 110_000, 100_000, noDip)).toEqual({
      action: 'wait',
      waitReason: 'no_structural',
    });
    expect(at(hit({ ageHours: undefined, pc5m: 12 }), 98.8, 110_000, 100_000, noDip)).toEqual({
      action: 'wait',
      waitReason: 'no_structural',
    });
    expect(at(hit({ liq: undefined, pc5m: 12 }), 98.8, 110_000, 100_000, noDip)).toEqual({
      action: 'wait',
      waitReason: 'no_structural',
    });
  });

  it('rejects green leader direction but accepts a dump', () => {
    expect(at(hit({ pc5m: 0.01 }), 98.8)).toEqual({
      action: 'skip',
      reason: 'leader_mirror_green_direction',
    });
    expect(at(hit({ pc5m: -0.01 }), 98.8)).toEqual({
      action: 'buy',
      quotePriceUsd: 98.8,
    });
    expect(at(hit({ pc5m: undefined }), 98.8)).toEqual({
      action: 'buy',
      quotePriceUsd: 98.8,
    });
  });

  it('suppresses a repeated refusal for the same hit and caps quote fanout', () => {
    const current = hit({ signature: 'sig-1' });
    expect(
      leaderMirrorDecisionSuppressed({
        hit: current,
        hitKey: leaderMirrorHitKey(current),
        decidedAtMs: 100_000,
        nowMs: 110_000,
        cooldownMs: 900_000,
      }),
    ).toBe(true);
    expect(
      leaderMirrorDecisionSuppressed({
        hit: { ...current, lastSeenAtMs: 100_001 },
        hitKey: leaderMirrorHitKey(current),
        decidedAtMs: 100_000,
        nowMs: 110_000,
        cooldownMs: 900_000,
      }),
    ).toBe(false);
    expect(leaderMirrorQuoteMintsCap(20, 50)).toBe(20);
    expect(leaderMirrorQuoteMintsCap(3, 8)).toBe(3);
  });

  it('retains mirror observations for the full knife wait window', () => {
    expect(leaderMirrorObservationWindowMs({
      observeMs: 45_000,
      knifeWaitEnabled: true,
      knifeWaitWindowMs: 600_000,
      tickIntervalMs: 2_000,
    })).toBe(602_000);
    expect(leaderMirrorObservationWindowMs({
      observeMs: 86400000,
      knifeWaitEnabled: true,
      knifeWaitWindowMs: 600_000,
      tickIntervalMs: 2_000,
    })).toBe(86400000);
  });

  it('uses the same hit-key suppression for execution skips', () => {
    const current = hit({ signature: 'execution-skip' });
    const hitKey = leaderMirrorHitKey(current);
    expect(
      leaderMirrorDecisionSuppressed({
        hit: current,
        hitKey,
        decidedAtMs: 100_000,
        nowMs: 110_000,
        cooldownMs: 900_000,
      }),
    ).toBe(true);
    expect(
      leaderMirrorDecisionSuppressed({
        hit: { ...current, lastSeenAtMs: 100_001 },
        hitKey,
        decidedAtMs: 100_000,
        nowMs: 110_000,
        cooldownMs: 900_000,
      }),
    ).toBe(false);
  });

  it('is silent when disabled and uses the mirror exit profile', () => {
    expect(at(hit(), 101, 110_000, 100_000, {
      ...gates,
      enabled: false,
    })).toMatchObject({ action: 'skip', reason: 'leader_mirror_disabled' });
    const decision = decideMarkExit({
      pos: {
        mint: hit().mint,
        symbol: 'MIRROR',
        entryPriceUsd: 100,
        sizeUsd: 2,
        tokenRaw: '1',
        openedAtMs: 0,
        lane: 'leader_mirror',
        peakPriceUsd: 106,
        trailArmed: true,
      },
      markPriceUsd: 103,
      nowMs: 120_000,
      gates: {
        markJumpConfirmPct: 25,
        markJumpConfirmStreamPct: 8,
      },
      mirrorGates: {
        trailEnabled: true,
        takeProfitPct: 0,
        armPct: 2,
        trailPct: 4,
        stopPct: 45,
        maxHoldMs: 3_600_000,
        noMoveCutMs: 600_000,
        noMoveMinMfePct: 2,
      },
    });
    expect(decision.tpRungIndex).toBeNull();
    expect(decision.shouldExit).toBe(false);
  });

  it('supports strict deep-dump mode', () => {
    const strict = { ...gates, requireDeepDump: true };
    expect(evaluateLeaderMirrorObservation({
      hit: hit({ pc5m: -4 }),
      quotePriceUsd: 101,
      quoteTsMs: 110_000,
      nowMs: 110_000,
      watchStartedAtMs: 100_000,
      gates: strict,
    })).toMatchObject({ action: 'skip', reason: 'leader_mirror_deep_dump_required' });
    expect(evaluateLeaderMirrorObservation({
      hit: hit({ pc5m: -4 }),
      quotePriceUsd: 101,
      quoteTsMs: 110_000,
      nowMs: 110_000,
      watchStartedAtMs: 100_000,
      gates: { ...strict, retryWhileLeaderHolds: true },
    })).toEqual({ action: 'wait', waitReason: 'not_dip' });
  });

  it('copies a green candidate inside the configured corridor', () => {
    const green = { ...gates, greenCopyEnabled: true, greenCorridorPct: 1.5, maxEntryPc5mPct: 100 };
    expect(at(hit({ pc5m: 8 }), 101.5, 110_000, 100_000, green)).toEqual({
      action: 'buy',
      quotePriceUsd: 101.5,
      mirrorBranch: 'green',
    });
  });

  it('keeps green candidates below structural floors out of the primary lane', () => {
    const green = {
      ...gates,
      greenCopyEnabled: true,
      greenCorridorPct: 1.5,
      maxEntryPc5mPct: 100,
      tierEnabled: true,
    };
    expect(at(hit({ pc5m: 8, mcap: 4_000 }), 101.5, 110_000, 100_000, green)).toEqual({
      action: 'buy',
      quotePriceUsd: 101.5,
      mirrorBranch: 'tier',
    });
    expect(at(hit({ pc5m: 8, mcap: 4_000 }), 101.5, 110_000, 100_000, {
      ...green,
      tierEnabled: false,
    })).toEqual({
      action: 'skip',
      reason: 'leader_mirror_mcap_floor',
    });
  });

  it('waits outside the green corridor until observe expires', () => {
    const green = { ...gates, greenCopyEnabled: true, greenCorridorPct: 1.5, maxEntryPc5mPct: 100 };
    expect(at(hit({ pc5m: 8 }), 103, 110_000, 100_000, green)).toEqual({ action: 'wait', waitReason: 'green_corridor' });
    expect(at(hit({ pc5m: 8 }), 103, 150_000, 100_000, green)).toMatchObject({
      action: 'skip',
      reason: 'leader_mirror_green_corridor',
    });
  });

  it('rejects green blow-off movement before considering the corridor', () => {
    const green = { ...gates, greenCopyEnabled: true, greenCopyMaxPc5mPct: 40, maxEntryPc5mPct: 100 };
    expect(at(hit({ pc5m: 40 }), 100, 110_000, 100_000, green)).toMatchObject({
      action: 'skip',
      reason: 'leader_mirror_green_blowoff',
    });
  });

  it('keeps structural floors ahead of green corridor decisions', () => {
    const green = { ...gates, greenCopyEnabled: true, greenCorridorPct: 1.5, maxEntryPc5mPct: 100 };
    expect(at(hit({ pc5m: 8, liq: 7_999 }), 105, 110_000, 100_000, green)).toMatchObject({
      action: 'skip',
      reason: 'leader_mirror_liquidity_floor',
    });
  });

  it('preserves the legacy green refusals when green copying is disabled', () => {
    expect(at(hit({ pc5m: 10 }), 101, 110_000, 100_000, gates)).toMatchObject({
      action: 'skip',
      reason: 'leader_mirror_green_direction',
    });
    expect(at(hit({ pc5m: 1 }), 101, 110_000, 100_000, gates)).toMatchObject({
      action: 'skip',
      reason: 'leader_mirror_green_direction',
    });
  });
});
