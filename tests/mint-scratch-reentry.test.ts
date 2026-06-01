import { describe, expect, it, beforeEach } from 'vitest';
import type { LiveOscarConfig } from '../src/live/config.js';
import {
  configureMintScratchReentry,
  isMintScratchReentryBlocked,
  mintScratchReentryRefPrice,
  mintScratchReentryThresholdPrice,
  recordMintScratchReentry,
  resetMintScratchReentryForTests,
} from '../src/live/mint-scratch-reentry.js';

function liveCfg(enabled = true): LiveOscarConfig {
  return {
    liveMintScratchReentryEnabled: enabled,
    liveMintScratchReentryDropPct: 0.1,
  } as LiveOscarConfig;
}

describe('mint-scratch-reentry', () => {
  beforeEach(() => {
    resetMintScratchReentryForTests();
    configureMintScratchReentry(liveCfg());
  });

  it('blocks re-entry until price drops 10% below last exit ref', () => {
    recordMintScratchReentry('mintA', 1.0);
    expect(mintScratchReentryRefPrice('mintA')).toBe(1.0);
    expect(mintScratchReentryThresholdPrice('mintA', 0.1)).toBeCloseTo(0.9);
    expect(isMintScratchReentryBlocked(liveCfg(), 'mintA', 0.95)).toBe(true);
    expect(isMintScratchReentryBlocked(liveCfg(), 'mintA', 0.9)).toBe(false);
    expect(isMintScratchReentryBlocked(liveCfg(), 'mintA', 0.85)).toBe(false);
  });

  it('no block when disabled or no prior exit ref', () => {
    expect(isMintScratchReentryBlocked(liveCfg(false), 'mintA', 1.5)).toBe(false);
    expect(isMintScratchReentryBlocked(liveCfg(), 'mintB', 1.5)).toBe(false);
  });
});
