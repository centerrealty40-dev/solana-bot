import { describe, expect, it } from 'vitest';
import type { PaperTraderConfig } from '../src/papertrader/config.js';
import { evaluateLocalHighVeto, evaluateRecoveryVeto } from '../src/papertrader/dip-detector.js';
import type { DipContextByWindows } from '../src/papertrader/dip-detector.js';
import type { SnapshotCandidateRow } from '../src/papertrader/types.js';

function cfg(partial: Partial<PaperTraderConfig>): PaperTraderConfig {
  return partial as PaperTraderConfig;
}

function row(priceUsd: number, tokenAgeMin = 100): SnapshotCandidateRow {
  return {
    mint: 'm1',
    symbol: 'T',
    ts: new Date(),
    launch_ts: null,
    source: 'pumpswap',
    age_min: tokenAgeMin,
    price_usd: priceUsd,
    liquidity_usd: 10_000,
    volume_5m: 1000,
    volume_1h: 120_000,
    buys_5m: 10,
    sells_5m: 10,
    holder_count: 5000,
    token_age_min: tokenAgeMin,
    market_cap_usd: 1e7,
    pair_address: 'POOL',
  };
}

describe('evaluateRecoveryVeto', () => {
  const base = cfg({
    dipRecoveryVetoEnabled: true,
    dipRecoveryVetoWindowsMin: [30, 60],
    dipRecoveryVetoMaxBouncePct: 12,
  });

  it('disabled → no reasons', () => {
    const c = cfg({ ...base, dipRecoveryVetoEnabled: false });
    const ctx: DipContextByWindows = new Map([[60, { high_px: 0.1, low_px: 0.07 }]]);
    const r = evaluateRecoveryVeto(c, row(0.09), ctx, 360);
    expect(r.reasons).toEqual([]);
  });

  it('vetoes when short window bounce exceeds threshold', () => {
    const ctx: DipContextByWindows = new Map([
      [30, { high_px: 0.12, low_px: 0.08 }],
      [60, { high_px: 0.12, low_px: 0.07 }],
    ]);
    const r = evaluateRecoveryVeto(base, row(0.09), ctx, 360);
    expect(r.reasons.length).toBeGreaterThan(0);
    expect(r.reasons.some((x) => x.startsWith('recovery_veto_60m_'))).toBe(true);
  });

  it('skips veto window >= dip window used', () => {
    const ctx: DipContextByWindows = new Map([[120, { high_px: 0.1, low_px: 0.07 }]]);
    const r = evaluateRecoveryVeto(base, row(0.09), ctx, 120);
    expect(r.reasons).toEqual([]);
  });

  it('allows when bounce below threshold', () => {
    const ctx: DipContextByWindows = new Map([[60, { high_px: 0.1, low_px: 0.088 }]]);
    const r = evaluateRecoveryVeto(base, row(0.09), ctx, 360);
    expect(r.reasons).toEqual([]);
  });
});

describe('evaluateLocalHighVeto', () => {
  const base = cfg({
    dipLocalHighVetoEnabled: true,
    dipLocalHighVetoWindowsMin: [30, 60, 120],
    dipLocalHighVetoMaxDistancePct: 2,
  });

  it('disabled → no reasons', () => {
    const c = cfg({ ...base, dipLocalHighVetoEnabled: false });
    const ctx: DipContextByWindows = new Map([[60, { high_px: 0.101, low_px: 0.07 }]]);
    const r = evaluateLocalHighVeto(c, row(0.1), ctx);
    expect(r.reasons).toEqual([]);
  });

  it('vetoes when price is near a recent local high', () => {
    const ctx: DipContextByWindows = new Map([
      [30, { high_px: 0.102, low_px: 0.085 }],
      [60, { high_px: 0.101, low_px: 0.08 }],
    ]);
    const r = evaluateLocalHighVeto(base, row(0.1), ctx);
    expect(r.reasons.length).toBeGreaterThan(0);
    expect(r.reasons.some((x) => x.startsWith('local_high_veto_'))).toBe(true);
  });

  it('allows when price is far enough below recent highs', () => {
    const ctx: DipContextByWindows = new Map([[60, { high_px: 0.11, low_px: 0.08 }]]);
    const r = evaluateLocalHighVeto(base, row(0.1), ctx);
    expect(r.reasons).toEqual([]);
  });
});
