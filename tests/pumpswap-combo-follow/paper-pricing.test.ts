import { describe, expect, it } from 'vitest';
import {
  paperInvestedRemainingUsd,
  paperPnlPctVsAvg,
  paperTokenQty,
} from '../../src/pumpswap-combo-follow/paper-pricing.js';
import type { FollowPosition } from '../../src/pumpswap-combo-follow/types.js';

function pos(partial: Partial<FollowPosition>): FollowPosition {
  return {
    mint: 'mint',
    symbol: 'sym',
    openedAt: Date.now(),
    legs: [{ ts: Date.now(), usd: 3, fillPriceUsd: 1 }],
    botPeakUsd: 1,
    rungsTaken: [],
    leaderWallet: 'leader',
    remainingFrac: 1,
    ...partial,
  };
}

describe('paperTokenQty', () => {
  it('sums legs and applies remainingFrac', () => {
    const p = pos({ remainingFrac: 0.3 });
    expect(paperTokenQty(p)).toBeCloseTo(0.9, 5);
  });
});

describe('paperPnlPctVsAvg', () => {
  it('computes vs volume-weighted avg fill', () => {
    const p = pos({});
    expect(paperPnlPctVsAvg(p, 1.1)).toBeCloseTo(10, 5);
  });
});

describe('paperInvestedRemainingUsd', () => {
  it('scales invested by remainingFrac', () => {
    const p = pos({ remainingFrac: 0.5 });
    expect(paperInvestedRemainingUsd(p)).toBe(1.5);
  });
});
