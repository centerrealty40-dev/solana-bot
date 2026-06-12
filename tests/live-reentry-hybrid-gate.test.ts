import { describe, expect, it, beforeEach } from 'vitest';

import type { PaperTraderConfig } from '../src/papertrader/config.js';
import {
  appendLiveReentryHybridGateReasons,
  isLiveReentryHybridGateEnabled,
  lastExitMarketSnapshotByMintMap,
  lastRealExitMarketSnapshotByMintMap,
  recordAfterFullCloseForMintRepeatGateFromClosedTrade,
  recordLastExitMarketSnapshotAfterClose,
  reentryExitSnapshotForGate,
  resolveReconcileOrphanReentryGateMeta,
  shouldPreserveRealExitReentryGate,
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
    lastRealExitMarketSnapshotByMintMap.clear();
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

  it('RECONCILE_ORPHAN does not overwrite recent FLASH_CRASH exit snapshot', () => {
    const flashTs = Date.now() - 10_000;
    const reconcileTs = Date.now() - 5_000;
    recordLastExitMarketSnapshotAfterClose(MINT, flashTs, 0.003895, {
      netPnlUsd: -9.4,
      exitReason: 'FLASH_CRASH_KILL',
    });
    recordLastExitMarketSnapshotAfterClose(MINT, reconcileTs, 0.00465, {
      netPnlUsd: 3.42,
      exitReason: 'RECONCILE_ORPHAN',
    });
    const snap = lastExitMarketSnapshotByMintMap.get(MINT);
    expect(snap?.marketUsd).toBeCloseTo(0.003895, 8);
    expect(snap?.exitReason).toBe('FLASH_CRASH_KILL');
  });

  it('RECONCILE_ORPHAN uses last partial sell price for re-entry gate', () => {
    lastExitMarketSnapshotByMintMap.clear();
    const exitTs = Date.now() - 8_000;
    const ct = {
      mint: MINT,
      exitTs,
      theoretical_exit_price: 0.00465,
      effective_exit_price: 0.00465,
      netPnlUsd: 3.42,
      exitReason: 'RECONCILE_ORPHAN' as const,
    };
    const openTrade = {
      partialSells: [
        {
          marketPrice: 0.003895,
          price: 0.00388,
          reason: 'FLASH_CRASH_KILL',
        },
      ],
    };
    recordAfterFullCloseForMintRepeatGateFromClosedTrade(hybridCfg(), ct, { openTrade });
    const snap = lastExitMarketSnapshotByMintMap.get(MINT);
    expect(snap?.marketUsd).toBeCloseTo(0.003895, 8);
    expect(snap?.exitReason).toBe('FLASH_CRASH_KILL');

    const reasons: string[] = [];
    appendLiveReentryHybridGateReasons(
      { ...hybridCfg(), liveReentryMinDropFromLastExitPct: 12, liveReentryLossMinDropFromLastExitPct: 30 },
      MINT,
      0.0039146,
      reasons,
      Date.now(),
    );
    expect(reasons.some((r) => r.startsWith('reentry_wait_dip'))).toBe(true);
  });

  it('resolveReconcileOrphanReentryGateMeta inherits stress partial reason', () => {
    const meta = resolveReconcileOrphanReentryGateMeta(
      { partialSells: [{ marketPrice: 0.003895, reason: 'FLASH_CRASH_KILL' }] },
      {
        netPnlUsd: 3.42,
        exitReason: 'RECONCILE_ORPHAN',
        theoretical_exit_price: 0.00465,
        effective_exit_price: 0.00465,
      },
    );
    expect(meta?.marketUsd).toBeCloseTo(0.003895, 8);
    expect(meta?.exitReason).toBe('FLASH_CRASH_KILL');
  });

  it('RECONCILE after KILLSTOP does not weaken real exit snapshot (stale TP partial)', () => {
    const cfg = hybridCfg({
      dipLossExitCooldownEnabled: true,
      dipLossExitCooldownMinutes: 10,
    });
    const killTs = 1_000_000;
    recordAfterFullCloseForMintRepeatGateFromClosedTrade(cfg, {
      mint: MINT,
      exitTs: killTs,
      theoretical_exit_price: 0.0056,
      effective_exit_price: 0.005565,
      netPnlUsd: -34,
      exitReason: 'KILLSTOP',
    });
    expect(reentryExitSnapshotForGate(MINT)?.marketUsd).toBeCloseTo(0.0056, 4);

    recordAfterFullCloseForMintRepeatGateFromClosedTrade(
      cfg,
      {
        mint: MINT,
        exitTs: killTs + 21_000,
        theoretical_exit_price: 0.006125,
        effective_exit_price: 0.006178,
        netPnlUsd: 5.27,
        exitReason: 'RECONCILE_ORPHAN',
      },
      {
        openTrade: {
          partialSells: [{ marketPrice: 0.006517, reason: 'TP_LADDER' }],
        },
      },
    );

    expect(reentryExitSnapshotForGate(MINT)?.marketUsd).toBeCloseTo(0.0056, 4);
    expect(shouldPreserveRealExitReentryGate(MINT, 'RECONCILE_ORPHAN', killTs + 21_000, cfg)).toBe(
      true,
    );
  });
});
