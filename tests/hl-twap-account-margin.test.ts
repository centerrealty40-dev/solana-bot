import { describe, expect, it } from 'vitest';

import { parseSpotUsdcBalance } from '../src/hyperliquid/twap/hyperliquid-meta.js';
import {
  freeMarginUsd,
  hasMarginForNewOpen,
  marginUsedFromJournalOpens,
} from '../src/hyperliquid/twap/live/account-margin.js';
import type { HlTwapLiveOpen } from '../src/hyperliquid/twap/live/types.js';

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

describe('parseSpotUsdcBalance', () => {
  it('reads unified account USDC from spot clearinghouse', () => {
    const bal = parseSpotUsdcBalance({
      balances: [
        { coin: 'PURR', total: '100', hold: '0' },
        { coin: 'USDC', total: '1009.027498', hold: '12.5' },
      ],
    });
    expect(bal.totalUsd).toBeCloseTo(1009.027498);
    expect(bal.holdUsd).toBeCloseTo(12.5);
    expect(bal.freeUsd).toBeCloseTo(996.527498);
  });
});

describe('account margin gating', () => {
  it('sums journal margin from gross notional / leverage', () => {
    const opens = new Map([['h1', open(2450, 7)]]);
    expect(marginUsedFromJournalOpens(opens)).toBeCloseTo(350);
  });

  it('blocks new open when free margin insufficient', () => {
    const opens = new Map([
      ['h1', open(2450, 7)],
      ['h2', open(2450, 7)],
    ]);
    const account = { accountValueUsd: 960, totalMarginUsedUsd: 700, withdrawableUsd: 100 };
    expect(hasMarginForNewOpen(account, opens, 350)).toBe(false);
    expect(freeMarginUsd(account, opens)).toBeCloseTo(260);
  });

  it('allows new open when margin available', () => {
    const opens = new Map([['h1', open(2450, 7)]]);
    const account = { accountValueUsd: 960, totalMarginUsedUsd: 350, withdrawableUsd: 500 };
    expect(hasMarginForNewOpen(account, opens, 350)).toBe(true);
  });

  it('allows open on unified account when perp accountValue is 0 but spot USDC is set', () => {
    const opens = new Map<string, HlTwapLiveOpen>();
    const account = {
      accountValueUsd: 1009,
      totalMarginUsedUsd: 0,
      withdrawableUsd: 1009,
      spotUsdcTotalUsd: 1009,
      spotUsdcHoldUsd: 0,
    };
    expect(hasMarginForNewOpen(account, opens, 350)).toBe(true);
    expect(freeMarginUsd(account, opens)).toBeCloseTo(1009);
  });
});
