import { describe, expect, it } from 'vitest';
import { loadMildDipConfig } from '../../src/milddip/config.js';
import { greenLeaderGateBypassAllowed } from '../../src/milddip/entry-attempt.js';
import {
  resetFastPathStateForTests,
  shouldJournalGreenLeaderSeenBypass,
} from '../../src/milddip/fast-path.js';
import { shouldSampleStreamPrice } from '../../src/milddip/loop.js';
import { MildDipHotMintBuffer } from '../../src/milddip/hot-mints.js';
import type { MildDipConfig } from '../../src/milddip/config.js';
import type { MildDipState } from '../../src/milddip/state.js';

const mint = (suffix: string): string => `${suffix}${'A'.repeat(32 - suffix.length)}`;

const state = {
  cooldownUntilMs: {},
  open: {},
} as MildDipState;

function greenWatchConfig(): MildDipConfig {
  return {
    green: { enabled: true },
    greenWatchEnabled: true,
    greenWatchWindowMs: 600_000,
    greenWatchMinHits: 2,
    greenWatchMaxMints: 2,
    leaderSeenMemoryMs: 0,
  } as MildDipConfig;
}

describe('GREEN own-tape watch', () => {
  it('admits qualified hot mints and rejects cold, low-hit, and out-of-cap mints', () => {
    const nowMs = 1_000_000;
    const hot = new MildDipHotMintBuffer({ maxMints: 20, ttlMs: 900_000 });
    const qualified = mint('qualified');
    const second = mint('second');
    const outOfCap = mint('out');
    const lowHits = mint('low');
    const cold = mint('cold');

    hot.note(qualified, nowMs - 200_000, 3);
    hot.note(second, nowMs - 210_000, 3);
    hot.note(outOfCap, nowMs - 220_000, 3);
    hot.note(lowHits, nowMs - 200_000, 1);
    hot.note(cold, nowMs - 601_000, 5);

    const cfg = greenWatchConfig();
    expect(shouldSampleStreamPrice(cfg, state, qualified, nowMs, 300_000, hot)).toBe(true);
    expect(shouldSampleStreamPrice(cfg, state, second, nowMs, 300_000, hot)).toBe(true);
    expect(shouldSampleStreamPrice(cfg, state, outOfCap, nowMs, 300_000, hot)).toBe(false);
    expect(shouldSampleStreamPrice(cfg, state, lowHits, nowMs, 300_000, hot)).toBe(false);
    expect(shouldSampleStreamPrice(cfg, state, cold, nowMs, 300_000, hot)).toBe(false);
  });

  it('preserves current sampling behavior when GREEN watch is disabled', () => {
    const nowMs = 1_000_000;
    const hot = new MildDipHotMintBuffer({ maxMints: 20, ttlMs: 900_000 });
    const mintName = mint('disabled');
    hot.note(mintName, nowMs, 5);
    const cfg = {
      ...greenWatchConfig(),
      greenWatchEnabled: false,
    } as MildDipConfig;
    expect(shouldSampleStreamPrice(cfg, state, mintName, nowMs, 300_000, hot)).toBe(true);
    expect(
      shouldSampleStreamPrice(
        cfg,
        state,
        mint('older'),
        nowMs,
        300_000,
        hot,
      ),
    ).toBe(false);
  });
});

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
