import { describe, expect, it } from 'vitest';
import {
  evaluateLeaderMirrorObservation,
  leaderMirrorDecisionSuppressed,
  LEADER_MIRROR_WALLET,
  leaderMirrorHitKey,
  leaderMirrorQuoteMintsCap,
  type LeaderMirrorGates,
} from '../../src/milddip/leader-mirror.js';
import { decideMarkExit } from '../../src/milddip/exit-engine.js';

const gates: LeaderMirrorGates = {
  enabled: true,
  leaders: [LEADER_MIRROR_WALLET],
  hitMaxAgeMs: 45_000,
  observeMs: 45_000,
  quoteMaxAgeMs: 10_000,
  greenImpulsePct: 5,
  runUpPc5mPct: 10,
  maxPremiumPct: 2,
  maxPreEntryPc5mPct: 0,
  requireDeepDump: false,
  deepDumpPc5mPct: -8,
  minLiquidityUsd: 8_000,
  minPairAgeHours: 0.5,
  minMcapUsd: 5_000,
  maxOpen: 3,
  maxQuoteMints: 8,
  positionUsd: 2,
  cooldownMs: 900_000,
};

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

const at = (
  h = hit(),
  quote: number | null = 101,
  now = 110_000,
  start = 100_000,
  decisionGates = gates,
) =>
  evaluateLeaderMirrorObservation({
    hit: h,
    quotePriceUsd: quote,
    quoteTsMs: now,
    nowMs: now,
    watchStartedAtMs: start,
    gates: decisionGates,
  });

describe('leader mirror observation decisions', () => {
  it('buys after a fresh quote on a dump', () => {
    expect(at()).toEqual({ action: 'buy', quotePriceUsd: 101 });
  });

  it('rejects green impulse and run-up', () => {
    expect(at(hit(), 106)).toMatchObject({ action: 'skip', reason: 'leader_mirror_green_impulse' });
    expect(at(hit({ pc5m: 10 }), 101)).toMatchObject({ action: 'skip', reason: 'leader_mirror_run_up' });
  });

  it('waits through premium and refuses after the window', () => {
    expect(at(hit(), 103, 110_000)).toEqual({ action: 'wait' });
    expect(at(hit(), 103, 150_000)).toMatchObject({ action: 'skip', reason: 'leader_mirror_premium_cap' });
  });

  it('fails closed without classification data or a quote', () => {
    expect(at(hit({ pc5m: undefined }))).toMatchObject({ action: 'skip', reason: 'leader_mirror_no_data' });
    expect(at(hit(), null, 150_000, 100_000)).toMatchObject({ action: 'skip', reason: 'leader_mirror_no_data' });
  });

  it('rejects adds and other wallets', () => {
    expect(at(hit({ isAdd: true }))).toMatchObject({ action: 'skip', reason: 'leader_mirror_add' });
    expect(at(hit({ leader: 'other' }))).toMatchObject({ action: 'skip', reason: 'leader_mirror_wallet' });
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
    expect(leaderMirrorQuoteMintsCap(20, 50)).toBe(8);
    expect(leaderMirrorQuoteMintsCap(3, 8)).toBe(3);
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
  });
});
