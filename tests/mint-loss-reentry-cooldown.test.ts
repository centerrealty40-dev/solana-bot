import { describe, expect, it, beforeEach } from 'vitest';
import type { LiveOscarConfig } from '../src/live/config.js';
import {
  appendMintLossReentryCooldownReason,
  configureMintLossReentryCooldown,
  isMintLossReentryCooldownActive,
  mintLossReentryCooldownRemainingMs,
  recordMintLossReentryCooldown,
  resetMintLossReentryCooldownForTests,
} from '../src/live/mint-loss-reentry-cooldown.js';

const MINT = 'LossMint11111111111111111111111111111111';

function liveCfg(enabled = true): LiveOscarConfig {
  return {
    liveMintLossReentryCooldownEnabled: enabled,
    liveMintLossReentryCooldownMs: 6 * 3_600_000,
    liveMintLossReentryStreakWindowMs: 24 * 3_600_000,
    liveMintLossReentryStreakMax: 2,
    liveMintLossReentryStreakCooldownMs: 24 * 3_600_000,
  } as LiveOscarConfig;
}

describe('mint-loss-reentry-cooldown', () => {
  beforeEach(() => {
    resetMintLossReentryCooldownForTests();
    configureMintLossReentryCooldown(liveCfg());
  });

  it('arms cooldown after negative pnl exit', () => {
    const ts = Date.now();
    recordMintLossReentryCooldown({ mint: MINT, netPnlUsd: -12.5, exitTsMs: ts, exitReason: 'TRAIL' });
    expect(isMintLossReentryCooldownActive(liveCfg(), MINT)).toBe(true);
    expect(mintLossReentryCooldownRemainingMs(MINT)).toBeGreaterThan(0);
  });

  it('arms cooldown after stress exit even when pnl flat', () => {
    recordMintLossReentryCooldown({
      mint: MINT,
      netPnlUsd: 0,
      exitTsMs: Date.now(),
      exitReason: 'FLASH_CRASH_KILL',
    });
    expect(isMintLossReentryCooldownActive(liveCfg(), MINT)).toBe(true);
  });

  it('skips profitable non-stress exit', () => {
    recordMintLossReentryCooldown({
      mint: MINT,
      netPnlUsd: 40,
      exitTsMs: Date.now(),
      exitReason: 'TRAIL',
    });
    expect(isMintLossReentryCooldownActive(liveCfg(), MINT)).toBe(false);
  });

  it('extends to streak cooldown after second loss within window', () => {
    const t0 = Date.now() - 60_000;
    recordMintLossReentryCooldown({ mint: MINT, netPnlUsd: -5, exitTsMs: t0, exitReason: 'SL' });
    const t1 = Date.now();
    recordMintLossReentryCooldown({ mint: MINT, netPnlUsd: -8, exitTsMs: t1, exitReason: 'FLASH_CRASH_KILL' });
    const remaining = mintLossReentryCooldownRemainingMs(MINT);
    expect(remaining).toBeGreaterThan(23 * 3_600_000);
  });

  it('appendMintLossReentryCooldownReason adds discovery skip tag', () => {
    recordMintLossReentryCooldown({ mint: MINT, netPnlUsd: -1, exitTsMs: Date.now(), exitReason: 'SL' });
    const out: string[] = [];
    appendMintLossReentryCooldownReason(MINT, out);
    expect(out.some((r) => r.startsWith('loss_reentry_cooldown_'))).toBe(true);
  });

  it('no-op when disabled', () => {
    configureMintLossReentryCooldown(liveCfg(false));
    recordMintLossReentryCooldown({ mint: MINT, netPnlUsd: -1, exitTsMs: Date.now(), exitReason: 'SL' });
    expect(isMintLossReentryCooldownActive(liveCfg(false), MINT)).toBe(false);
  });
});
