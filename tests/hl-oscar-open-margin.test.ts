import { describe, expect, it } from 'vitest';

import {
  oscarHasMarginForOpen,
  oscarLegMarginUsd,
  oscarOpenFillAcceptable,
  oscarOpenFillMeta,
} from '../src/hyperliquid/oscar-open-margin.js';
import type { HlAccountMargin } from '../src/hyperliquid/twap/hyperliquid-meta.js';
import type { OrderFillResult } from '../src/hyperliquid/twap/live/types.js';

function account(withdrawableUsd: number): HlAccountMargin {
  return {
    accountValueUsd: withdrawableUsd,
    totalMarginUsedUsd: 0,
    withdrawableUsd,
    spotUsdcTotalUsd: null,
    spotUsdcHoldUsd: null,
  };
}

describe('oscar-open-margin', () => {
  it('oscarLegMarginUsd divides gross by leverage', () => {
    expect(oscarLegMarginUsd(100, 2)).toBe(50);
  });

  it('oscarHasMarginForOpen requires margin + reserve', () => {
    expect(oscarHasMarginForOpen(account(74), 50, 25)).toBe(false);
    expect(oscarHasMarginForOpen(account(75), 50, 25)).toBe(true);
  });

  it('oscarOpenFillAcceptable rejects tiny partial fills', () => {
    expect(oscarOpenFillAcceptable(0.24, 100)).toBe(false);
    expect(oscarOpenFillAcceptable(85, 100)).toBe(true);
  });

  it('oscarOpenFillAcceptable accepts full $30 staged leg (no TWAP $50 floor)', () => {
    expect(oscarOpenFillAcceptable(30, 30)).toBe(true);
    expect(oscarOpenFillAcceptable(25, 30)).toBe(false);
  });

  it('oscarOpenFillMeta captures requested vs filled', () => {
    const fill: OrderFillResult = {
      fillPx: 1,
      sizeBase: 0.24,
      notionalUsd: 0.24,
      requestedNotionalUsd: 100,
    };
    const meta = oscarOpenFillMeta(fill, 50, 2, 241);
    expect(meta.requestedGrossUsd).toBe(100);
    expect(meta.filledGrossUsd).toBe(0.24);
    expect(meta.partialFill).toBe(true);
    expect(meta.freeMarginAtOpen).toBe(241);
  });
});
