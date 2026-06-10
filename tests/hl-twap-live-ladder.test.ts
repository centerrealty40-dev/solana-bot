import { describe, expect, it } from 'vitest';

import {
  avgEntryAfterAdd,
  favorableMovePct,
  hlRoePct,
  ladderSliceGrossUsd,
  nextLadderAction,
  sliceMarginUsd,
  unrealizedUsd,
} from '../src/hyperliquid/twap/live/position-ladder.js';

describe('hl-twap live ladder', () => {
  const cfg = { stepPct: 3, slicePctOfInitial: 10 };

  it('favorable move: long +3%, short -3%', () => {
    expect(favorableMovePct('buy', 103, 100)).toBeCloseTo(3, 5);
    expect(favorableMovePct('sell', 97, 100)).toBeCloseTo(3, 5);
    expect(favorableMovePct('buy', 97, 100)).toBeCloseTo(-3, 5);
  });

  it('HL ROE = uPnL / margin (matches clearinghouse UI)', () => {
    const pnl = unrealizedUsd('sell', 0.727, 10_500, 0.718);
    expect(pnl).toBeCloseTo(130, 0);
    expect(hlRoePct('sell', 0.718, 0.727, 10_500, 1_500)).toBeCloseTo(8.67, 1);
  });

  it('TP at +3% HL ROE takes 10% of current gross', () => {
    const action = nextLadderAction('buy', 103, 100, 100, 100, 100, 0, 0, cfg);
    expect(action).toEqual({ kind: 'take_profit', level: 1, notionalUsd: 10 });
  });

  it('TP on stacked short $6k: +3% ROE at 7x (~0.43% price) → $600 slice', () => {
    const markPx = 100 * (1 - 0.03 / 7);
    const action = nextLadderAction('sell', markPx, 100, 500, 6000, 6000, 0, 0, cfg, 7);
    expect(action).toEqual({ kind: 'take_profit', level: 1, notionalUsd: 600 });
  });

  it('TP at 3% ROE fires before 3% price move when leveraged', () => {
    expect(nextLadderAction('buy', 100.5, 100, 100, 500, 500, 0, 0, cfg, 7)).toBeNull();
    expect(nextLadderAction('buy', 103, 100, 100, 500, 500, 0, 0, cfg, 7)).toEqual({
      kind: 'take_profit',
      level: 1,
      notionalUsd: 50,
    });
  });

  it('SUI-style peak: +$130 on $10.5k gross / $1.5k margin → TP L1', () => {
    const action = nextLadderAction('sell', 0.718, 0.727, 1_500, 10_500, 10_500, 0, 0, cfg, 7);
    expect(action).toEqual({ kind: 'take_profit', level: 1, notionalUsd: 1_050 });
  });

  it('DCA at −3% HL ROE adds 10% of current gross', () => {
    const action = nextLadderAction('sell', 103, 100, 100, 100, 100, 0, 0, cfg);
    expect(action).toEqual({ kind: 'add', level: 1, notionalUsd: 10 });
  });

  it('DCA on stacked short $6k: −3% ROE → add $600 gross', () => {
    const markPx = 100 * (1 + 0.03 / 7);
    const action = nextLadderAction('sell', markPx, 100, 500, 6000, 6000, 0, 0, cfg, 7);
    expect(action).toEqual({ kind: 'add', level: 1, notionalUsd: 600 });
  });

  it('second TP at +6% HL ROE cumulative', () => {
    const action = nextLadderAction('buy', 107, 100, 100, 100, 90, 1, 0, cfg);
    expect(action).toEqual({ kind: 'take_profit', level: 2, notionalUsd: 9 });
  });

  it('after DCA lowers avg, TP triggers on ROE vs avg entry', () => {
    const avg = avgEntryAfterAdd(100, 100, 10, 95);
    const markSoon = avg * 1.031;
    expect(hlRoePct('buy', markSoon, avg, 110, 100)).toBeGreaterThanOrEqual(3);
    const action = nextLadderAction('buy', markSoon, avg, 100, 100, 110, 0, 1, cfg);
    expect(action).toEqual({ kind: 'take_profit', level: 1, notionalUsd: 11 });
  });

  it('no action between thresholds', () => {
    expect(nextLadderAction('buy', 101.5, 100, 100, 100, 100, 0, 0, cfg)).toBeNull();
  });

  it('TP capped at remaining notional', () => {
    const action = nextLadderAction('buy', 106, 100, 100, 100, 50, 0, 0, cfg);
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
