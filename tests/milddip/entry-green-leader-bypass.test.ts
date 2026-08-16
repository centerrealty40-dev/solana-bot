import { describe, expect, it } from 'vitest';
import { greenLeaderGateBypassAllowed } from '../../src/milddip/entry-attempt.js';
import { loadMildDipConfig } from '../../src/milddip/config.js';
import {
  resetFastPathStateForTests,
  shouldJournalGreenLeaderSeenBypass,
} from '../../src/milddip/fast-path.js';
import type { MildDipConfig } from '../../src/milddip/config.js';
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

describe('GREEN leader-seen config', () => {
  it('defaults to requiring leader-seen and accepts the explicit override', () => {
    const baseEnv = {
      MILD_DIP_EXECUTION_MODE: 'paper',
      MILD_DIP_RPC_URL: 'https://example.invalid',
    };
    const previous = new Map<string, string | undefined>();
    for (const [key, value] of Object.entries(baseEnv)) {
      previous.set(key, process.env[key]);
      process.env[key] = value;
    }
    try {
      delete process.env.MILD_DIP_GREEN_REQUIRE_LEADER_SEEN;
      expect(loadMildDipConfig().greenRequireLeaderSeen).toBe(true);
      process.env.MILD_DIP_GREEN_REQUIRE_LEADER_SEEN = '0';
      expect(loadMildDipConfig().greenRequireLeaderSeen).toBe(false);
    } finally {
      for (const [key, value] of previous) {
        if (value == null) delete process.env[key];
        else process.env[key] = value;
      }
      delete process.env.MILD_DIP_GREEN_REQUIRE_LEADER_SEEN;
    }
  });
});
