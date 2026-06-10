import { describe, expect, it } from 'vitest';
import { blocksMissedEntryLeaderAlreadyIn } from '../../src/pumpswap-combo-follow/entry-eligibility.js';

describe('blocksMissedEntryLeaderAlreadyIn', () => {
  it('allows first entry when leader had zero balance', () => {
    expect(
      blocksMissedEntryLeaderAlreadyIn({
        preLeaderRaw: 0n,
        hasOurPosition: false,
        allowLateEntryOnLeaderAdd: true,
      }),
    ).toBe(false);
  });

  it('blocks late entry when flag off', () => {
    expect(
      blocksMissedEntryLeaderAlreadyIn({
        preLeaderRaw: 1000n,
        hasOurPosition: false,
        allowLateEntryOnLeaderAdd: false,
      }),
    ).toBe(true);
  });

  it('allows late entry on leader add when we have no bag', () => {
    expect(
      blocksMissedEntryLeaderAlreadyIn({
        preLeaderRaw: 1000n,
        hasOurPosition: false,
        allowLateEntryOnLeaderAdd: true,
      }),
    ).toBe(false);
  });

  it('does not block when we already hold (mirror-add path)', () => {
    expect(
      blocksMissedEntryLeaderAlreadyIn({
        preLeaderRaw: 1000n,
        hasOurPosition: true,
        allowLateEntryOnLeaderAdd: false,
      }),
    ).toBe(false);
  });
});
