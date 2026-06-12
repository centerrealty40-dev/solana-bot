import { describe, expect, it, beforeEach } from 'vitest';

import type { PaperTraderConfig } from '../src/papertrader/config.js';
import {
  appendPostExitReentryGateReasons,
  lastExitMarketSnapshotByMintMap,
  lastPostExitBuyCooldownTsByMintMap,
  lastRealExitMarketSnapshotByMintMap,
  recordAfterFullCloseForMintRepeatGateFromClosedTrade,
} from '../src/papertrader/discovery/dip-clones.js';
import { executionPostExitReentryGateReasons } from '../src/live/phase4-execution.js';

const MINT = 'Tqj8yFmagrg7oorpQkVGYR52r96RFTamvWfth9bpump';

function prodCfg(): PaperTraderConfig {
  return {
    liveReentryMinDropFromLastExitPct: 10,
    liveReentryMaxWaitMinutes: 240,
    liveReentryLossMinDropFromLastExitPct: 10,
    liveReentryGateMaxAgeHours: 4,
    dipLossExitCooldownEnabled: true,
    dipLossExitCooldownMinutes: 10,
    dipLossExitCooldownHours: 0,
  } as PaperTraderConfig;
}

describe('KINS audit — KILLSTOP then RECONCILE re-entry gate', () => {
  beforeEach(() => {
    lastExitMarketSnapshotByMintMap.clear();
    lastRealExitMarketSnapshotByMintMap.clear();
    lastPostExitBuyCooldownTsByMintMap.clear();
  });

  it('blocks re-buy at same price after KILLSTOP + RECONCILE_ORPHAN (prod journal replay)', () => {
    const cfg = prodCfg();
    const killTs = Date.now() - 30_000;
    recordAfterFullCloseForMintRepeatGateFromClosedTrade(cfg, {
      mint: MINT,
      exitTs: killTs,
      theoretical_exit_price: 0.005600131324177193,
      effective_exit_price: 0.005565423910795698,
      netPnlUsd: -34.21374288169886,
      exitReason: 'KILLSTOP',
    });

    const reconcileTs = killTs + 21_000;
    recordAfterFullCloseForMintRepeatGateFromClosedTrade(
      cfg,
      {
        mint: MINT,
        exitTs: reconcileTs,
        theoretical_exit_price: 0.006125923075095707,
        effective_exit_price: 0.006178724790230171,
        netPnlUsd: 5.2738410963321485,
        exitReason: 'RECONCILE_ORPHAN',
      },
      {
        openTrade: {
          partialSells: [
            { marketPrice: 0.006419, reason: 'TP_LADDER' },
            { marketPrice: 0.006517, reason: 'TP_LADDER' },
          ],
        },
      },
    );

    const snap = lastExitMarketSnapshotByMintMap.get(MINT);
    expect(snap?.marketUsd).toBeCloseTo(0.00560013, 5);
    expect(snap?.exitReason).toBe('KILLSTOP');

    const discoveryReasons: string[] = [];
    appendPostExitReentryGateReasons(cfg, MINT, 0.00564152, discoveryReasons);
    expect(discoveryReasons.some((r) => r.startsWith('post_exit_buy_cooldown_'))).toBe(true);
    expect(discoveryReasons.some((r) => r.startsWith('reentry_wait_dip'))).toBe(true);

    const execReasons = executionPostExitReentryGateReasons(cfg, MINT, 0.00564152);
    expect(execReasons.length).toBeGreaterThan(0);
  });
});
