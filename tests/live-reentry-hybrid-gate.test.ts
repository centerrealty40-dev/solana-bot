import { describe, expect, it, beforeEach } from 'vitest';

import type { PaperTraderConfig } from '../src/papertrader/config.js';
import {
  appendLiveReentryHybridGateReasons,
  isLiveReentryHybridGateEnabled,
  lastExitMarketSnapshotByMintMap,
  recordLastExitMarketSnapshotAfterClose,
} from '../src/papertrader/discovery/dip-clones.js';

const MINT = 'TestMint1111111111111111111111111111111111';

function hybridCfg(overrides: Partial<PaperTraderConfig> = {}): PaperTraderConfig {
  return {
    liveReentryMinDropFromLastExitPct: 20,
    liveReentryMaxWaitMinutes: 20,
    liveReentryLossMinDropFromLastExitPct: 30,
    liveReentryHybridDisableTimerAfterLoss: true,
    liveReentryGateMaxAgeHours: 4,
    ...overrides,
  } as PaperTraderConfig;
}

describe('live re-entry hybrid gate', () => {
  beforeEach(() => {
    lastExitMarketSnapshotByMintMap.clear();
  });

  it('enabled when drop and max wait both set', () => {
    expect(isLiveReentryHybridGateEnabled(hybridCfg())).toBe(true);
    expect(
      isLiveReentryHybridGateEnabled({ liveReentryMinDropFromLastExitPct: 0 } as PaperTraderConfig),
    ).toBe(false);
  });

  it('blocks when price above -20% from last exit', () => {
    const exitTs = Date.now() - 10 * 60_000;
    recordLastExitMarketSnapshotAfterClose(MINT, exitTs, 1.0);
    const reasons: string[] = [];
    appendLiveReentryHybridGateReasons(hybridCfg(), MINT, 0.85, reasons, Date.now());
    expect(reasons.some((r) => r.startsWith('reentry_wait_dip20pct'))).toBe(true);
  });

  it('allows dip re-entry when price hit -20%', () => {
    const exitTs = Date.now() - 10 * 60_000;
    recordLastExitMarketSnapshotAfterClose(MINT, exitTs, 1.0);
    const reasons: string[] = [];
    appendLiveReentryHybridGateReasons(hybridCfg(), MINT, 0.79, reasons, Date.now());
    expect(reasons).toHaveLength(0);
  });

  it('blocks same-price re-entry after 20m (no timer fallback)', () => {
    const exitTs = Date.now() - 21 * 60_000;
    recordLastExitMarketSnapshotAfterClose(MINT, exitTs, 1.0, { netPnlUsd: 50, exitReason: 'TRAIL' });
    const reasons: string[] = [];
    appendLiveReentryHybridGateReasons(hybridCfg(), MINT, 1.0, reasons, Date.now());
    expect(reasons.some((r) => r.startsWith('reentry_wait_dip'))).toBe(true);
  });

  it('after loss: still requires dip after 20m', () => {
    const exitTs = Date.now() - 25 * 60_000;
    recordLastExitMarketSnapshotAfterClose(MINT, exitTs, 1.0, {
      netPnlUsd: -22,
      exitReason: 'FLASH_CRASH_KILL',
    });
    const reasons: string[] = [];
    appendLiveReentryHybridGateReasons(hybridCfg(), MINT, 0.85, reasons, Date.now());
    expect(reasons.some((r) => r.includes('_loss'))).toBe(true);
  });

  it('expires re-entry gate after max age hours', () => {
    const exitTs = Date.now() - 5 * 3_600_000;
    recordLastExitMarketSnapshotAfterClose(MINT, exitTs, 1.0, { netPnlUsd: 50, exitReason: 'TP' });
    const reasons: string[] = [];
    appendLiveReentryHybridGateReasons(hybridCfg(), MINT, 1.05, reasons, Date.now());
    expect(reasons).toHaveLength(0);
  });

  it('after loss: requires 30% dip not 20%', () => {
    const exitTs = Date.now() - 5 * 60_000;
    recordLastExitMarketSnapshotAfterClose(MINT, exitTs, 1.0, { netPnlUsd: -10, exitReason: 'SL' });
    const reasons: string[] = [];
    appendLiveReentryHybridGateReasons(hybridCfg(), MINT, 0.75, reasons, Date.now());
    expect(reasons.some((r) => r.includes('dip30pct') || r.includes('dip30pct_loss'))).toBe(true);
    const ok: string[] = [];
    appendLiveReentryHybridGateReasons(hybridCfg(), MINT, 0.69, ok, Date.now());
    expect(ok).toHaveLength(0);
  });
});
