import { describe, expect, it } from 'vitest';

import {
  avgEntryAfterAdd,
  favorableMovePct,
  ladderSliceGrossUsd,
  nextLadderAction,
  sliceMarginUsd,
} from '../src/hyperliquid/twap/live/position-ladder.js';

describe('hl-twap live ladder', () => {
  const cfg = { stepPct: 3, slicePctOfInitial: 10 };

  it('favorable move: long +3%, short -3%', () => {
    expect(favorableMovePct('buy', 103, 100)).toBeCloseTo(3, 5);
    expect(favorableMovePct('sell', 97, 100)).toBeCloseTo(3, 5);
    expect(favorableMovePct('buy', 97, 100)).toBeCloseTo(-3, 5);
  });

  it('TP at +3% price takes 10% of current gross position', () => {
    const action = nextLadderAction('buy', 103, 100, 100, 100, 100, 0, 0, cfg);
    expect(action).toEqual({ kind: 'take_profit', level: 1, notionalUsd: 10 });
  });

  it('TP on stacked short $6k: +3% price → $600 slice', () => {
    const action = nextLadderAction('sell', 97, 100, 500, 6000, 6000, 0, 0, cfg, 7);
    expect(action).toEqual({ kind: 'take_profit', level: 1, notionalUsd: 600 });
  });

  it('TP needs +3% price move, not fractional move at high leverage', () => {
    expect(nextLadderAction('buy', 100.5, 100, 100, 500, 500, 0, 0, cfg, 7)).toBeNull();
    expect(nextLadderAction('buy', 103, 100, 100, 500, 500, 0, 0, cfg, 7)).toEqual({
      kind: 'take_profit',
      level: 1,
      notionalUsd: 50,
    });
  });

  it('DCA at −3% price adds 10% of current gross (symmetric with TP)', () => {
    const action = nextLadderAction('sell', 103, 100, 100, 100, 100, 0, 0, cfg);
    expect(action).toEqual({ kind: 'add', level: 1, notionalUsd: 10 });
  });

  it('DCA on stacked short $6k: −3% price → add $600 gross', () => {
    const action = nextLadderAction('sell', 103, 100, 500, 6000, 6000, 0, 0, cfg, 7);
    expect(action).toEqual({ kind: 'add', level: 1, notionalUsd: 600 });
  });

  it('DCA needs −3% price move, not ROE fraction', () => {
    expect(nextLadderAction('buy', 99.6, 100, 500, 6000, 6000, 0, 0, cfg, 7)).toBeNull();
    expect(nextLadderAction('buy', 97, 100, 500, 6000, 6000, 0, 0, cfg, 7)).toEqual({
      kind: 'add',
      level: 1,
      notionalUsd: 600,
    });
  });

  it('second TP at +6% price from anchor', () => {
    const action = nextLadderAction('buy', 106, 100, 100, 100, 90, 1, 0, cfg);
    expect(action).toEqual({ kind: 'take_profit', level: 2, notionalUsd: 9 });
  });

  it('after DCA lowers avg, TP triggers on price move vs avg entry', () => {
    const avg = avgEntryAfterAdd(100, 100, 10, 95);
    const markSoon = avg * 1.031;
    expect(favorableMovePct('buy', markSoon, avg)).toBeGreaterThanOrEqual(3);
    const action = nextLadderAction('buy', markSoon, avg, 100, 100, 110, 0, 1, cfg);
    expect(action).toEqual({ kind: 'take_profit', level: 1, notionalUsd: 11 });
  });

  it('no action between thresholds', () => {
    expect(nextLadderAction('buy', 101.5, 100, 100, 100, 100, 0, 0, cfg)).toBeNull();
  });

  it('TP capped at remaining notional', () => {
    const action = nextLadderAction('buy', 103, 100, 100, 100, 50, 0, 0, cfg);
    expect(action).toEqual({ kind: 'take_profit', level: 1, notionalUsd: 5 });
  });

  it('ladderSliceGrossUsd and sliceMarginUsd', () => {
    expect(ladderSliceGrossUsd(6000, cfg)).toBe(600);
    expect(sliceMarginUsd(500, cfg)).toBe(50);
  });

  it('avgEntryAfterAdd weights by notional', () => {
    const avg = avgEntryAfterAdd(100, 100, 10, 110);
    expect(avg).toBeCloseTo(100.909, 2);
  });
});
