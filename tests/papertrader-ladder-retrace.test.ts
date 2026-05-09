import { describe, it, expect } from 'vitest';
import { ladderRetraceTriggered } from '../src/papertrader/executor/tracker.js';
import { ladderRetraceTriggeredWithSpec } from '../src/papertrader/executor/tp-ladder-state.js';
import type { OpenTrade } from '../src/papertrader/types.js';
import type { TpLadderLevel } from '../src/papertrader/config.js';

const ladder: TpLadderLevel[] = [
  { pnlPct: 0.1, sellFraction: 0.4 },
  { pnlPct: 0.2, sellFraction: 0.5 },
  { pnlPct: 0.3, sellFraction: 0.8 },
  { pnlPct: 0.4, sellFraction: 1 },
];

function ot(levels: number[]): OpenTrade {
  return {
    ladderUsedLevels: new Set(levels),
    ladderUsedIndices: new Set<number>(),
  } as OpenTrade;
}

describe('ladderRetraceTriggered', () => {
  it('false when no ladder fills yet', () => {
    expect(ladderRetraceTriggered(ot([]), ladder, 1.05)).toBe(false);
  });

  it('after first rung only — ladder retrace disabled (need 2+ partial rungs)', () => {
    expect(ladderRetraceTriggered(ot([0.1]), ladder, 1.05)).toBe(false);
    expect(ladderRetraceTriggered(ot([0.1]), ladder, 1.0)).toBe(false);
    expect(ladderRetraceTriggered(ot([0.1]), ladder, 0.99)).toBe(false);
  });

  it('after second rung (+20%), dip to <= +10% PnL triggers', () => {
    expect(ladderRetraceTriggered(ot([0.1, 0.2]), ladder, 1.11)).toBe(false);
    expect(ladderRetraceTriggered(ot([0.1, 0.2]), ladder, 1.1)).toBe(true);
    expect(ladderRetraceTriggered(ot([0.1, 0.2]), ladder, 1.09)).toBe(true);
  });

  it('ladderUsedIndices without legacy floats still counts toward retrace', () => {
    const hitFirst = {
      ladderUsedLevels: new Set<number>(),
      ladderUsedIndices: new Set([0]),
    } as OpenTrade;
    expect(ladderRetraceTriggered(hitFirst, ladder, 1.05)).toBe(false);
    expect(ladderRetraceTriggered(hitFirst, ladder, 1.0)).toBe(false);
  });
});

describe('ladderRetraceTriggered grid mode', () => {
  it('after +5% and +10% filled, dip to <= +5% PnL triggers', () => {
    expect(ladderRetraceTriggered(ot([0.05, 0.1]), [], 1.11, 'grid')).toBe(false);
    expect(ladderRetraceTriggered(ot([0.05, 0.1]), [], 1.051, 'grid')).toBe(false);
    expect(ladderRetraceTriggered(ot([0.05, 0.1]), [], 1.05, 'grid')).toBe(true);
    expect(ladderRetraceTriggered(ot([0.05, 0.1]), [], 1.049, 'grid')).toBe(true);
  });

  it('after first grid rung only — retrace exit disabled', () => {
    expect(ladderRetraceTriggered(ot([0.05]), [], 1.06, 'grid')).toBe(false);
    expect(ladderRetraceTriggered(ot([0.05]), [], 1.0, 'grid')).toBe(false);
  });

  it('after first grid rung +5%, positive floor — still no exit until 2nd partial', () => {
    const floor = 0.025;
    expect(ladderRetraceTriggered(ot([0.05]), [], 1.06, 'grid', floor)).toBe(false);
    expect(ladderRetraceTriggered(ot([0.05]), [], 1.026, 'grid', floor)).toBe(false);
    expect(ladderRetraceTriggered(ot([0.05]), [], 1.024, 'grid', floor)).toBe(false);
  });
});

describe('ladderRetraceTriggeredWithSpec adaptive', () => {
  const hitFourth = ot([0.1, 0.2, 0.3, 0.4]);
  const spec = { kind: 'adaptive' as const, minPeakSortedIdx: 3, extraSkipRungs: 1 };

  it('looser floor after 4th rung: pullback that baseline closes survives wider trail', () => {
    expect(ladderRetraceTriggered(hitFourth, ladder, 1.29)).toBe(true);
    expect(ladderRetraceTriggeredWithSpec(hitFourth, ladder, 1.29, 'discrete', 0, spec)).toBe(false);
  });

  it('still exits when price reaches wider floor', () => {
    expect(ladderRetraceTriggeredWithSpec(hitFourth, ladder, 1.2, 'discrete', 0, spec)).toBe(true);
  });
});
