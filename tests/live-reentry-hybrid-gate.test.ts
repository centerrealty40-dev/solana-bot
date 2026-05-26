import { describe, expect, it, beforeEach } from 'vitest';

import type { PaperTraderConfig } from '../src/papertrader/config.js';
import {
  appendLiveReentryHybridGateReasons,
  isLiveReentryHybridGateEnabled,
  lastExitMarketSnapshotByMintMap,
  recordLastExitMarketSnapshotAfterClose,
} from '../src/papertrader/discovery/dip-clones.js';

const MINT = 'TestMint1111111111111111111111111111111111';

function hybridCfg(): PaperTraderConfig {
  return {
    liveReentryMinDropFromLastExitPct: 12,
    liveReentryMaxWaitMinutes: 20,
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

  it('blocks before 20m when price above -12% from last exit', () => {
    const exitTs = Date.now() - 10 * 60_000;
    recordLastExitMarketSnapshotAfterClose(MINT, exitTs, 1.0);
    const reasons: string[] = [];
    appendLiveReentryHybridGateReasons(hybridCfg(), MINT, 0.95, reasons, Date.now());
    expect(reasons.some((r) => r.startsWith('reentry_hybrid_wait_dip12pct_or_20m'))).toBe(true);
  });

  it('allows dip re-entry before 20m when price hit -12%', () => {
    const exitTs = Date.now() - 10 * 60_000;
    recordLastExitMarketSnapshotAfterClose(MINT, exitTs, 1.0);
    const reasons: string[] = [];
    appendLiveReentryHybridGateReasons(hybridCfg(), MINT, 0.87, reasons, Date.now());
    expect(reasons).toHaveLength(0);
  });

  it('allows time fallback after 20m even above -12% (runner case)', () => {
    const exitTs = Date.now() - 21 * 60_000;
    recordLastExitMarketSnapshotAfterClose(MINT, exitTs, 1.0);
    const reasons: string[] = [];
    appendLiveReentryHybridGateReasons(hybridCfg(), MINT, 1.05, reasons, Date.now());
    expect(reasons).toHaveLength(0);
  });
});
