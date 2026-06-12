import { describe, expect, it, beforeEach } from 'vitest';

import type { PaperTraderConfig } from '../src/papertrader/config.js';
import {
  lastExitMarketSnapshotByMintMap,
  lastPostExitBuyCooldownTsByMintMap,
  lastRealExitMarketSnapshotByMintMap,
  recordLastExitMarketSnapshotAfterClose,
} from '../src/papertrader/discovery/dip-clones.js';
import { executionPostExitReentryGateReasons } from '../src/live/phase4-execution.js';

const MINT = 'ExecGateMint111111111111111111111111111111';

function hybridCfg(overrides: Partial<PaperTraderConfig> = {}): PaperTraderConfig {
  return {
    liveReentryMinDropFromLastExitPct: 10,
    liveReentryMaxWaitMinutes: 10,
    liveReentryLossMinDropFromLastExitPct: 10,
    dipLossExitCooldownEnabled: true,
    dipLossExitCooldownMinutes: 10,
    ...overrides,
  } as PaperTraderConfig;
}

describe('execution-layer post-exit re-entry gate', () => {
  beforeEach(() => {
    lastExitMarketSnapshotByMintMap.clear();
    lastRealExitMarketSnapshotByMintMap.clear();
    lastPostExitBuyCooldownTsByMintMap.clear();
  });

  it('blocks buy_open when price has not dipped after KILLSTOP exit', () => {
    recordLastExitMarketSnapshotAfterClose(MINT, Date.now() - 5_000, 1.0, {
      netPnlUsd: -12,
      exitReason: 'KILLSTOP',
    });
    const reasons = executionPostExitReentryGateReasons(hybridCfg(), MINT, 0.95);
    expect(reasons.some((r) => r.startsWith('reentry_wait_dip'))).toBe(true);
  });

  it('allows buy_open when price dipped enough after stress exit', () => {
    recordLastExitMarketSnapshotAfterClose(MINT, Date.now() - 5_000, 1.0, {
      netPnlUsd: -12,
      exitReason: 'KILLSTOP',
    });
    const reasons = executionPostExitReentryGateReasons(hybridCfg(), MINT, 0.89);
    expect(reasons.filter((r) => r.startsWith('reentry_wait_dip'))).toHaveLength(0);
  });

  it('blocks during legacy post-exit loss cooldown minutes', () => {
    lastPostExitBuyCooldownTsByMintMap.set(MINT, Date.now() - 60_000);
    const reasons = executionPostExitReentryGateReasons(hybridCfg(), MINT, 0.5);
    expect(reasons.some((r) => r.startsWith('post_exit_buy_cooldown_'))).toBe(true);
  });
});
