import { describe, it, expect } from 'vitest';
import { parseDcaLevels } from '../src/papertrader/config.js';
import { dcaCrossedDownward, reconcileOpenTradeDcaFromLegs } from '../src/papertrader/executor/dca-state.js';
import type { OpenTrade } from '../src/papertrader/types.js';

function emptyOt(): OpenTrade {
  return {
    mint: 'x',
    symbol: 'T',
    lane: 'post_migration',
    metricType: 'price',
    dex: 'raydium',
    entryTs: 0,
    entryMcUsd: 1,
    entryMetrics: {
      uniqueBuyers: 0,
      uniqueSellers: 0,
      sumBuySol: 0,
      sumSellSol: 0,
      topBuyerShare: 0,
      bcProgress: 0,
    },
    peakMcUsd: 1,
    peakPnlPct: 0,
    trailingArmed: false,
    legs: [
      { ts: 0, price: 1, marketPrice: 1, sizeUsd: 100, reason: 'open' },
      { ts: 1, price: 0.9, marketPrice: 0.9, sizeUsd: 30, reason: 'dca', triggerPct: -0.1 },
    ],
    partialSells: [],
    totalInvestedUsd: 130,
    avgEntry: 1,
    avgEntryMarket: 1,
    remainingFraction: 1,
    dcaUsedLevels: new Set(),
    dcaUsedIndices: new Set(),
    ladderUsedLevels: new Set(),
    ladderUsedIndices: new Set(),
    pairAddress: null,
    entryLiqUsd: null,
  } as OpenTrade;
}

describe('dcaCrossedDownward', () => {
  it('fires on first dip through level (prev above)', () => {
    expect(dcaCrossedDownward(Number.POSITIVE_INFINITY, -0.08, -0.07)).toBe(true);
  });
  it('no fire on recovery toward shallower (prev deeper)', () => {
    expect(dcaCrossedDownward(-0.1, -0.04, -0.07)).toBe(false);
  });
  it('re-test after partial rally requires new downward cross (if level not yet taken)', () => {
    expect(dcaCrossedDownward(-0.04, -0.08, -0.07)).toBe(true);
  });
});

describe('reconcileOpenTradeDcaFromLegs', () => {
  it('marks steps from dca legs when indices missing', () => {
    const spec = parseDcaLevels('-7:0.3,-14:0.3');
    const ot = emptyOt();
    ot.legs[1]!.triggerPct = -0.07;
    reconcileOpenTradeDcaFromLegs(ot, spec);
    expect(ot.dcaUsedIndices.has(0)).toBe(true);
  });
});

describe('parseDcaLevels', () => {
  it('orders shallower (less negative) trigger first for Oscar-style spec', () => {
    const lv = parseDcaLevels('-7:0.3,-14:0.3');
    expect(lv[0]!.triggerPct).toBeGreaterThan(lv[1]!.triggerPct);
  });
});
