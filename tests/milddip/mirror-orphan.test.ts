import { describe, expect, it } from 'vitest';
import { decideMirrorOrphanClose } from '../../src/milddip/mirror-orphan.js';

const settled = {
  markPriceUsd: 1,
  entrySettlementAgeMs: 60_000,
  firstClipPending: false,
  minSettleSec: 45,
  dustUsd: 0.1,
};

describe('mirror orphan reconciliation', () => {
  it('closes a successfully read zero balance', () => {
    expect(decideMirrorOrphanClose({ ...settled, balanceRaw: '0' })).toEqual({
      close: true,
      balanceRaw: 0n,
      balanceMarketUsd: 0,
    });
  });

  it('does not close after a failed balance read', () => {
    expect(decideMirrorOrphanClose({ ...settled, balanceRaw: null })).toEqual({
      close: false,
      reason: 'read_failed',
    });
  });

  it('does not close inside the first-clip or settlement windows', () => {
    expect(
      decideMirrorOrphanClose({ ...settled, balanceRaw: '1', firstClipPending: true }),
    ).toEqual({ close: false, reason: 'entry_settling' });
    expect(
      decideMirrorOrphanClose({ ...settled, balanceRaw: '1', entrySettlementAgeMs: 44_999 }),
    ).toEqual({ close: false, reason: 'entry_settling' });
  });

  it('does not close a non-dust balance', () => {
    expect(decideMirrorOrphanClose({ ...settled, balanceRaw: '1000000' })).toEqual({
      close: false,
      reason: 'balance_above_dust',
    });
  });

  it('closes a settled balance below the configured dust value', () => {
    expect(decideMirrorOrphanClose({ ...settled, balanceRaw: '50000' })).toEqual({
      close: true,
      balanceRaw: 50000n,
      balanceMarketUsd: 0.05,
    });
  });
});
