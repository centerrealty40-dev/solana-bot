import { describe, expect, it } from 'vitest';
import {
  coalescedMirrorSellFraction,
  leaderFlatAfterSell,
  leaderLedgerIsZero,
} from '../../src/copytrader/exit-coalesce.js';

describe('leaderFlatAfterSell', () => {
  it('true when sold equals pre-balance', () => {
    expect(leaderFlatAfterSell(1_000_000n, 1_000_000n)).toBe(true);
  });

  it('true when sold exceeds ledger', () => {
    expect(leaderFlatAfterSell(100n, 500n)).toBe(true);
  });

  it('false for partial sell', () => {
    expect(leaderFlatAfterSell(1_000_000n, 150_000n)).toBe(false);
  });
});

describe('coalescedMirrorSellFraction', () => {
  it('coalesces leader 100% exit', () => {
    expect(coalescedMirrorSellFraction(1, 500_000n, 500_000n)).toEqual({
      fraction: 1,
      coalesced: true,
      reason: 'leader_full_exit',
    });
  });

  it('coalesces when last partial empties leader', () => {
    expect(coalescedMirrorSellFraction(0.2, 100_000n, 100_000n)).toEqual({
      fraction: 1,
      coalesced: true,
      reason: 'leader_flat_after_sell',
    });
  });

  it('keeps partial mirror mid-ladder', () => {
    expect(coalescedMirrorSellFraction(0.15, 1_000_000n, 150_000n)).toEqual({
      fraction: 0.15,
      coalesced: false,
    });
  });
});

describe('leaderLedgerIsZero', () => {
  it('treats missing and zero as flat', () => {
    expect(leaderLedgerIsZero(undefined)).toBe(true);
    expect(leaderLedgerIsZero('0')).toBe(true);
  });
});
