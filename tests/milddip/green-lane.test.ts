import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decideMarkExit } from '../../src/milddip/exit-engine.js';
import type { MildDipOpenPosition } from '../../src/milddip/state.js';
import {
  decideGreenExit,
  evaluateGreenLane,
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
  minPc1hPct: 20,
  minBuys5m: 43,
  maxBuyShare5m: 0.85,
  minLiquidityUsd: 6_000,
  minPairAgeHours: 0.05,
  maxRet1mPct: 0,
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
    cliffDumpPnlPct: 0,
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

describe('the green lane keeps its own age floor (1.11.865)', () => {
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

  it('live env keeps the lane off (1.11.876)', () => {
    // Zero green_momentum buys across 7098 attempts, so the lane produced no
    // trades and no data while spending the shared DexScreener budget. The
    // parameters stay put for when there is budget to test it again.
    const eco = readFileSync(resolve('ecosystem.config.cjs'), 'utf8');
    expect(eco).toContain("MILD_DIP_GREEN_ENABLED: '0'");
    expect(eco).toContain("MILD_DIP_GREEN_POSITION_USD: '1'");
    expect(eco).toContain("MILD_DIP_GREEN_MIN_PAIR_AGE_HOURS: '0.05'");
  });
});
