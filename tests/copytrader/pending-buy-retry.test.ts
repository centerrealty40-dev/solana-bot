import { describe, expect, it } from 'vitest';
import {
  cancelPendingBuysForMint,
  computeRetryUntilTs,
  isPendingBuyExpired,
  removePendingBuyById,
  shouldLogBuyDefer,
} from '../../src/copytrader/pending-buy-retry.js';
import type { PendingBuy } from '../../src/copytrader/state.js';

function pb(over: Partial<PendingBuy> = {}): PendingBuy {
  return {
    id: 'pb_test',
    mint: 'Mint1111111111111111111111111111111111111',
    symbol: 'T',
    kind: 'entry',
    sizeUsd: 50,
    leaderSignature: 'sig',
    leaderPriceUsd: 0.001,
    leaderBuyUsd: 100,
    leaderBuyTs: 1_000,
    dueTs: 10_000,
    retryUntilTs: 3_610_000,
    ...over,
  };
}

describe('pending buy retry helpers', () => {
  it('expires after retryUntilTs', () => {
    const p = pb({ retryUntilTs: 1000 });
    expect(isPendingBuyExpired(p, 999)).toBe(false);
    expect(isPendingBuyExpired(p, 1001)).toBe(true);
  });

  it('computes retryUntil from due + window', () => {
    expect(computeRetryUntilTs(10_000, 120_000)).toBe(130_000);
  });

  it('throttles defer logs', () => {
    const p = pb({ lastDeferLogTs: 1000 });
    expect(shouldLogBuyDefer(p, 1050, 60_000)).toBe(false);
    expect(shouldLogBuyDefer(p, 61_500, 60_000)).toBe(true);
  });

  it('cancels pending entry by mint', () => {
    const state = { pendingBuys: [pb(), pb({ id: 'pb2', kind: 'add' })] };
    const removed = cancelPendingBuysForMint(state, pb().mint, 'entry');
    expect(removed).toHaveLength(1);
    expect(state.pendingBuys).toHaveLength(1);
    expect(state.pendingBuys[0]!.kind).toBe('add');
  });

  it('removePendingBuyById mutates queue', () => {
    const state = { pendingBuys: [pb(), pb({ id: 'pb2' })] };
    const removed = removePendingBuyById(state, 'pb2');
    expect(removed?.id).toBe('pb2');
    expect(state.pendingBuys).toHaveLength(1);
  });
});
