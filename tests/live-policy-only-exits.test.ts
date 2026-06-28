import { afterEach, describe, expect, it } from 'vitest';
import type { LiveOscarConfig } from '../src/live/config.js';
import {
  clearPostHealChurnBlocksForTests,
  isPolicyAllowedFullExitReason,
  isPolicyAllowedPartialSell,
  livePolicyBlocksHealSyncSells,
  livePolicyOnlyExitsEnabled,
  postHealChurnGateReason,
  recordPostHealChurnBlock,
} from '../src/live/policy-only-exits.js';

function liveCfg(over: Partial<LiveOscarConfig> = {}): LiveOscarConfig {
  return {
    livePolicyOnlyExitsEnabled: true,
    livePolicyPostHealChurnBlockMs: 0,
    ...over,
  } as LiveOscarConfig;
}

describe('policy-only-exits', () => {
  afterEach(() => {
    clearPostHealChurnBlocksForTests();
  });

  it('defaults enabled when livePolicyOnlyExitsEnabled is true', () => {
    expect(livePolicyOnlyExitsEnabled(liveCfg())).toBe(true);
    expect(livePolicyBlocksHealSyncSells(liveCfg())).toBe(true);
  });

  it('allows only kill/trail/TP/breakeven full exits when enabled', () => {
    const cfg = liveCfg();
    expect(isPolicyAllowedFullExitReason('KILLSTOP', cfg)).toBe(true);
    expect(isPolicyAllowedFullExitReason('TRAIL', cfg)).toBe(true);
    expect(isPolicyAllowedFullExitReason('TP', cfg)).toBe(true);
    expect(isPolicyAllowedFullExitReason('BREAKEVEN_EXIT', cfg)).toBe(true);
    expect(isPolicyAllowedFullExitReason('SL', cfg)).toBe(true);

    expect(isPolicyAllowedFullExitReason('TIMEOUT', cfg)).toBe(false);
    expect(isPolicyAllowedFullExitReason('FLASH_CRASH_KILL', cfg)).toBe(false);
    expect(isPolicyAllowedFullExitReason('PERIODIC_HEAL', cfg)).toBe(false);
    expect(isPolicyAllowedFullExitReason('RECONCILE_ORPHAN', cfg)).toBe(false);
    expect(isPolicyAllowedFullExitReason('WAVE_B_POST_TP1_SCRATCH', cfg)).toBe(false);
    expect(isPolicyAllowedFullExitReason('CAPITAL_ROTATE', cfg)).toBe(false);
  });

  it('allows wave B ladder partials; blocks flash/scratch partials', () => {
    const cfg = liveCfg();
    expect(isPolicyAllowedPartialSell('TP_LADDER', cfg)).toBe(true);
    expect(isPolicyAllowedPartialSell('TRAIL_STEP', cfg)).toBe(true);
    expect(isPolicyAllowedPartialSell('BREAKEVEN_TRIM', cfg)).toBe(true);
    expect(isPolicyAllowedPartialSell('WAVE_B_BREAKEVEN_INSURANCE', cfg)).toBe(true);

    expect(isPolicyAllowedPartialSell('FLASH_CRASH_KILL', cfg)).toBe(false);
    expect(isPolicyAllowedPartialSell('SCRATCH_FLUSH0', cfg)).toBe(false);
    expect(isPolicyAllowedPartialSell('THIN_VOL_FLUSH', cfg)).toBe(false);
  });

  it('passes through all reasons when disabled', () => {
    const cfg = liveCfg({ livePolicyOnlyExitsEnabled: false });
    expect(isPolicyAllowedFullExitReason('TIMEOUT', cfg)).toBe(true);
    expect(isPolicyAllowedPartialSell('FLASH_CRASH_KILL', cfg)).toBe(true);
    expect(livePolicyBlocksHealSyncSells(cfg)).toBe(false);
  });

  it('optional post-heal churn block gates re-buy', () => {
    const mint = 'MintHealChurnBlockaaaaaaaaaaaaaaaaaaaaaaa';
    const cfg = liveCfg({ livePolicyPostHealChurnBlockMs: 60_000 });
    expect(postHealChurnGateReason(mint, cfg)).toBeNull();
    recordPostHealChurnBlock(mint, cfg);
    const reason = postHealChurnGateReason(mint, cfg);
    expect(reason).toMatch(/^post_heal_churn_block:/);
  });
});
