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
  const cfg = { stepPct: 2, slicePctOfInitial: 30 };

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

  it('TP at +2% HL ROE takes 30% of current gross', () => {
    const action = nextLadderAction('buy', 102, 100, 100, 100, 100, 0, 0, cfg);
    expect(action).toEqual({ kind: 'take_profit', level: 1, notionalUsd: 30 });
  });

  it('TP on stacked short $6k: +2% ROE at 7x (~0.29% price) → $1.8k slice', () => {
    const markPx = 100 * (1 - 0.02 / 7);
    const action = nextLadderAction('sell', markPx, 100, 500, 6000, 6000, 0, 0, cfg, 7);
    expect(action).toEqual({ kind: 'take_profit', level: 1, notionalUsd: 1800 });
  });

  it('TP at 2% ROE fires before 2% price move when leveraged', () => {
    expect(nextLadderAction('buy', 100.2, 100, 100, 500, 500, 0, 0, cfg, 7)).toBeNull();
    expect(nextLadderAction('buy', 100.4, 100, 100, 500, 500, 0, 0, cfg, 7)).toEqual({
      kind: 'take_profit',
      level: 1,
      notionalUsd: 150,
    });
  });

  it('SUI-style peak: +$130 on $10.5k gross / $1.5k margin → TP L1', () => {
    const action = nextLadderAction('sell', 0.718, 0.727, 1_500, 10_500, 10_500, 0, 0, cfg, 7);
    expect(action).toEqual({ kind: 'take_profit', level: 1, notionalUsd: 3_150 });
  });

  it('DCA at −2% HL ROE adds 30% of current gross', () => {
    const action = nextLadderAction('sell', 102, 100, 100, 100, 100, 0, 0, cfg);
    expect(action).toEqual({ kind: 'add', level: 1, notionalUsd: 30 });
  });

  it('DCA on stacked short $6k: −2% ROE → add $1.8k gross', () => {
    const markPx = 100 * (1 + 0.02 / 7);
    const action = nextLadderAction('sell', markPx, 100, 500, 6000, 6000, 0, 0, cfg, 7);
    expect(action).toEqual({ kind: 'add', level: 1, notionalUsd: 1800 });
  });

  it('second TP at +4% HL ROE cumulative', () => {
    const action = nextLadderAction('buy', 105, 100, 100, 100, 90, 1, 0, cfg);
    expect(action).toEqual({ kind: 'take_profit', level: 2, notionalUsd: 27 });
  });

  it('after DCA lowers avg, TP triggers on ROE vs avg entry', () => {
    const avg = avgEntryAfterAdd(100, 100, 10, 95);
    const markSoon = avg * 1.021;
    expect(hlRoePct('buy', markSoon, avg, 110, 100)).toBeGreaterThanOrEqual(2);
    const action = nextLadderAction('buy', markSoon, avg, 100, 100, 110, 0, 1, cfg);
    expect(action).toEqual({ kind: 'take_profit', level: 1, notionalUsd: 33 });
  });

  it('no action between thresholds', () => {
    expect(nextLadderAction('buy', 101.5, 100, 100, 100, 100, 0, 0, cfg)).toBeNull();
  });

  it('TP capped at remaining notional', () => {
    const action = nextLadderAction('buy', 106, 100, 100, 100, 50, 0, 0, cfg);
    expect(action).toEqual({ kind: 'take_profit', level: 1, notionalUsd: 15 });
  });

  it('ladderSliceGrossUsd and sliceMarginUsd', () => {
    expect(ladderSliceGrossUsd(6000, cfg)).toBe(1800);
    expect(sliceMarginUsd(500, cfg)).toBe(150);
  });

  it('avgEntryAfterAdd weights by notional', () => {
    const avg = avgEntryAfterAdd(100, 100, 10, 110);
    expect(avg).toBeCloseTo(100.909, 2);
  });
});
