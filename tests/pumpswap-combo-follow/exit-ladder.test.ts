import { describe, expect, it } from 'vitest';
import {
  effectiveExitLadder,
  effectiveStopLossPct,
  HNU5_DEFAULT_EXIT_LADDER,
  nextExitRung,
  parseExitLadderSpec,
} from '../../src/pumpswap-combo-follow/exit-ladder.js';

describe('parseExitLadderSpec', () => {
  it('defaults to hnu5 two-rung ladder', () => {
    const rungs = parseExitLadderSpec('');
    expect(rungs).toHaveLength(2);
    expect(rungs[0]).toMatchObject({ leaderTpPct: 13, sellFracOfRemaining: 0.7 });
    expect(rungs[1]).toMatchObject({ leaderTpPct: 25, sellFracOfRemaining: 1 });
  });

  it('parses custom ladder string', () => {
    const rungs = parseExitLadderSpec('10:0.5,20:1');
    expect(rungs[0]?.leaderTpPct).toBe(10);
    expect(rungs[0]?.sellFracOfRemaining).toBe(0.5);
    expect(rungs[1]?.leaderTpPct).toBe(20);
  });
});

describe('effectiveExitLadder', () => {
  it('applies lead offset and marks final rung', () => {
    const eff = effectiveExitLadder(HNU5_DEFAULT_EXIT_LADDER, 2);
    expect(eff[0]?.effectiveTpPct).toBe(11);
    expect(eff[1]?.effectiveTpPct).toBe(23);
    expect(eff[1]?.isFinal).toBe(true);
  });

  it('hnu5 aggressive scalp ladder front-runs +14/+22 by 2pp', () => {
    const eff = effectiveExitLadder(parseExitLadderSpec('14:0.7,22:1'), 2);
    expect(eff[0]?.effectiveTpPct).toBe(12);
    expect(eff[0]?.sellFracOfRemaining).toBe(0.7);
    expect(eff[1]?.effectiveTpPct).toBe(20);
    expect(eff[1]?.isFinal).toBe(true);
  });

  it('never goes below 0.5% effective TP', () => {
    const tiny = [{ id: 'tp1', leaderTpPct: 1, sellFracOfRemaining: 1 }];
    expect(effectiveExitLadder(tiny, 2)[0]?.effectiveTpPct).toBe(0.5);
  });
});

describe('effectiveStopLossPct', () => {
  it('tightens SL by lead', () => {
    expect(effectiveStopLossPct(20, 2, false, 22)).toBe(18);
    expect(effectiveStopLossPct(20, 2, true, 22)).toBe(20);
  });
});

describe('nextExitRung', () => {
  it('returns first untaken rung', () => {
    const ladder = effectiveExitLadder(HNU5_DEFAULT_EXIT_LADDER, 2);
    expect(nextExitRung(ladder, [])?.id).toBe('tp1');
    expect(nextExitRung(ladder, ['tp1'])?.id).toBe('tp2');
    expect(nextExitRung(ladder, ['tp1', 'tp2'])).toBeNull();
  });
});
