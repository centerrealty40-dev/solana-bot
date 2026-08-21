import { describe, expect, it } from 'vitest';
import { decideMarkExit } from '../../src/milddip/exit-engine.js';
import { settleAfterSuccessfulSell } from '../../src/milddip/sell-settle.js';

const gates = {
  trailEnabled: true,
  takeProfitPct: 0,
  armPct: 2,
  trailPct: 4,
  stopPct: 10,
  maxHoldMs: 86_400_000,
  noMoveCutMs: 600_000,
  noMoveMinMfePct: 2,
  leaderSellOnly: true,
  safetyMaxHoldMs: 86_400_000,
  ladderStepPct: 5,
  ladderStepAfterAveragePct: 10,
  ladderSellFraction: 0.2,
  ladderDustUsd: 1,
} as any;

const position = (overrides: Record<string, unknown> = {}) => ({
  mint: 'mint',
  symbol: 'MIRROR',
  entryPriceUsd: 100,
  sizeUsd: 10,
  tokenRaw: '1000000',
  openedAtMs: 0,
  lane: 'leader_mirror',
  peakPriceUsd: 100,
  trailArmed: false,
  ...overrides,
});

const at = (markPriceUsd: number, overrides: Record<string, unknown> = {}) =>
  decideMarkExit({
    mint: 'mint',
    pos: position(overrides),
    markPriceUsd,
    nowMs: 1_000,
    mirrorGates: gates,
    gates: {
      armPct: 2,
      partialGivebackPct: 3,
      scaleOutFraction: 0.5,
      givebackPct: 8,
      mfeBankEnabled: false,
      mfeBank1Pct: 8,
      mfeBank1Fraction: 0.4,
      mfeBank2Pct: 15,
      mfeBank2Fraction: 0.4,
      mfeBankSleeveGivebackPct: 12,
      tpGridStepPct: 0,
    } as any,
  });

describe('mirror TP ladder', () => {
  it('fires at +5%, not at +4.9%, and sells 20% of the runner', () => {
    expect(at(104.9)?.shouldExit).toBe(false);
    const decision = at(105);
    expect(decision).toMatchObject({
      shouldExit: true,
      reason: 'mirror_tp_ladder',
      tpRungIndex: 1,
    });
    expect(decision?.fraction).toBeCloseTo(0.2);
  });

  it('combines owed rungs geometrically and records the last rung', () => {
    expect(at(116)).toMatchObject({
      fraction: 1 - Math.pow(0.8, 3),
      tpRungIndex: 3,
    });
    expect(at(116, { mirrorLadderRungsDone: 2 })?.tpRungIndex).toBe(3);
    expect(at(116, { mirrorLadderRungsDone: 3 })?.shouldExit).toBe(false);
  });

  it('keeps a $10 clip open after five ladder rungs', () => {
    const decision = at(125, { sizeUsd: 10 });
    expect(decision?.tpRungIndex).toBe(5);
    expect(decision?.fraction).toBeLessThan(1);
    expect(decision?.shouldExit).toBe(true);
  });

  it('uses a fresh 10% basis and resets rungs after averaging', () => {
    expect(at(109, {
      mirrorAverageDone: true,
      mirrorLadderBasisPriceUsd: 100,
      mirrorLadderRungsDone: 0,
    })?.shouldExit).toBe(false);
    expect(at(110, {
      mirrorAverageDone: true,
      mirrorLadderBasisPriceUsd: 100,
      mirrorLadderRungsDone: 0,
    })).toMatchObject({ tpRungIndex: 1 });
    expect(at(110, {
      mirrorAverageDone: true,
      mirrorLadderBasisPriceUsd: 100,
      mirrorLadderRungsDone: 0,
    })?.fraction).toBeCloseTo(0.2);
  });

  it('closes a remainder below the dust threshold', () => {
    expect(at(115, { sizeUsd: 1.2 })).toMatchObject({
      fraction: 1,
      reason: 'mirror_tp_ladder',
    });
  });

  it('uses current market value, not cost basis, for the dust decision', () => {
    expect(at(130, { sizeUsd: 1.2 })?.fraction).toBe(1);
    expect(at(105, { sizeUsd: 1.2 })?.fraction).toBeLessThan(1);
  });

  it('suppresses ordinary exits while leader-sell-only is active', () => {
    const decision = at(102, { peakPriceUsd: 110, trailArmed: true });
    expect(decision?.shouldExit).toBe(false);
    expect(decision?.reason).toBeNull();
  });
});

describe('mirror partial settlement', () => {
  it('keeps a partial mirror position open with reduced balance', () => {
    const before = 100_000n;
    const sold = 20_000n;
    const settled = settleAfterSuccessfulSell({
      fraction: 0.2,
      beforeRaw: before,
      remainingRaw: before - sold,
    });
    expect(settled).toMatchObject({
      action: 'keep_runner',
      reason: 'partial_intent',
      remainingRaw: 80_000n,
    });
    const sizeUsd = 10 * (1 - 0.2);
    expect(sizeUsd).toBe(8);
  });
});
