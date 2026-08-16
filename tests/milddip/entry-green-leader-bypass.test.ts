import { describe, expect, it } from 'vitest';
import { greenLeaderGateBypassAllowed } from '../../src/milddip/entry-attempt.js';
import {
  resetFastPathStateForTests,
  shouldJournalGreenLeaderSeenBypass,
} from '../../src/milddip/fast-path.js';
import type { MildDipState } from '../../src/milddip/state.js';

const state = {
  cooldownUntilMs: {},
  open: {},
} as MildDipState;

describe('GREEN-only leader-seen bypass', () => {
  it('allows only green momentum when the GREEN gate is disabled', () => {
    const cfg = {
      green: { enabled: true },
      greenRequireLeaderSeen: false,
    } as MildDipConfig;
    expect(greenLeaderGateBypassAllowed(cfg, 'green_momentum')).toBe(true);
    expect(greenLeaderGateBypassAllowed(cfg, 'turn_dump')).toBe(false);
    expect(greenLeaderGateBypassAllowed(cfg, 'knife')).toBe(false);
  });

  it('preserves the leader gate when enabled or GREEN is off', () => {
    expect(
      greenLeaderGateBypassAllowed(
        { green: { enabled: true }, greenRequireLeaderSeen: true } as MildDipConfig,
        'green_momentum',
      ),
    ).toBe(false);
    expect(
      greenLeaderGateBypassAllowed(
        { green: { enabled: false }, greenRequireLeaderSeen: false } as MildDipConfig,
        'green_momentum',
      ),
    ).toBe(false);
  });

  it('deduplicates explicit bypass journals independently by write site', () => {
    resetFastPathStateForTests();
    expect(shouldJournalGreenLeaderSeenBypass('mint', 'fastpath', 1_000)).toBe(true);
    expect(shouldJournalGreenLeaderSeenBypass('mint', 'fastpath', 30_000)).toBe(false);
    expect(shouldJournalGreenLeaderSeenBypass('mint', 'entry', 30_000)).toBe(true);
    expect(shouldJournalGreenLeaderSeenBypass('mint', 'fastpath', 61_000)).toBe(true);
  });
});
