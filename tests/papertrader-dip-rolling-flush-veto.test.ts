import { describe, expect, it } from 'vitest';
import type { PaperTraderConfig } from '../src/papertrader/config.js';
import { evaluateRollingFlushVeto } from '../src/papertrader/dip-detector.js';
import type { DipContextByWindows } from '../src/papertrader/dip-detector.js';
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
    age_min: 3000,
    price_usd: priceUsd,
    liquidity_usd: 100_000,
    volume_5m: 1000,
    volume_1h: 40_000,
    buys_5m: 10,
    sells_5m: 10,
    holder_count: 5000,
    token_age_min: 3000,
    market_cap_usd: 1e6,
    pair_address: 'POOL',
  };
}

describe('evaluateRollingFlushVeto', () => {
  const base = cfg({
    dipRollingFlushVetoEnabled: true,
    dipRollingFlushVetoWindowsMin: [15, 30, 60],
    dipRollingFlushVetoMinDumpPct: 10,
    dipRollingFlushVetoMaxDumpPct: 45,
    dipRollingFlushVetoNearLowPct: 4,
  });

  // Real DEXBULL context around the 16:22 entry (PG minute snapshots).
  const dexbull: DipContextByWindows = new Map([
    [15, { high_px: 0.001695, low_px: 0.001642 }],
    [30, { high_px: 0.001962, low_px: 0.001642 }],
    [60, { high_px: 0.00208, low_px: 0.001642 }],
  ]);

  it('disabled → no reasons', () => {
    const c = cfg({ ...base, dipRollingFlushVetoEnabled: false });
    expect(evaluateRollingFlushVeto(c, row(0.001642), dexbull).reasons).toEqual([]);
  });

  it('vetoes DEXBULL: fresh 30m/60m low, big dump, zero bounce (falling knife)', () => {
    const r = evaluateRollingFlushVeto(base, row(0.001642), dexbull);
    expect(r.reasons.length).toBeGreaterThan(0);
    expect(r.reasons.some((x) => x.startsWith('rolling_flush_veto_30m'))).toBe(true);
    // 10-15m dump was only ~3% → that short window must NOT be the trigger.
    expect(r.reasons.some((x) => x.startsWith('rolling_flush_veto_15m'))).toBe(false);
  });

  it('allows a bounced dip (dropped hard but now well above the window low)', () => {
    // price bounced ~11% off the low → a dip, not a knife.
    const r = evaluateRollingFlushVeto(base, row(0.00182), dexbull);
    expect(r.reasons).toEqual([]);
  });

  it('allows an already-collapsed mint (dump beyond maxDump → other guards)', () => {
    const r = evaluateRollingFlushVeto(base, row(0.0009), dexbull);
    expect(r.reasons).toEqual([]);
  });

  it('allows a shallow short-window dip (dump below minDump)', () => {
    const ctx: DipContextByWindows = new Map([[15, { high_px: 0.101, low_px: 0.099 }]]);
    expect(evaluateRollingFlushVeto(base, row(0.1), ctx).reasons).toEqual([]);
  });

  it('missing ctx → no reasons', () => {
    expect(evaluateRollingFlushVeto(base, row(0.09), undefined).reasons).toEqual([]);
    expect(evaluateRollingFlushVeto(base, row(0.09), new Map()).reasons).toEqual([]);
  });
});
