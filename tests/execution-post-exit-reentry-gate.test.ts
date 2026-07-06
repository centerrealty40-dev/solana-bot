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
    liveReentryBreakoutAboveExitPct: 20,
    liveReentryMaxWaitMinutes: 10,
    liveReentryLossMinDropFromLastExitPct: 10,
    liveReentryGateMaxAgeHours: 4,
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
    const exitTs = Date.now() - 5_000;
    lastPostExitBuyCooldownTsByMintMap.set(MINT, exitTs);
    recordLastExitMarketSnapshotAfterClose(MINT, exitTs, 1.0, {
      netPnlUsd: -12,
      exitReason: 'KILLSTOP',
    });
    const reasons = executionPostExitReentryGateReasons(hybridCfg(), MINT, 0.95);
    expect(reasons.some((r) => r.startsWith('reentry_wait_dip_below_exit'))).toBe(true);
  });

  it('allows buy_open when price dipped enough after stress exit', () => {
    const exitTs = Date.now() - 5_000;
    lastPostExitBuyCooldownTsByMintMap.set(MINT, exitTs);
    recordLastExitMarketSnapshotAfterClose(MINT, exitTs, 1.0, {
      netPnlUsd: -12,
      exitReason: 'KILLSTOP',
    });
    const reasons = executionPostExitReentryGateReasons(hybridCfg(), MINT, 0.89);
    expect(reasons.filter((r) => r.startsWith('reentry_wait_dip'))).toHaveLength(0);
  });

  it('blocks during legacy post-exit loss cooldown minutes', () => {
    const exitTs = Date.now() - 60_000;
    lastPostExitBuyCooldownTsByMintMap.set(MINT, exitTs);
    recordLastExitMarketSnapshotAfterClose(MINT, exitTs, 1.0, {
      netPnlUsd: -12,
      exitReason: 'KILLSTOP',
    });
    const reasons = executionPostExitReentryGateReasons(hybridCfg(), MINT, 0.95);
    expect(reasons.some((r) => r.startsWith('post_exit_buy_cooldown_'))).toBe(true);
    expect(reasons.some((r) => r.startsWith('reentry_wait_dip_below_exit'))).toBe(true);
  });

  it('blocks buy_open after loss cooldown when price still above -10% dip (fork persists)', () => {
    const exitTs = Date.now() - 11 * 60_000;
    lastPostExitBuyCooldownTsByMintMap.set(MINT, exitTs);
    recordLastExitMarketSnapshotAfterClose(MINT, exitTs, 1.0, {
      netPnlUsd: -12,
      exitReason: 'KILLSTOP',
    });
    const reasons = executionPostExitReentryGateReasons(hybridCfg(), MINT, 0.95);
    expect(reasons.some((r) => r.startsWith('reentry_wait_dip_below_exit'))).toBe(true);
    expect(reasons.filter((r) => r.startsWith('post_exit_buy_cooldown_'))).toHaveLength(0);
  });

  it('allows buy_open after loss cooldown when price dipped -10%', () => {
    const exitTs = Date.now() - 11 * 60_000;
    lastPostExitBuyCooldownTsByMintMap.set(MINT, exitTs);
    recordLastExitMarketSnapshotAfterClose(MINT, exitTs, 1.0, {
      netPnlUsd: -12,
      exitReason: 'KILLSTOP',
    });
    const reasons = executionPostExitReentryGateReasons(hybridCfg(), MINT, 0.89);
    expect(reasons.filter((r) => r.startsWith('reentry_wait'))).toHaveLength(0);
  });
});
