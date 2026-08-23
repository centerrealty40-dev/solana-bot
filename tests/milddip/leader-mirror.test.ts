import { describe, expect, it } from 'vitest';
import {
  evaluateLeaderMirrorObservation,
  leaderMirrorDecisionSuppressed,
  LEADER_MIRROR_WALLET,
  leaderMirrorHitKey,
  leaderMirrorObservationWindowMs,
  leaderMirrorQuoteMintsCap,
  leaderMirrorQuoteCoverage,
  selectLeaderMirrorQuoteKeys,
  type LeaderMirrorGates,
} from '../../src/milddip/leader-mirror.js';
import { decideMarkExit } from '../../src/milddip/exit-engine.js';
import {
  mirrorEntryAttemptOutcome,
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
});

const at = (
  h = hit(),
  quote: number | null = 101,
  now = 110_000,
  start = 100_000,
  decisionGates = gates,
  leaderBuyTsMs: number | null | undefined = undefined,
) =>
  evaluateLeaderMirrorObservation({
    hit: h,
    quotePriceUsd: quote,
    quoteTsMs: now,
    nowMs: now,
    watchStartedAtMs: start,
    gates: decisionGates,
    leaderBuyTsMs,
  });

describe('leader mirror observation decisions', () => {
  it('retries execution failures but suppresses genuine refusals', () => {
    expect(mirrorEntryAttemptOutcome('exec_failed')).toBe('retry');
    expect(mirrorEntryAttemptOutcome('skip')).toBe('refused');
    expect(mirrorEntryAttemptOutcome('filled')).toBe('filled');
    const result: EntryAttemptResult = 'exec_failed';
    expect(mirrorEntryAttemptOutcome(result)).toBe('retry');
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
