import { describe, expect, it } from 'vitest';
import { shouldIgnoreMissedEntryLeaderRebuy } from '../../src/copytrader/entry-late.js';

describe('late entry on leader rebuy', () => {
  it('enters on leader rebuy when allowLateEntryOnLeaderRebuy is true (default)', () => {
    expect(shouldIgnoreMissedEntryLeaderRebuy({ allowLateEntryOnLeaderRebuy: true }, 240_000_000_000n)).toBe(
      false,
    );
  });

  it('ignores leader rebuy only when allowLateEntryOnLeaderRebuy is false', () => {
    expect(shouldIgnoreMissedEntryLeaderRebuy({ allowLateEntryOnLeaderRebuy: false }, 240_000_000_000n)).toBe(
      true,
    );
  });

  it('does not treat fresh leader entry as missed rebuy', () => {
    expect(shouldIgnoreMissedEntryLeaderRebuy({ allowLateEntryOnLeaderRebuy: false }, 0n)).toBe(false);
    expect(shouldIgnoreMissedEntryLeaderRebuy({ allowLateEntryOnLeaderRebuy: true }, 0n)).toBe(false);
  });
});
