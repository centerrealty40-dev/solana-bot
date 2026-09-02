import { describe, expect, it } from 'vitest';
import { leaderActiveMayBypassRebuyBelowExit } from '../../src/milddip/gates.js';

describe('leader-active rebuy-below-exit bypass', () => {
  it('does not bypass after a losing exit', () => {
    expect(
      leaderActiveMayBypassRebuyBelowExit({ leaderActive: true, lastExitPnlPct: -3 }),
    ).toBe(false);
  });

  it('preserves the bypass for non-losing exits', () => {
    expect(
      leaderActiveMayBypassRebuyBelowExit({ leaderActive: true, lastExitPnlPct: 2 }),
    ).toBe(true);
    expect(
      leaderActiveMayBypassRebuyBelowExit({ leaderActive: true, lastExitPnlPct: null }),
    ).toBe(true);
  });
});
