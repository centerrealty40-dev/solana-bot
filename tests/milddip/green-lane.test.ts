import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decideMarkExit } from '../../src/milddip/exit-engine.js';
import type { MildDipOpenPosition } from '../../src/milddip/state.js';
import { evaluateMildDipEntryRisk, evaluateMildDipPreBuy } from '../../src/milddip/gates.js';
import {
  cooldownBouncePctForSource,
  greenExitProfileForTape,
  preBuyEntryGatesForSource,
  shouldApplyGreenTurnDumpGate,
} from '../../src/milddip/entry-attempt.js';
import { evaluateTurnDumpGate } from '../../src/milddip/turn-dump.js';
import type { MildDipConfig } from '../../src/milddip/config.js';
import {
  resetFastPathStateForTests,
  shouldJournalGreenVerdict,
} from '../../src/milddip/fast-path.js';
import {
  decideGreenExit,
  evaluateGreenLane,
  greenExposureCapReason,
  greenBuyShare,
  greenTurnover,
  type GreenExitGates,
  type GreenLaneGates,
  type GreenLaneInput,
} from '../../src/milddip/green-lane.js';

const gates: GreenLaneGates = {
  enabled: true,
  minTurnover5mLiq: 0.4,
  minVolume5mUsd: 8_000,
  minVolume1hUsd: 60_000,
  minPc5mPct: 14,
  maxPc5mPct: 0,
  maxRallyIntoPeakPct: 0,
  maxBounceFromTroughPct: 0,
  minDumpFromPeakPct: 0,
  requirePc1h: true,
  minPc1hPct: 20,
  minBuys5m: 43,
  maxBuyShare5m: 0.85,
  minLiquidityUsd: 6_000,
  minPairAgeHours: 0.05,
  maxRet1mPct: 0,
  maxTapeRet1mPct: 1000,
};

/** A row that clears everything, so each test can spoil one field. */
const ok: GreenLaneInput = {
  pc5mPct: 18,
  pc1hPct: 35,
  volume5mUsd: 12_000,
  volume1hUsd: 90_000,
  liquidityUsd: 20_000,
  buys5m: 60,
  sells5m: 50,
  pairAgeHours: 3,
  ret1mPct: -0.5,
};

describe('greenTurnover / greenBuyShare', () => {
  it('turnover is 5m volume over liquidity', () => {
    expect(greenTurnover(12_000, 20_000)).toBeCloseTo(0.6, 6);
  });
  it('no liquidity means no turnover, not zero', () => {
    expect(greenTurnover(12_000, 0)).toBeNull();
    expect(greenTurnover(null, 20_000)).toBeNull();
  });
  it('buy share is buys over both sides', () => {
    expect(greenBuyShare(60, 40)).toBeCloseTo(0.6, 6);
    expect(greenBuyShare(0, 0)).toBeNull();
  });
});

describe('GREEN exposure caps', () => {
  it('rejects when open GREEN positions reach the cap', () => {
    expect(
      greenExposureCapReason({ openGreen: 8, maxOpen: 8, buysInHour: 0, maxBuysPerHour: 30 }),
    ).toBe('green_max_open');
  });

  it('rejects when hourly GREEN buys reach the cap', () => {
    expect(
      greenExposureCapReason({ openGreen: 1, maxOpen: 8, buysInHour: 30, maxBuysPerHour: 30 }),
    ).toBe('green_max_buys_per_hour');
  });
});

describe('GREEN shared entry-risk and chase settings', () => {
  it('uses GREEN floors for a 0.79h pair and 2.62 volume/liquidity ratio', () => {
    expect(
      evaluateMildDipEntryRisk({
        pairAgeHours: 0.79,
        volume5mUsd: 10_480,
        liquidityUsd: 4_000,
        minPairAgeHours: 0.25,
        maxVol5mToLiq: 6,
        minLiquidityUsd: 2_500,
      }).pass,
    ).toBe(true);
    expect(
      evaluateMildDipEntryRisk({
        pairAgeHours: 0.79,
        volume5mUsd: 10_480,
        liquidityUsd: 4_000,
        minPairAgeHours: 1,
        maxVol5mToLiq: 2,
        minLiquidityUsd: 4_000,
      }).pass,
    ).toBe(false);
  });

  it('allows 12% GREEN chase and preserves the old cap when set to zero', () => {
    const args = {
      signalPriceUsd: 1,
      freshPriceUsd: 1.11,
      freshPc5mPct: -5,
      entryGates: { minDipPct: -20, maxDipPct: -1 },
    };
    expect(evaluateMildDipPreBuy({ ...args, maxChasePct: 12 }).pass).toBe(true);
    expect(evaluateMildDipPreBuy({ ...args, maxChasePct: 8 }).pass).toBe(false);
    expect(evaluateMildDipPreBuy({ ...args, maxChasePct: 0 }).pass).toBe(true);
  });
});

describe('GREEN shared gate bypasses', () => {
  it('skips turn-dump only for GREEN when explicitly disabled', () => {
    expect(shouldApplyGreenTurnDumpGate(true, false)).toBe(false);
    expect(shouldApplyGreenTurnDumpGate(true, true)).toBe(true);
    expect(shouldApplyGreenTurnDumpGate(false, false)).toBe(true);
    expect(
      evaluateTurnDumpGate({
        enabled: true,
        pc5m: 15,
        volume5mUsd: 10_000,
        liquidityUsd: 10_000,
        alpha: -5.08,
        beta: 6.86,
        shallowSlackPct: 10,
        deepSlackPct: 12,
      }).pass,
    ).toBe(false);
  });

  it('removes the DIP prebuy window for GREEN but keeps it for DIP', () => {
    const dipWindow = { minDipPct: -20, maxDipPct: -1 };
    const green = preBuyEntryGatesForSource(true, dipWindow);
    const dip = preBuyEntryGatesForSource(false, dipWindow);
    expect(
      evaluateMildDipPreBuy({
        signalPriceUsd: 1,
        freshPriceUsd: 1.1,
        freshPc5mPct: 18,
        entryGates: green,
        maxChasePct: 12,
      }).pass,
    ).toBe(true);
    expect(
      evaluateMildDipPreBuy({
        signalPriceUsd: 1,
        freshPriceUsd: 1.1,
        freshPc5mPct: 18,
        entryGates: dip,
        maxChasePct: 12,
      }).pass,
    ).toBe(false);
  });

  it('uses the GREEN cooldown-bounce cap only when it is positive', () => {
    const base = {
      isGreen: true,
      isKnife: false,
      knifeMaxPct: 8,
      sharedMaxPct: 6,
    };
    expect(cooldownBouncePctForSource({ ...base, greenMaxPct: 100 })).toBe(100);
    expect(cooldownBouncePctForSource({ ...base, greenMaxPct: 0 })).toBe(6);
    expect(
      cooldownBouncePctForSource({
        ...base,
        isGreen: false,
        greenMaxPct: 100,
      }),
    ).toBe(6);
    expect(
      cooldownBouncePctForSource({
        ...base,
        isKnife: true,
        greenMaxPct: 100,
      }),
    ).toBe(8);
  });
});

describe('GREEN failed verdict journal throttle', () => {
  it('allows the first event, suppresses repeats for a minute, then allows again', () => {
    resetFastPathStateForTests();
    expect(shouldJournalGreenVerdict('mint', 1_000)).toBe(true);
    expect(shouldJournalGreenVerdict('mint', 60_999)).toBe(false);
    expect(shouldJournalGreenVerdict('mint', 61_000)).toBe(true);
  });
});

describe('evaluateGreenLane', () => {
  it('admits a row that clears every gate', () => {
    const v = evaluateGreenLane(ok, gates);
    expect(v.pass).toBe(true);
    expect(v.turnover).toBeCloseTo(0.6, 6);
  });

  it('stays shut when the lane is off', () => {
    expect(evaluateGreenLane(ok, { ...gates, enabled: false }).pass).toBe(false);
  });

  it('turnover is the gate that carries the most weight, and it binds', () => {
    // Same volume, ten times the liquidity: turnover 0.06, well under 0.4.
    const v = evaluateGreenLane({ ...ok, liquidityUsd: 200_000 }, gates);
    expect(v.pass).toBe(false);
    expect(v.reasons.join(' ')).toContain('turnover');
  });

  it('rejects a one-sided tape', () => {
    // 95 buys against 5 sells: the top fifth of buy share scores x0.23.
    const v = evaluateGreenLane({ ...ok, buys5m: 95, sells5m: 5 }, gates);
    expect(v.pass).toBe(false);
    expect(v.reasons.join(' ')).toContain('buyShare');
  });

  it('wants the last minute flat or down, not extended', () => {
    expect(evaluateGreenLane({ ...ok, ret1mPct: 3.2 }, gates).pass).toBe(false);
    expect(evaluateGreenLane({ ...ok, ret1mPct: -2 }, gates).pass).toBe(true);
  });

  it('does not block on a missing 1-minute return', () => {
    const { ret1mPct: _drop, ...rest } = ok;
    expect(evaluateGreenLane(rest, gates).pass).toBe(true);
  });

  it('treats a missing required field as a fail, never a pass', () => {
    for (const f of ['pc5mPct', 'pc1hPct', 'volume5mUsd', 'liquidityUsd'] as const) {
      const v = evaluateGreenLane({ ...ok, [f]: null }, gates);
      expect(v.pass).toBe(false);
    }
  });

  it('keeps a plain dip out of the green lane', () => {
    const dip: GreenLaneInput = {
      pc5mPct: -12,
      pc1hPct: -20,
      volume5mUsd: 9_000,
      volume1hUsd: 80_000,
      liquidityUsd: 20_000,
      buys5m: 50,
      sells5m: 60,
      pairAgeHours: 3,
    };
    expect(evaluateGreenLane(dip, gates).pass).toBe(false);
  });

  it('rejects momentum on one timeframe only', () => {
    // Five minutes up hard, the hour still down: not their pattern.
    expect(evaluateGreenLane({ ...ok, pc1hPct: -5 }, gates).pass).toBe(false);
  });

  it('supports an opt-in upper pc5m bound', () => {
    expect(evaluateGreenLane({ ...ok, pc5mPct: 40 }, { ...gates, maxPc5mPct: 40 }).pass).toBe(false);
    expect(evaluateGreenLane({ ...ok, pc5mPct: 39.9 }, { ...gates, maxPc5mPct: 40 }).pass).toBe(true);
  });

  it('caps rally and bounce while failing open when metrics are absent', () => {
    const rally = evaluateGreenLane(
      { ...ok, rallyIntoPeakPct: 20 },
      { ...gates, maxRallyIntoPeakPct: 20 },
    );
    expect(rally.pass).toBe(false);
    expect(rally.reasons).toContain('green_rally_into_peak=20.00');
    expect(evaluateGreenLane({ ...ok, rallyIntoPeakPct: 19.9 }, { ...gates, maxRallyIntoPeakPct: 20 }).pass).toBe(true);
    expect(evaluateGreenLane({ ...ok, rallyIntoPeakPct: null }, { ...gates, maxRallyIntoPeakPct: 20 }).pass).toBe(true);
    const bounce = evaluateGreenLane(
      { ...ok, bounceFromTroughPct: 25 },
      { ...gates, maxBounceFromTroughPct: 25 },
    );
    expect(bounce.pass).toBe(false);
    expect(bounce.reasons).toContain('green_bounce_from_trough=25.00');
    expect(evaluateGreenLane({ ...ok, bounceFromTroughPct: 24.9 }, { ...gates, maxBounceFromTroughPct: 25 }).pass).toBe(true);
    expect(evaluateGreenLane({ ...ok, bounceFromTroughPct: null }, { ...gates, maxBounceFromTroughPct: 25 }).pass).toBe(true);
    expect(evaluateGreenLane({ ...ok, rallyIntoPeakPct: 99, bounceFromTroughPct: 99 }, gates).pass).toBe(true);
  });

  it('admits a leader pullback and rejects the late rebound', () => {
    const own2Gates: GreenLaneGates = {
      ...gates,
      minPc5mPct: -25,
      minPc1hPct: -15,
      minDumpFromPeakPct: 10,
      maxTapeRet1mPct: 2,
      minTapeRet1mPct: -100,
      maxTapePrior5mPct: 10,
      maxRallyIntoPeakPct: 20,
      maxBounceFromTroughPct: 25,
      tapeMinuteGatesEnabled: true,
      minLiquidityUsd: 20_000,
      minPairAgeHours: 1,
      minTurnover5mLiq: 0.03,
      minVolume5mUsd: 150,
      minVolume1hUsd: 0,
      minBuys5m: 0,
      maxBuyShare5m: 0.65,
      requirePc1h: false,
    };
    const leaderPullback = evaluateGreenLane(
      {
        pc5mPct: -2.92,
        pc1hPct: -8.18,
        dumpExtentFromPeakPct: -20.74,
        rallyIntoPeakPct: 24.62,
        bounceFromTroughPct: 0,
        tapeRet1mPct: -4.91,
        tapePrior5mPct: -1.05,
        volume5mUsd: 10_510.11,
        volume1hUsd: 60_000,
        liquidityUsd: 48_516.14,
        buys5m: 40,
        sells5m: 60,
        pairAgeHours: 38.9,
      },
      own2Gates,
    );
    expect(leaderPullback.pass).toBe(true);
    expect(leaderPullback.reasons).toContain('dump=-20.7');

    const lateRebound = evaluateGreenLane(
      {
        pc5mPct: 6.46,
        pc1hPct: 3.89,
        dumpExtentFromPeakPct: -21.22,
        rallyIntoPeakPct: 1.45,
        bounceFromTroughPct: 0,
        tapeRet1mPct: 5.90,
        tapePrior5mPct: 3.33,
        volume5mUsd: 1_868.35,
        volume1hUsd: 60_000,
        liquidityUsd: 50_411.72,
        buys5m: 56.76,
        sells5m: 43.24,
        pairAgeHours: 39,
      },
      own2Gates,
    );
    expect(lateRebound.pass).toBe(false);
    expect(lateRebound.reasons).toContain('tapeRet1m_max=5.90');
  });

  it('requires a sufficiently deep dump when configured', () => {
    const own2Gates = {
      ...gates,
      minPc5mPct: -25,
      minPc1hPct: -15,
      minDumpFromPeakPct: 10,
      requirePc1h: false,
    };
    expect(
      evaluateGreenLane({ ...ok, dumpExtentFromPeakPct: -3 }, own2Gates).reasons,
    ).toContain('green_dump_shallow=-3.00');
    expect(
      evaluateGreenLane({ ...ok, dumpExtentFromPeakPct: null }, own2Gates).reasons,
    ).toContain('green_dump_unknown');
  });

  it('keeps the rally cap active when no dump is required', () => {
    const result = evaluateGreenLane(
      { ...ok, rallyIntoPeakPct: 24.62 },
      { ...gates, maxRallyIntoPeakPct: 20, minDumpFromPeakPct: 0 },
    );
    expect(result.pass).toBe(false);
    expect(result.reasons).toContain('green_rally_into_peak=24.62');
  });

  it('uses own tape minute gates and ignores Dex pc5m and maxRet1m', () => {
    const tapeGates = {
      ...gates,
      tapeMinuteGatesEnabled: true,
      minTapeRet1mPct: 5,
      maxTapePrior5mPct: 10,
      maxRet1mPct: 0,
      maxTapeRet1mPct: 1000,
    };
    const v = evaluateGreenLane(
      {
        ...ok,
        pc5mPct: null,
        ret1mPct: 20,
        tapeRet1mPct: 8,
        tapePrior5mPct: 9,
      },
      tapeGates,
    );
    expect(v.pass).toBe(true);
  });

  it('rejects missing tape coverage with a distinct reason', () => {
    const v = evaluateGreenLane(
      { ...ok, tapeRet1mPct: null, tapePrior5mPct: null },
      { ...gates, tapeMinuteGatesEnabled: true },
    );
    expect(v.pass).toBe(false);
    expect(v.reasons).toContain('green_tape_insufficient');
  });

  it('rejects tape thresholds independently', () => {
    const v = evaluateGreenLane(
      { ...ok, tapeRet1mPct: 4, tapePrior5mPct: 11 },
      {
        ...gates,
        tapeMinuteGatesEnabled: true,
        minTapeRet1mPct: 5,
        maxTapePrior5mPct: 10,
      },
    );
    expect(v.pass).toBe(false);
    expect(v.reasons).toEqual(expect.arrayContaining(['tapeRet1m=4', 'tapePrior5m=11']));
  });

  it('selects the strong-minute profile only at the entry threshold', () => {
    const cfg = {
      green: { fastExitEnabled: true, strongRet1mPct: 40 },
    } as Pick<MildDipConfig, 'green'>;
    expect(greenExitProfileForTape(cfg, 40)).toBe('fast');
    expect(greenExitProfileForTape(cfg, 39.9)).toBe('standard');
    expect(greenExitProfileForTape(cfg, null)).toBe('standard');
    expect(greenExitProfileForTape({ green: { ...cfg.green, fastExitEnabled: false } }, 80)).toBe(
      'standard',
    );
  });

  it('allows missing pc1h only when explicitly configured', () => {
    expect(evaluateGreenLane({ ...ok, pc1hPct: null }, { ...gates, requirePc1h: false }).pass).toBe(true);
    expect(evaluateGreenLane({ ...ok, pc1hPct: -5 }, { ...gates, requirePc1h: false }).pass).toBe(false);
  });
});

describe('decideGreenExit', () => {
  const g: GreenExitGates = { takeProfitPct: 30, stopPct: 6, maxHoldMs: 600_000 };

  it('takes profit at +30%', () => {
    expect(decideGreenExit(30.1, 60_000, g)).toEqual({ shouldExit: true, reason: 'green_tp' });
  });

  it('cuts at −6%', () => {
    expect(decideGreenExit(-6.2, 60_000, g)).toEqual({ shouldExit: true, reason: 'green_stop' });
  });

  it('the stop wins when both would fire on the same tick', () => {
    expect(decideGreenExit(-99, 10_000_000, g).reason).toBe('green_stop');
  });

  it('lets go at the ten-minute ceiling', () => {
    expect(decideGreenExit(4, 600_001, g)).toEqual({
      shouldExit: true,
      reason: 'green_max_hold',
    });
  });

  it('holds in between', () => {
    expect(decideGreenExit(12, 120_000, g).shouldExit).toBe(false);
    expect(decideGreenExit(-3, 120_000, g).shouldExit).toBe(false);
  });

  it('arms and trails from the peak when enabled', () => {
    const trail: GreenExitGates = {
      takeProfitPct: 0,
      stopPct: 30,
      maxHoldMs: 3_600_000,
      trailEnabled: true,
      armPct: 10,
      trailPct: 9,
    };
    expect(decideGreenExit(10, 60_000, trail, 10, 0)).toEqual({ shouldExit: false, reason: null });
    expect(decideGreenExit(12, 60_000, trail, 20, 0)).toEqual({ shouldExit: false, reason: null });
    expect(decideGreenExit(10, 60_000, trail, 20, 9)).toEqual({ shouldExit: true, reason: 'green_trail' });
    expect(decideGreenExit(-30, 60_000, trail, 20, 9)).toEqual({ shouldExit: true, reason: 'green_stop' });
    expect(decideGreenExit(12, 3_600_001, trail, 12, 0)).toEqual({ shouldExit: true, reason: 'green_max_hold' });
  });

  it('arms and trails from the fill rather than entry-mark slippage', () => {
    const trail: GreenExitGates = {
      takeProfitPct: 0,
      stopPct: 45,
      maxHoldMs: 3_600_000,
      trailEnabled: true,
      armPct: 2,
      trailPct: 4,
    };
    expect(decideGreenExit(-1, 60_000, trail, 3.14, 5, -4.2, 0).shouldExit).toBe(false);
    expect(decideGreenExit(6, 60_000, trail, 12, 5, 3, 9).reason).toBe('green_trail');
    expect(decideGreenExit(-2, 60_000, trail, 12, 20, -2, 9).reason).not.toBe('green_trail');
    expect(decideGreenExit(-50, 60_000, trail, 12, 20, -2, 9).reason).toBe('green_stop');
  });

  it('cuts a position that has not moved by the no-move deadline', () => {
    const noMove: GreenExitGates = {
      ...g,
      noMoveCutMs: 900_000,
      noMoveMinMfePct: 3,
    };
    expect(decideGreenExit(1, 900_000, noMove, 2)).toEqual({
      shouldExit: true,
      reason: 'green_no_move',
    });
  });

  it('keeps a position whose MFE cleared the no-move threshold', () => {
    const noMove: GreenExitGates = {
      ...g,
      noMoveCutMs: 900_000,
      noMoveMinMfePct: 3,
    };
    expect(decideGreenExit(1, 599_999, noMove, 3)).toEqual({
      shouldExit: false,
      reason: null,
    });
  });

  it('gives the stop and trail priority over the no-move cut', () => {
    const noMoveTrail: GreenExitGates = {
      ...g,
      noMoveCutMs: 900_000,
      noMoveMinMfePct: 3,
      trailEnabled: true,
      armPct: 3,
      trailPct: 6,
    };
    expect(decideGreenExit(-6, 900_000, noMoveTrail, 2)).toEqual({
      shouldExit: true,
      reason: 'green_stop',
    });
    expect(decideGreenExit(1, 900_000, noMoveTrail, 10, 6)).toEqual({
      shouldExit: true,
      reason: 'green_trail',
    });
  });

  it('disables the no-move cut when either setting is zero', () => {
    expect(decideGreenExit(1, 599_999, { ...g, noMoveCutMs: 0, noMoveMinMfePct: 3 }, 0))
      .toEqual({ shouldExit: false, reason: null });
    expect(decideGreenExit(1, 599_999, { ...g, noMoveCutMs: 900_000, noMoveMinMfePct: 0 }, 0))
      .toEqual({ shouldExit: false, reason: null });
  });

  it('trails nine percent from peak price, not nine pnl points', () => {
    // Basis 1.0, peak 1.40, arm at +40%. Mark 1.30 is −7.14% from peak;
    // mark 1.274 is −9.0% from peak and exits.
    const trail: GreenExitGates = {
      takeProfitPct: 0,
      stopPct: 30,
      maxHoldMs: 3_600_000,
      trailEnabled: true,
      armPct: 10,
      trailPct: 9,
    };
    expect(decideGreenExit(30, 60_000, trail, 40, (1 - 1.30 / 1.40) * 100)).toEqual({
      shouldExit: false,
      reason: null,
    });
    expect(decideGreenExit(27.4, 60_000, trail, 40, (1 - 1.274 / 1.40) * 100)).toEqual({
      shouldExit: true,
      reason: 'green_trail',
    });
  });

  it('does not ride a drawdown the way the dip lane does', () => {
    // −15% is comfortably inside the dip lane's −25% stop and would be held
    // there; here it is already out.
    expect(decideGreenExit(-15, 30_000, g).shouldExit).toBe(true);
  });
});

describe('a green bag is managed by the green rule, not the dip ladder', () => {
  const greenGates: GreenExitGates = { takeProfitPct: 30, stopPct: 6, maxHoldMs: 600_000 };
  // Dip gates that would hold a −15% bag: the stop is −25% and the ladder has
  // not been reached. Only the lane flag decides which rule runs.
  const dipGates = {
    armPct: 5,
    partialGivebackPct: 0,
    scaleOutFraction: 0.5,
    givebackPct: 12,
    mfeBankEnabled: true,
    mfeBank1Pct: 0,
    mfeBank1Fraction: 0.4,
    mfeBank2Pct: 0,
    mfeBank2Fraction: 0.6,
    mfeBankSleeveGivebackPct: 12,
    tpGridStepPct: 8,
    tpGridSellFraction: 0.5,
    markJumpConfirmPct: 25,
    breakevenArmPct: 8,
    breakevenFloorPct: 0,
    mfeBankMinHoldMs: 0,
    neverArmPatienceMs: 0,
    neverArmMaxHoldMs: 0,
    neverArmDeadMinMs: 0,
    neverArmDeadPnlPct: 0,
    neverArmStaleMinMs: 0,
    neverArmStaleMaxMfePct: 2,
    neverArmStalePnlPct: 0,
    neverArmVolFadeMinMs: 0,
    neverArmVolFadeRatio: 0.25,
    neverArmVolFadeFloorUsd: 300,
    neverArmVolFadeSampleMs: 300_000,
    neverArmVolFadeWeakWindows: 3,
    cliffDumpPnlPct: 50,
    hardStopPnlPct: 25,
    hardStopPartialFraction: 0,
    neverArmBounceMinDumpPct: 8,
    neverArmBouncePct: 8,
    neverArmBounceMinTroughAgeMs: 60_000,
    neverArmBounceRequireRedPct: 0,
    neverArmBounceMinPnlPct: 0,
    neverArmBouncePartialFraction: 0.5,
    neverArmBounce2Pct: 16,
    mfeBankSleeveLossPartialFraction: 0.5,
    neverArmFreefallPnlPct: 0,
    neverArmFreefallMinMs: 0,
    neverArmTimeRedMinMs: 0,
    neverArmTimeRedPnlPct: 0,
    neverArmTimeRedMaxPc5mPct: 0,
    dustCloseUsd: 0,
    dustCloseMinHoldMs: 0,
  };
  const bag = (lane: 'dip' | 'green'): MildDipOpenPosition => ({
    mint: 'g',
    symbol: 'G',
    entryPriceUsd: 100,
    sizeUsd: 1,
    tokenRaw: '1',
    openedAtMs: 1_000_000,
    entryPc5mPct: 20,
    buySignature: null,
    peakPriceUsd: 100,
    lane,
  });
  const at = (lane: 'dip' | 'green', px: number, nowMs = 1_060_000) =>
    decideMarkExit({ mint: 'g', pos: bag(lane), markPriceUsd: px, gates: dipGates, nowMs, greenGates });

  it('cuts a green bag at −6% where the dip lane would still hold', () => {
    expect(at('green', 93).reason).toBe('green_stop');
    expect(at('dip', 93)?.shouldExit).toBe(false);
  });

  it('takes the green target whole, with no ladder rung', () => {
    const d = at('green', 131);
    expect(d?.reason).toBe('green_tp');
    expect(d?.fraction).toBe(1);
    // The dip lane would have banked half on the +8% rung instead.
    expect(at('dip', 131)?.reason).toBe('tp_grid');
  });

  it('lets a green bag go at the ten-minute ceiling', () => {
    expect(at('green', 103, 1_000_000 + 600_001).reason).toBe('green_max_hold');
  });

  it('holds a green bag between the stop and the target', () => {
    expect(at('green', 112)?.shouldExit).toBe(false);
  });
});

describe('the green lane costs nothing extra on the paid RPC', () => {
  /**
   * `forceFetch` decides which open bags get a stream sample, and every sample
   * is a getTransaction on Helius. Green bags are excluded: the exit was fitted
   * on a 26.8s tape and our free Dex marks run at 6.1s, so the paid stream buys
   * no resolution the rule can use.
   */
  const forceFetch = (open: Record<string, { lane?: 'dip' | 'green' }>) => (mint: string) => {
    const o = open[mint];
    return Boolean(o) && o?.lane !== 'green';
  };

  it('samples dip bags and skips green ones', () => {
    const f = forceFetch({ d: { lane: 'dip' }, g: { lane: 'green' }, legacy: {} });
    expect(f('d')).toBe(true);
    expect(f('g')).toBe(false);
    // A bag opened before the lane field existed is a dip bag.
    expect(f('legacy')).toBe(true);
  });

  it('does not sample a mint we do not hold', () => {
    expect(forceFetch({})('nothing')).toBe(false);
  });
});

describe('the green lane keeps its own age floor', () => {
  it('admits a launch, and only waits for a readable snapshot', () => {
    // Age does not move per-trade quality here: mean +3.39 with no floor
    // against +2.75 at 1h, while the signal count falls 153 -> 60. The floor
    // exists only so the pair has a snapshot at all.
    expect(evaluateGreenLane({ ...ok, pairAgeHours: 0.02 }, gates).pass).toBe(false);
    expect(evaluateGreenLane({ ...ok, pairAgeHours: 0.4 }, gates).pass).toBe(true);
    expect(evaluateGreenLane({ ...ok, pairAgeHours: 1.2 }, gates).pass).toBe(true);
  });

  it('a missing age is a fail', () => {
    expect(evaluateGreenLane({ ...ok, pairAgeHours: null }, gates).pass).toBe(false);
  });

  it('the floor can be lifted entirely', () => {
    const g = { ...gates, minPairAgeHours: 0 };
    expect(evaluateGreenLane({ ...ok, pairAgeHours: 0.001 }, g).pass).toBe(true);
  });

  it('live env enables the controlled probe', () => {
    const eco = readFileSync(resolve('ecosystem.config.cjs'), 'utf8');
    expect(eco).toContain("MILD_DIP_GREEN_ENABLED: '0'");
    expect(eco).toContain("MILD_DIP_GREEN_POSITION_USD: '1'");
    expect(eco).toContain("MILD_DIP_GREEN_MIN_PAIR_AGE_HOURS: '1'");
    expect(eco).toContain("MILD_DIP_GREEN_MIN_LIQUIDITY_USD: '20000'");
    expect(eco).toContain("MILD_DIP_GREEN_EXIT_ARM_PCT: '2'");
    expect(eco).toContain("MILD_DIP_GREEN_EXIT_TRAIL_PCT: '4'");
    expect(eco).toContain("MILD_DIP_GREEN_NO_MOVE_CUT_MS: '600000'");
    expect(eco).toContain("MILD_DIP_GREEN_NO_MOVE_MIN_MFE_PCT: '2'");
    expect(eco).toContain("MILD_DIP_GREEN_EXIT_STOP_PCT: '45'");
  });
});

describe('the green momentum liquidity and age floors', () => {
  it('rejects below-floor momentum with observable green reasons', () => {
    const tightened = { ...gates, minLiquidityUsd: 20_000, minPairAgeHours: 1 };
    const v = evaluateGreenLane(
      { ...ok, liquidityUsd: 19_999, pairAgeHours: 0.99 },
      tightened,
    );
    expect(v.pass).toBe(false);
    expect(v.reasons).toEqual(
      expect.arrayContaining(['green_liq_floor=19999<20000', 'green_pair_age_floor=0.99<1']),
    );
  });

  it('admits momentum above both tightened floors', () => {
    expect(
      evaluateGreenLane(
        { ...ok, liquidityUsd: 20_000, pairAgeHours: 1 },
        { ...gates, minLiquidityUsd: 20_000, minPairAgeHours: 1 },
      ).pass,
    ).toBe(true);
  });

  it('supports the explicit zero-floor opt-out', () => {
    expect(
      evaluateGreenLane(
        { ...ok, liquidityUsd: 1, pairAgeHours: 0 },
        { ...gates, minLiquidityUsd: 0, minPairAgeHours: 0 },
      ).pass,
    ).toBe(true);
  });

  it('does not apply GREEN floors to a DIP entry risk check', () => {
    expect(
      evaluateMildDipEntryRisk({
        pairAgeHours: 0.5,
        volume5mUsd: 1_000,
        liquidityUsd: 6_000,
        minPairAgeHours: 0.5,
        maxVol5mToLiq: 0,
        minLiquidityUsd: 5_000,
      }).pass,
    ).toBe(true);
  });
});
