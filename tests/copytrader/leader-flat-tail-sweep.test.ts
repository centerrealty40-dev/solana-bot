import { describe, expect, it } from 'vitest';
import { hasPendingSellForMint } from '../../src/copytrader/leader-flat-tail-sweep.js';
import { leaderPreBalanceRaw } from '../../src/copytrader/leader-ledger.js';
import { emptyCopyTraderState } from '../../src/copytrader/state.js';

describe('leader flat tail sweep', () => {
  it('detects pending sell for mint', () => {
    const state = emptyCopyTraderState();
    state.pendingSells.push({
      id: 'ps_1',
      mint: 'mintA',
      symbol: 'A',
      leaderSignature: 'sig',
      leaderSellTs: 0,
      dueTs: 0,
      fraction: 1,
      retryUntilTs: 9999,
    });
    expect(hasPendingSellForMint(state, 'mintA')).toBe(true);
    expect(hasPendingSellForMint(state, 'mintB')).toBe(false);
  });

  it('leader ledger zero after full exit', () => {
    const state = emptyCopyTraderState();
    state.leaderLedger.mintA = { tokenRaw: '0' };
    expect(leaderPreBalanceRaw(state, 'mintA')).toBe(0n);
  });
});
