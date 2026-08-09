import { describe, expect, it } from 'vitest';
import {
  isMildDipOrphanMint,
  parseTokenRaw,
  settleAfterSuccessfulSell,
} from '../../src/milddip/sell-settle.js';

describe('settleAfterSuccessfulSell', () => {
  it('keeps runner on partial intent when remainder > dust', () => {
    const v = settleAfterSuccessfulSell({
      fraction: 0.5,
      remainingRaw: 50_000_000n,
    });
    expect(v.action).toBe('keep_runner');
    expect(v.reason).toBe('partial_intent');
  });

  it('keeps runner when "full" sell left remainder (orphan root)', () => {
    const v = settleAfterSuccessfulSell({
      fraction: 1,
      remainingRaw: 12_000_000n,
    });
    expect(v.action).toBe('keep_runner');
    expect(v.reason).toBe('remainder_above_dust');
  });

  it('flats only when confirmed empty / dust', () => {
    const v = settleAfterSuccessfulSell({
      fraction: 1,
      remainingRaw: 100n,
    });
    expect(v.action).toBe('flat');
    expect(v.reason).toBe('confirmed_empty');
  });

  it('never flats blind when RPC remainder unknown', () => {
    const v = settleAfterSuccessfulSell({
      fraction: 0.5,
      remainingRaw: null,
    });
    expect(v.action).toBe('keep_runner');
    expect(v.reason).toBe('remainder_unknown');
  });
});

describe('parseTokenRaw / isMildDipOrphanMint', () => {
  it('parses raw', () => {
    expect(parseTokenRaw('123')).toBe(123n);
    expect(parseTokenRaw('')).toBeNull();
    expect(parseTokenRaw('abc')).toBeNull();
  });

  it('marks pump mints as mild-dip orphans', () => {
    expect(
      isMildDipOrphanMint('6J4fmDstZ9vQoFU9PxmyGgwx5VEcLSeVjdxNrU9Xpump'),
    ).toBe(true);
    expect(isMildDipOrphanMint('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')).toBe(
      false,
    );
  });
});
