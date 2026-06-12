import { describe, it, expect, beforeEach } from 'vitest';
import { loadPaperTraderConfig } from '../src/papertrader/config.js';
import {
  appendPostExitReentryGateReasons,
  lastPostExitBuyCooldownTsByMintMap,
  recordPostExitBuyCooldownIfApplicable,
} from '../src/papertrader/discovery/dip-clones.js';

describe('post-exit loss cooldown', () => {
  beforeEach(() => {
    lastPostExitBuyCooldownTsByMintMap.clear();
  });

  it('records cooldown only on loss exits', () => {
    process.env.PAPER_DIP_LOSS_EXIT_COOLDOWN_ENABLED = 'true';
    process.env.PAPER_DIP_LOSS_EXIT_COOLDOWN_MINUTES = '10';
    const cfg = loadPaperTraderConfig();
    const mint = 'mint123';
    recordPostExitBuyCooldownIfApplicable(cfg, mint, 1_000_000, 50);
    expect(lastPostExitBuyCooldownTsByMintMap.has(mint)).toBe(false);
    recordPostExitBuyCooldownIfApplicable(cfg, mint, 2_000_000, -12);
    expect(lastPostExitBuyCooldownTsByMintMap.get(mint)).toBe(2_000_000);
  });

  it('blocks re-entry during 10m loss cooldown with hybrid gate', () => {
    process.env.PAPER_DIP_LOSS_EXIT_COOLDOWN_ENABLED = 'true';
    process.env.PAPER_DIP_LOSS_EXIT_COOLDOWN_MINUTES = '10';
    process.env.LIVE_REENTRY_MIN_DROP_FROM_LAST_EXIT_PCT = '10';
    process.env.LIVE_REENTRY_MAX_WAIT_MINUTES = '240';
    const cfg = loadPaperTraderConfig();
    const mint = 'mint456';
    lastPostExitBuyCooldownTsByMintMap.set(mint, Date.now() - 60_000);
    const reasons: string[] = [];
    appendPostExitReentryGateReasons(cfg, mint, 0.5, reasons);
    expect(reasons.some((r) => r.startsWith('post_exit_buy_cooldown_'))).toBe(true);
  });
});
