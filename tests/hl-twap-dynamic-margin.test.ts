import { describe, expect, it } from 'vitest';

import {
  computeOpenMarginUsd,
  dcaHeadroomUsd,
  targetMarginByOpenCount,
} from '../src/hyperliquid/twap/live/dynamic-margin.js';
import type { HlTwapLiveOpen } from '../src/hyperliquid/twap/live/types.js';

function cfg(overrides: Partial<ReturnType<typeof baseCfg>> = {}) {
  return { ...baseCfg(), ...overrides };
}

function baseCfg() {
  return {
    notionalUsd: 800,
    marginLev3Usd: 1500,
    marginLev5Usd: 1000,
    marginLev7Usd: 800,
    leverage: 7,
    dynamicMargin: true,
    marginMaxUsd: 800,
    marginMinUsd: 300,
    dynamicMarginMaxAtOpenCount: 2,
    dynamicMarginMinAtOpenCount: 5,
    dynamicMarginDcaLevelsReserve: 2,
    ladderSlicePct: 30,
    marginReserveUsd: 50,
  };
}

function open(notional: number, lev = 7): HlTwapLiveOpen {
  return {
    hash: 'h1',
    coin: 'BTC',
    displaySymbol: 'BTC',
    side: 'buy',
    entryTs: 1,
    entryAnchorPx: 100_000,
    avgEntryPx: 100_000,
    initialNotionalUsd: notional,
    currentNotionalUsd: notional,
    marginUsd: notional / lev,
    entryLeverage: lev,
    impactPct: 5,
    whaleUser: '0x1',
    minutes: 30,
    liveOpenAtMs: 1,
    liveCloseAtMs: 2,
    twapStartMs: 1,
    tpLevelsTaken: 0,
    dcaLevelsTaken: 0,
    whaleNotionalUsd: 1e6,
    whaleSize: 1,
  };
}

describe('targetMarginByOpenCount', () => {
  it('uses max margin at or below maxAt open count', () => {
    expect(targetMarginByOpenCount(0, cfg())).toBe(800);
    expect(targetMarginByOpenCount(2, cfg())).toBe(800);
  });

  it('uses min margin at or above minAt open count', () => {
    expect(targetMarginByOpenCount(5, cfg())).toBe(300);
    expect(targetMarginByOpenCount(9, cfg())).toBe(300);
  });

  it('interpolates between maxAt and minAt', () => {
    expect(targetMarginByOpenCount(3, cfg())).toBeCloseTo(633, 0);
    expect(targetMarginByOpenCount(4, cfg())).toBeCloseTo(467, 0);
  });
});

describe('dcaHeadroomUsd', () => {
  it('reserves two ladder slices of margin', () => {
    expect(dcaHeadroomUsd(800, cfg())).toBeCloseTo(480);
  });
});

describe('computeOpenMarginUsd', () => {
  it('returns lev-tier margin when dynamic margin disabled', () => {
    const account = { accountValueUsd: 1100, totalMarginUsedUsd: 0, withdrawableUsd: 1100 };
    expect(computeOpenMarginUsd(account, new Map(), cfg({ dynamicMargin: false }))).toBe(800);
    expect(computeOpenMarginUsd(account, new Map(), cfg({ dynamicMargin: false }), 3)).toBe(1500);
    expect(computeOpenMarginUsd(account, new Map(), cfg({ dynamicMargin: false }), 5)).toBe(1000);
  });

  it('scales up with few opens and ample free margin', () => {
    const account = { accountValueUsd: 1100, totalMarginUsedUsd: 0, withdrawableUsd: 1100 };
    expect(computeOpenMarginUsd(account, new Map(), cfg())).toBe(570);
  });

  it('scales down with many open positions', () => {
    const account = { accountValueUsd: 1100, totalMarginUsedUsd: 850, withdrawableUsd: 250 };
    const opens = new Map<string, HlTwapLiveOpen>([
      ['h1', open(1610, 7)],
      ['h2', open(1610, 7)],
      ['h3', open(1610, 7)],
      ['h4', open(1610, 7)],
      ['h5', open(1610, 7)],
    ]);
    expect(computeOpenMarginUsd(account, opens, cfg())).toBe(300);
  });

  it('caps by affordable free margin including DCA reserve', () => {
    const account = { accountValueUsd: 1000, totalMarginUsedUsd: 0, withdrawableUsd: 1000 };
    const margin = computeOpenMarginUsd(account, new Map(), cfg());
    const headroom = margin * 0.3 * 2;
    expect(margin + 50 + headroom).toBeLessThanOrEqual(1000 + 1);
    expect(margin).toBeLessThan(800);
  });
});
