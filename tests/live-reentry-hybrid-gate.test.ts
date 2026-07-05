import { describe, expect, it, beforeEach } from 'vitest';

import type { PaperTraderConfig } from '../src/papertrader/config.js';
import {
  appendLiveReentryHybridGateReasons,
  isLiveReentryHybridGateEnabled,
  lastExitMarketSnapshotByMintMap,
  lastPostExitBuyCooldownTsByMintMap,
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
    dipLossExitCooldownEnabled: true,
    dipLossExitCooldownMinutes: 10,
    dipLossExitCooldownHours: 0,
    ...overrides,
  } as PaperTraderConfig;
}

describe('live re-entry hybrid gate', () => {
  beforeEach(() => {
    lastExitMarketSnapshotByMintMap.clear();
    lastRealExitMarketSnapshotByMintMap.clear();
    lastPostExitBuyCooldownTsByMintMap.clear();
  });

  it('enabled when drop and max wait both set', () => {
    expect(isLiveReentryHybridGateEnabled(hybridCfg())).toBe(true);
    expect(
      isLiveReentryHybridGateEnabled({ liveReentryMinDropFromLastExitPct: 0 } as PaperTraderConfig),
    ).toBe(false);
  });

  it('blocks profit re-entry at same or higher price during cooldown', () => {
    const exitTs = Date.now() - 5 * 60_000;
    recordAfterFullCloseForMintRepeatGateFromClosedTrade(hybridCfg(), {
      mint: MINT,
      exitTs,
      theoretical_exit_price: 1.0,
      effective_exit_price: 1.0,
      netPnlUsd: 50,
      exitReason: 'TRAIL',
    });
    const reasonsSame: string[] = [];
    appendLiveReentryHybridGateReasons(hybridCfg(), MINT, 1.0, reasonsSame, Date.now());
    expect(reasonsSame.some((r) => r.startsWith('reentry_wait_below_last_exit_profit'))).toBe(true);
    const reasonsHigher: string[] = [];
    appendLiveReentryHybridGateReasons(hybridCfg(), MINT, 1.05, reasonsHigher, Date.now());
    expect(reasonsHigher.some((r) => r.startsWith('reentry_wait_below_last_exit_profit'))).toBe(true);
  });

  it('allows profit re-entry below last exit during cooldown', () => {
    const exitTs = Date.now() - 5 * 60_000;
    recordAfterFullCloseForMintRepeatGateFromClosedTrade(hybridCfg(), {
      mint: MINT,
      exitTs,
      theoretical_exit_price: 1.0,
      effective_exit_price: 1.0,
      netPnlUsd: 50,
      exitReason: 'TRAIL',
    });
    const reasons: string[] = [];
    appendLiveReentryHybridGateReasons(hybridCfg(), MINT, 0.99, reasons, Date.now());
    expect(reasons.filter((r) => r.startsWith('reentry_wait'))).toHaveLength(0);
  });

  it('blocks when price above -20% from last exit during loss cooldown', () => {
    const exitTs = Date.now() - 5 * 60_000;
    recordAfterFullCloseForMintRepeatGateFromClosedTrade(hybridCfg(), {
      mint: MINT,
      exitTs,
      theoretical_exit_price: 1.0,
      effective_exit_price: 1.0,
      netPnlUsd: -10,
      exitReason: 'SL',
    });
    const reasons: string[] = [];
    appendLiveReentryHybridGateReasons(hybridCfg(), MINT, 0.85, reasons, Date.now());
    expect(reasons.some((r) => r.startsWith('reentry_wait_dip'))).toBe(true);
  });

  it('allows dip re-entry when price hit -20% during loss cooldown', () => {
    const exitTs = Date.now() - 5 * 60_000;
    recordAfterFullCloseForMintRepeatGateFromClosedTrade(hybridCfg(), {
      mint: MINT,
      exitTs,
      theoretical_exit_price: 1.0,
      effective_exit_price: 1.0,
      netPnlUsd: -10,
      exitReason: 'SL',
    });
    const reasons: string[] = [];
    appendLiveReentryHybridGateReasons(hybridCfg(), MINT, 0.69, reasons, Date.now());
    expect(reasons).toHaveLength(0);
  });

  it('allows same-price re-entry after cooldown (no multi-day dip anchor)', () => {
    const exitTs = Date.now() - 21 * 60_000;
    const cfg = hybridCfg({
      dipLossExitCooldownEnabled: true,
      dipLossExitCooldownMinutes: 10,
    });
    recordAfterFullCloseForMintRepeatGateFromClosedTrade(cfg, {
      mint: MINT,
      exitTs,
      theoretical_exit_price: 1.0,
      effective_exit_price: 1.0,
      netPnlUsd: 50,
      exitReason: 'TRAIL',
    });
    const reasons: string[] = [];
    appendLiveReentryHybridGateReasons(cfg, MINT, 1.0, reasons, Date.now());
    expect(reasons.filter((r) => r.startsWith('reentry_wait'))).toHaveLength(0);
  });

  it('MENSA scenario: profit exit blocks same-price re-entry during cooldown', () => {
    const exitTs = Date.now() - 83_000;
    const cfg = hybridCfg({
      liveReentryMinDropFromLastExitPct: 10,
      liveReentryMaxWaitMinutes: 240,
      dipLossExitCooldownEnabled: true,
      dipLossExitCooldownMinutes: 10,
    });
    recordAfterFullCloseForMintRepeatGateFromClosedTrade(cfg, {
      mint: MINT,
      exitTs,
      theoretical_exit_price: 0.00219361,
      effective_exit_price: 0.00219361,
      netPnlUsd: 2399.54,
      exitReason: 'BREAKEVEN_EXIT',
    });
    const reasons: string[] = [];
    appendLiveReentryHybridGateReasons(cfg, MINT, 0.00219361, reasons, Date.now());
    expect(reasons.some((r) => r.startsWith('reentry_wait_below_last_exit_profit'))).toBe(true);
  });

  it('MENSA scenario: exit 2d ago, eval now — no reentry_wait after cooldown', () => {
    const exitTs = Date.now() - 48 * 3_600_000;
    const cfg = hybridCfg({
      liveReentryMinDropFromLastExitPct: 10,
      liveReentryMaxWaitMinutes: 240,
      dipLossExitCooldownEnabled: true,
      dipLossExitCooldownMinutes: 10,
    });
    recordAfterFullCloseForMintRepeatGateFromClosedTrade(cfg, {
      mint: MINT,
      exitTs,
      theoretical_exit_price: 0.01300716,
      effective_exit_price: 0.01300716,
      netPnlUsd: 12.5,
      exitReason: 'TRAIL',
    });
    const reasons: string[] = [];
    appendLiveReentryHybridGateReasons(cfg, MINT, 0.0135, reasons, Date.now());
    expect(reasons.filter((r) => r.startsWith('reentry_wait_dip'))).toHaveLength(0);
  });

  it('after loss cooldown expires: no exit-price ceiling (normal discovery gates)', () => {
    const exitTs = Date.now() - 11 * 60_000;
    const cfg = hybridCfg({
      dipLossExitCooldownEnabled: true,
      dipLossExitCooldownMinutes: 10,
    });
    recordAfterFullCloseForMintRepeatGateFromClosedTrade(cfg, {
      mint: MINT,
      exitTs,
      theoretical_exit_price: 0.01300716,
      effective_exit_price: 0.01300716,
      netPnlUsd: -43,
      exitReason: 'KILLSTOP',
    });
    const reasons: string[] = [];
    appendLiveReentryHybridGateReasons(cfg, MINT, 0.0135, reasons, Date.now());
    expect(reasons.filter((r) => r.startsWith('reentry_wait_dip'))).toHaveLength(0);
  });

  it('after loss: still requires dip during cooldown window', () => {
    const exitTs = Date.now() - 5 * 60_000;
    recordAfterFullCloseForMintRepeatGateFromClosedTrade(hybridCfg(), {
      mint: MINT,
      exitTs,
      theoretical_exit_price: 1.0,
      effective_exit_price: 1.0,
      netPnlUsd: -22,
      exitReason: 'FLASH_CRASH_KILL',
    });
    const reasons: string[] = [];
    appendLiveReentryHybridGateReasons(hybridCfg(), MINT, 0.85, reasons, Date.now());
    expect(reasons.some((r) => r.includes('_loss'))).toBe(true);
  });

  it('after cooldown: no exit-price ceiling for profit or loss exits', () => {
    const exitTs = Date.now() - 11 * 60_000;
    recordAfterFullCloseForMintRepeatGateFromClosedTrade(hybridCfg(), {
      mint: MINT,
      exitTs,
      theoretical_exit_price: 1.0,
      effective_exit_price: 1.0,
      netPnlUsd: 50,
      exitReason: 'TP',
    });
    const reasons: string[] = [];
    appendLiveReentryHybridGateReasons(hybridCfg(), MINT, 1.05, reasons, Date.now());
    expect(reasons).toHaveLength(0);
  });

  it('after loss: requires 30% dip not 20% during cooldown', () => {
    const exitTs = Date.now() - 5 * 60_000;
    recordAfterFullCloseForMintRepeatGateFromClosedTrade(hybridCfg(), {
      mint: MINT,
      exitTs,
      theoretical_exit_price: 1.0,
      effective_exit_price: 1.0,
      netPnlUsd: -10,
      exitReason: 'SL',
    });
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
    recordAfterFullCloseForMintRepeatGateFromClosedTrade(
      { ...hybridCfg(), liveReentryMinDropFromLastExitPct: 12, liveReentryLossMinDropFromLastExitPct: 30 },
      ct,
      { openTrade },
    );
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
