import { describe, expect, it } from 'vitest';

import {
  avgEntryAfterAdd,
  favorableMovePct,
  nextLadderAction,
  sliceNotionalUsd,
} from '../src/hyperliquid/twap/live/position-ladder.js';

describe('hl-twap live ladder', () => {
  const cfg = { stepPct: 3, slicePctOfInitial: 10 };

  it('favorable move: long +3%, short -3%', () => {
    expect(favorableMovePct('buy', 103, 100)).toBeCloseTo(3, 5);
    expect(favorableMovePct('sell', 97, 100)).toBeCloseTo(3, 5);
    expect(favorableMovePct('buy', 97, 100)).toBeCloseTo(-3, 5);
  });

  it('TP at +3% takes 10% of initial', () => {
    const action = nextLadderAction('buy', 103, 100, 100, 100, 0, 0, cfg);
    expect(action).toEqual({ kind: 'take_profit', level: 1, notionalUsd: 10 });
  });

  it('DCA at -3% adds 10% of initial', () => {
    const action = nextLadderAction('sell', 103, 100, 100, 100, 0, 0, cfg);
    expect(action).toEqual({ kind: 'add', level: 1, notionalUsd: 10 });
  });

  it('second TP at +6% from avg (avg unchanged after partial TP)', () => {
    const action = nextLadderAction('buy', 106, 100, 100, 90, 1, 0, cfg);
    expect(action).toEqual({ kind: 'take_profit', level: 2, notionalUsd: 10 });
  });

  it('after DCA lowers avg, TP triggers sooner vs first fill', () => {
    const avg = avgEntryAfterAdd(100, 100, 10, 95);
    const markSoon = avg * 1.031;
    expect(favorableMovePct('buy', markSoon, avg)).toBeGreaterThanOrEqual(3);
    expect(favorableMovePct('buy', markSoon, 100)).toBeLessThan(3);
    const action = nextLadderAction('buy', markSoon, avg, 100, 110, 0, 1, cfg);
    expect(action).toEqual({ kind: 'take_profit', level: 1, notionalUsd: 10 });
  });

  it('no action between thresholds', () => {
    expect(nextLadderAction('buy', 101.5, 100, 100, 100, 0, 0, cfg)).toBeNull();
  });

  it('TP capped at remaining notional', () => {
    const action = nextLadderAction('buy', 103, 100, 100, 5, 0, 0, cfg);
    expect(action).toEqual({ kind: 'take_profit', level: 1, notionalUsd: 5 });
  });

  it('sliceNotionalUsd', () => {
    expect(sliceNotionalUsd(100, cfg)).toBe(10);
  });

  it('avgEntryAfterAdd weights by notional', () => {
    const avg = avgEntryAfterAdd(100, 100, 10, 110);
    expect(avg).toBeCloseTo(100.909, 2);
  });

  it('at 5x leverage DCA triggers on margin ROE not raw price', () => {
    // −2.4% price × 5 = −12% margin ROE → L1..L3 (−3/−6/−9), not L4 (−12)
    expect(nextLadderAction('sell', 102.4, 100, 500, 500, 0, 0, cfg, 5)).toEqual({
      kind: 'add',
      level: 1,
      notionalUsd: 50,
    });
    // −2% price × 5 = −10% ROE → only L1+L2 if L0 taken
    expect(nextLadderAction('sell', 102, 100, 500, 500, 0, 0, cfg, 5)).toEqual({
      kind: 'add',
      level: 1,
      notionalUsd: 50,
    });
    expect(nextLadderAction('sell', 102, 100, 500, 550, 0, 1, cfg, 5)).toEqual({
      kind: 'add',
      level: 2,
      notionalUsd: 50,
    });
    expect(nextLadderAction('sell', 102, 100, 500, 600, 0, 2, cfg, 5)).toEqual({
      kind: 'add',
      level: 3,
      notionalUsd: 50,
    });
    // −1.7% × 5 = −8.5% ROE — below L3 (−9%) after two DCAs
    expect(nextLadderAction('sell', 101.7, 100, 500, 600, 0, 2, cfg, 5)).toBeNull();
  });
});
