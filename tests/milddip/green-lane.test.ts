import { describe, expect, it } from 'vitest';
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
