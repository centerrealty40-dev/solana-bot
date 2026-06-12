import { describe, expect, it } from 'vitest';
import type { PaperTraderConfig } from '../src/papertrader/config.js';
import type { DipContextByWindows } from '../src/papertrader/dip-detector.js';
import {
  evaluateStressKillReentryBounce,
  evaluateStressKillReentryPath,
  getStressKillReentryContext,
  type StressExitSnapshot,
} from '../src/papertrader/discovery/stress-kill-reentry.js';
import type { SnapshotCandidateRow } from '../src/papertrader/types.js';

function cfg(partial: Partial<PaperTraderConfig>): PaperTraderConfig {
  return partial as PaperTraderConfig;
}

function row(priceUsd: number): SnapshotCandidateRow {
  return {
    mint: 'm1',
    symbol: 'T',
    ts: new Date(),
    launch_ts: null,
    source: 'pumpswap',
    age_min: 100,
    price_usd: priceUsd,
    liquidity_usd: 10_000,
    volume_5m: 1000,
    volume_1h: 120_000,
    buys_5m: 10,
    sells_5m: 10,
    holder_count: 5000,
    token_age_min: 100,
    market_cap_usd: priceUsd * 1e9,
    pair_address: 'POOL',
  };
}

const baseCfg = cfg({
  liveStressReentryEnabled: true,
  liveStressReentryMinDropFromLastExitPct: 40,
  liveStressReentryRecoveryVetoMaxBouncePct: 8,
  liveStressReentryRecoveryVetoMaxWindowMin: 30,
  liveReentryGateMaxAgeHours: 4,
  dipRecoveryVetoWindowsMin: [30, 60],
});

const killSnap: StressExitSnapshot = {
  exitTs: Date.now() - 30 * 60_000,
  marketUsd: 0.00312932,
  netPnlUsd: -150,
  exitReason: 'KILLSTOP',
};

describe('stress kill re-entry', () => {
  it('qualifies when drop from kill exit exceeds min', () => {
    const ctx = getStressKillReentryContext(baseCfg, killSnap, 0.0015);
    expect(ctx).not.toBeNull();
    expect(ctx!.dropFromExitPct).toBeGreaterThan(40);
  });

  it('does not qualify when drop from exit is too small', () => {
    const ctx = getStressKillReentryContext(baseCfg, killSnap, 0.0029);
    expect(ctx).toBeNull();
  });

  it('allows modest bounce from 30m low (1.8 → 1.87 mcap analogy)', () => {
    const lowPx = 0.0018;
    const price = 0.00187;
    const dipCtx: DipContextByWindows = new Map([
      [30, { high_px: 0.0035, low_px: lowPx }],
      [60, { high_px: 0.0035, low_px: 0.0015 }],
    ]);
    const stressCtx = getStressKillReentryContext(baseCfg, killSnap, price)!;
    const bounce = evaluateStressKillReentryBounce(baseCfg, row(price), dipCtx, stressCtx);
    expect(bounce.pass).toBe(true);
    expect(bounce.reasons).toEqual([]);
  });

  it('blocks when 30m bounce exceeds relaxed threshold', () => {
    const dipCtx: DipContextByWindows = new Map([
      [30, { high_px: 0.0035, low_px: 0.0017 }],
      [60, { high_px: 0.0035, low_px: 0.0015 }],
    ]);
    const price = 0.00185;
    const stressCtx = getStressKillReentryContext(baseCfg, killSnap, price)!;
    const bounce = evaluateStressKillReentryBounce(baseCfg, row(price), dipCtx, stressCtx);
    expect(bounce.pass).toBe(false);
    expect(bounce.reasons.some((r) => r.startsWith('stress_reentry_bounce_30m_'))).toBe(true);
  });

  it('stress path passes without 60m bounce veto on deep crash rebound', () => {
    const dipCtx: DipContextByWindows = new Map([
      [30, { high_px: 0.0035, low_px: 0.0018 }],
      [60, { high_px: 0.0035, low_px: 0.0012 }],
    ]);
    const price = 0.00187;
    const path = evaluateStressKillReentryPath(baseCfg, killSnap, row(price), dipCtx);
    expect(path.pass).toBe(true);
    expect(path.stressCtx).not.toBeNull();
  });

  it('ignores 60m window for bounce — would fail standard 12% recovery veto', () => {
    const dipCtx: DipContextByWindows = new Map([
      [30, { high_px: 0.0035, low_px: 0.0018 }],
      [60, { high_px: 0.0035, low_px: 0.0012 }],
    ]);
    const price = 0.00187;
    const bounce60 = ((price / 0.0012 - 1) * 100).toFixed(1);
    expect(Number(bounce60)).toBeGreaterThan(12);
    const path = evaluateStressKillReentryPath(baseCfg, killSnap, row(price), dipCtx);
    expect(path.pass).toBe(true);
  });
});
