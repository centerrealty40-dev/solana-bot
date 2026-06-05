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
});
