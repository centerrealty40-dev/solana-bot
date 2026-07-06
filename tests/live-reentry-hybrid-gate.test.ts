import { describe, expect, it, beforeEach } from 'vitest';

import type { PaperTraderConfig } from '../src/papertrader/config.js';
import {
  appendLiveReentryHybridGateReasons,
  evaluatePostExitReentryFork,
  isLiveReentryHybridGateEnabled,
  lastExitMarketSnapshotByMintMap,
  lastPostExitBuyCooldownTsByMintMap,
  lastRealExitMarketSnapshotByMintMap,
  postExitReentryForkObservabilityReason,
  recordAfterFullCloseForMintRepeatGateFromClosedTrade,
  recordLastExitMarketSnapshotAfterClose,
  reentryExitSnapshotForGate,
  resolveReconcileOrphanReentryGateMeta,
  shouldPreserveRealExitReentryGate,
} from '../src/papertrader/discovery/dip-clones.js';

const MINT = 'TestMint1111111111111111111111111111111111';

function hybridCfg(overrides: Partial<PaperTraderConfig> = {}): PaperTraderConfig {
  return {
    liveReentryMinDropFromLastExitPct: 10,
    liveReentryBreakoutAboveExitPct: 20,
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

  it('blocks profit re-entry at same or higher price (fork wait zone)', () => {
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
    expect(reasonsSame.some((r) => r.startsWith('reentry_wait_dip_below_exit'))).toBe(true);
    const reasonsHigher: string[] = [];
    appendLiveReentryHybridGateReasons(hybridCfg(), MINT, 1.05, reasonsHigher, Date.now());
    expect(reasonsHigher.some((r) => r.startsWith('reentry_wait_dip_below_exit'))).toBe(true);
  });

  it('blocks profit re-entry between exit and -10% dip (manlet-class churn)', () => {
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
    expect(reasons.some((r) => r.startsWith('reentry_wait_dip_below_exit'))).toBe(true);
  });

  it('allows profit re-entry at or below -10% dip', () => {
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
    appendLiveReentryHybridGateReasons(hybridCfg(), MINT, 0.89, reasons, Date.now());
    expect(reasons.filter((r) => r.startsWith('reentry_wait'))).toHaveLength(0);
  });

  it('+20% breakout bypasses dip wait (standard discovery gates)', () => {
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
    const obs: string[] = [];
    appendLiveReentryHybridGateReasons(hybridCfg(), MINT, 1.21, reasons, Date.now(), obs);
    expect(reasons).toHaveLength(0);
    expect(obs.some((r) => r.startsWith('reentry_breakout_standard_dip'))).toBe(true);
  });

  it('blocks when price above -10% from last exit during loss cooldown', () => {
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
    expect(reasons.some((r) => r.startsWith('reentry_wait_dip_below_exit'))).toBe(true);
  });

  it('allows dip re-entry when price hit -30% during loss cooldown', () => {
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

  it('blocks same-price re-entry after cooldown within gate max-age (manlet fix)', () => {
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
    expect(reasons.some((r) => r.startsWith('reentry_wait_dip_below_exit'))).toBe(true);
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
    expect(reasons.some((r) => r.startsWith('reentry_wait_dip_below_exit'))).toBe(true);
  });

  it('MENSA scenario: manlet same-price after cooldown still blocked within max-age', () => {
    const exitTs = Date.now() - 11 * 60_000;
    const cfg = hybridCfg({
      liveReentryMinDropFromLastExitPct: 10,
      liveReentryMaxWaitMinutes: 240,
      dipLossExitCooldownEnabled: true,
      dipLossExitCooldownMinutes: 10,
    });
    recordAfterFullCloseForMintRepeatGateFromClosedTrade(cfg, {
      mint: MINT,
      exitTs,
      theoretical_exit_price: 0.01005996,
      effective_exit_price: 0.01005996,
      netPnlUsd: 4267,
      exitReason: 'BREAKEVEN_EXIT',
    });
    const reasons: string[] = [];
    appendLiveReentryHybridGateReasons(cfg, MINT, 0.01002, reasons, Date.now());
    expect(reasons.some((r) => r.startsWith('reentry_wait_dip_below_exit'))).toBe(true);
  });

  it('MENSA scenario: exit 2d ago, eval now — no reentry_wait after gate max-age', () => {
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
    expect(reasons.filter((r) => r.startsWith('reentry_wait'))).toHaveLength(0);
  });

  it('after loss cooldown expires: still requires -10% dip within max-age', () => {
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
    expect(reasons.some((r) => r.startsWith('reentry_wait_dip_below_exit'))).toBe(true);
  });

  it('after loss: still requires 30% dip not 10% during cooldown', () => {
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
    expect(reasons.some((r) => r.includes('dip=30pct'))).toBe(true);
    const ok: string[] = [];
    appendLiveReentryHybridGateReasons(hybridCfg(), MINT, 0.69, ok, Date.now());
    expect(ok).toHaveLength(0);
  });

  it('evaluatePostExitReentryFork returns breakout observability', () => {
    const snap = {
      exitTs: Date.now() - 60_000,
      marketUsd: 1.0,
      netPnlUsd: 10,
      exitReason: 'TRAIL',
    };
    const fork = evaluatePostExitReentryFork(hybridCfg(), snap, 1.25);
    expect(fork.kind).toBe('breakout');
    expect(postExitReentryForkObservabilityReason(fork)?.startsWith('reentry_breakout_standard_dip')).toBe(
      true,
    );
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
    expect(reasons.some((r) => r.startsWith('reentry_wait_dip_below_exit'))).toBe(true);
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
