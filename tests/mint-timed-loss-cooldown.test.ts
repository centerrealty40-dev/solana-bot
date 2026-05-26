import { describe, expect, it, beforeEach } from 'vitest';
import type { LiveOscarConfig } from '../src/live/config.js';
import {
  configureMintTimedLossCooldown,
  isMintTimedLossCooldownActive,
  recordMintTimedLossCooldown,
  resetMintTimedLossCooldownForTests,
} from '../src/live/mint-timed-loss-cooldown.js';

function liveCfg(enabled = true): LiveOscarConfig {
  return {
    liveMintTimedLossCooldownEnabled: enabled,
    liveMintTimedLossCooldownMs: 60_000,
  } as LiveOscarConfig;
}

describe('mint-timed-loss-cooldown', () => {
  beforeEach(() => {
    resetMintTimedLossCooldownForTests();
    configureMintTimedLossCooldown(liveCfg());
  });

  it('arms cooldown only for salvage24 / h48_loss', () => {
    recordMintTimedLossCooldown('mintA', 'salvage24');
    expect(isMintTimedLossCooldownActive(liveCfg(), 'mintA')).toBe(true);
    recordMintTimedLossCooldown('mintB', 'moon50');
    expect(isMintTimedLossCooldownActive(liveCfg(), 'mintB')).toBe(false);
  });

  it('no-op when disabled', () => {
    configureMintTimedLossCooldown(liveCfg(false));
    recordMintTimedLossCooldown('mintA', 'h48_loss');
    expect(isMintTimedLossCooldownActive(liveCfg(false), 'mintA')).toBe(false);
  });
});
