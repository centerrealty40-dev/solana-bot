import { describe, expect, it } from 'vitest';
import {
  isPendingBuyDoomedByMcap,
  isTerminalCopyBuyEvalFailure,
  sortPendingBuysNewestFirst,
} from '../../src/copytrader/pending-buy-queue.js';
import type { PendingBuy } from '../../src/copytrader/state.js';

function pb(over: Partial<PendingBuy> & { id: string }): PendingBuy {
  return {
    mint: 'm',
    symbol: 's',
    kind: 'entry',
    sizeUsd: 100,
    leaderSignature: 'sig',
    leaderPriceUsd: 1,
    leaderBuyUsd: 100,
    leaderBuyTs: 0,
    dueTs: 0,
    retryUntilTs: 1,
    ...over,
  };
}

describe('sortPendingBuysNewestFirst', () => {
  it('orders by leaderBuyTs descending', () => {
    const sorted = sortPendingBuysNewestFirst([
      pb({ id: 'old', leaderBuyTs: 1000 }),
      pb({ id: 'new', leaderBuyTs: 3000 }),
      pb({ id: 'mid', leaderBuyTs: 2000 }),
    ]);
    expect(sorted.map((p) => p.id)).toEqual(['new', 'mid', 'old']);
  });
});

describe('isTerminalCopyBuyEvalFailure', () => {
  it('treats mcap floor as terminal', () => {
    expect(isTerminalCopyBuyEvalFailure(['mcap=1826<min=150000'])).toBe(true);
  });

  it('does not treat premium as terminal', () => {
    expect(isTerminalCopyBuyEvalFailure(['premium=6.1%>max=5%'])).toBe(false);
  });
});

describe('isPendingBuyDoomedByMcap', () => {
  it('flags stored mcap below floor', () => {
    expect(isPendingBuyDoomedByMcap({ entryMcapUsd: 1826 }, 150_000)).toBe(true);
    expect(isPendingBuyDoomedByMcap({ entryMcapUsd: 200_000 }, 150_000)).toBe(false);
    expect(isPendingBuyDoomedByMcap({}, 150_000)).toBe(false);
  });
});
