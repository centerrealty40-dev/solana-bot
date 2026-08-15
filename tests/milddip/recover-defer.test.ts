import { describe, expect, it } from 'vitest';
import { recoverDeferIsCapped } from '../../src/milddip/recover-defer.js';

describe('recover-defer profit cap', () => {
  it('still defers a losing or flat exit above the bounce threshold', () => {
    expect(recoverDeferIsCapped(-1, 8)).toBe(false);
    expect(recoverDeferIsCapped(0, 8)).toBe(false);
  });

  it('bypasses defer when pnl reaches the cap', () => {
    expect(recoverDeferIsCapped(8, 8)).toBe(true);
    expect(recoverDeferIsCapped(12, 8)).toBe(true);
  });

  it('cap zero preserves the existing behavior', () => {
    expect(recoverDeferIsCapped(100, 0)).toBe(false);
  });
});
