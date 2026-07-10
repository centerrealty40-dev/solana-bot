import { describe, expect, it } from 'vitest';
import { detectRollingFlush } from '../src/scripts/knife-flush-detector.js';
import {
  evaluateKnifeHolderWash,
  loadKnifeAnalyticsConfig,
} from '../src/scripts/knife-analytics-gate.js';
import type { SnapshotCandidateRow } from '../src/papertrader/types.js';

function buf(points: Array<[number, number]>): Array<{ t: number; p: number }> {
  return points.map(([t, p]) => ({ t, p }));
}

const flushCfg = {
  flushWindowMs: 600_000, // 10m
  flushMinDumpPct: 8,
  maxDrawdownPct: 40,
};

describe('detectRollingFlush', () => {
  it('fires on a slow −12% flush that whale-sell trigger would miss', () => {
    const now = 10_000_000;
    // high 0.024 at t-10m, bleeding down to 0.0211 now → -12%
    const b = buf([
      [now - 600_000, 0.024],
      [now - 420_000, 0.0235],
      [now - 300_000, 0.0225],
      [now - 120_000, 0.0218],
    ]);
    const flush = detectRollingFlush(b, 0.0211, now, flushCfg);
    expect(flush).not.toBeNull();
    expect(flush!.source).toBe('rolling_flush');
    expect(flush!.dumpPct).toBeGreaterThanOrEqual(8);
  });

  it('ignores shallow −5% wiggles below the flush floor', () => {
    const now = 10_000_000;
    const b = buf([
      [now - 400_000, 0.02],
      [now - 200_000, 0.0198],
    ]);
    expect(detectRollingFlush(b, 0.019, now, flushCfg)).toBeNull();
  });

  it('rejects bottomless knives beyond maxDrawdown', () => {
    const now = 10_000_000;
    const b = buf([[now - 300_000, 0.02]]);
    expect(detectRollingFlush(b, 0.01, now, flushCfg)).toBeNull();
  });
});

function row(partial: Partial<SnapshotCandidateRow>): SnapshotCandidateRow {
  return {
    mint: '8N1xPzwZtuRQSdRMnbjAjdd2tK9V8nF7Wrw8gGeLpump',
    symbol: 'junk',
    ts: new Date(),
    launch_ts: null,
    age_min: 2000,
    price_usd: 0.00025,
    liquidity_usd: 50_000,
    volume_5m: 5_000,
    volume_1h: 250_000,
    buys_5m: 10,
    sells_5m: 10,
    market_cap_usd: 800_000,
    holder_count: 0,
    token_age_min: 2000,
    pair_address: 'pair',
    source: 'pumpswap',
    ...partial,
  };
}

describe('knife holder gate — unknown data', () => {
  it('does NOT reject when holder data is missing (0) by default', () => {
    const cfg = loadKnifeAnalyticsConfig({ KNIFE_MIN_HOLDER_COUNT: '3000' });
    const reasons = evaluateKnifeHolderWash(cfg, row({ holder_count: 0 }));
    expect(reasons.some((r) => r.startsWith('knife_holders<'))).toBe(false);
  });

  it('still rejects KNOWN low-holder junk (holders>0 below floor)', () => {
    const cfg = loadKnifeAnalyticsConfig({ KNIFE_MIN_HOLDER_COUNT: '3000' });
    const reasons = evaluateKnifeHolderWash(cfg, row({ holder_count: 1000 }));
    expect(reasons.some((r) => r.startsWith('knife_holders<'))).toBe(true);
  });

  it('can hard-reject unknown when skip flag disabled', () => {
    const cfg = loadKnifeAnalyticsConfig({
      KNIFE_MIN_HOLDER_COUNT: '3000',
      KNIFE_HOLDER_GATE_SKIP_WHEN_UNKNOWN: '0',
    });
    const reasons = evaluateKnifeHolderWash(cfg, row({ holder_count: 0 }));
    expect(reasons.some((r) => r.startsWith('knife_holders<'))).toBe(true);
  });
});
