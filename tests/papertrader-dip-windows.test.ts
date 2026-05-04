import { describe, expect, it } from 'vitest';
import type { PaperTraderConfig } from '../src/papertrader/config.js';
import { evaluateDip, evaluateDipOneWindow } from '../src/papertrader/dip-detector.js';
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
    source: 'raydium',
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
    pair_address: null,
  };
}

describe('evaluateDip multi-window OR', () => {
  const base = cfg({
    dipLookbackWindowsMin: [120, 360],
    dipMinDropPct: -15,
    dipMaxDropPct: -50,
    dipMinImpulsePct: 12,
    dipMinAgeMin: 0,
  });

  it('passes when short window fails but longer window passes', () => {
    const ctx: DipContextByWindows = new Map([
      [120, { high_px: 0.1, low_px: 0.09 }], // ~11% impulse — fails impulse
      [360, { high_px: 0.1, low_px: 0.07 }], // dip −30%, impulse ~43%
    ]);
    const r = evaluateDip(base, row(0.07), ctx);
    expect(r.reasons).toEqual([]);
    expect(r.dipLookbackUsedMin).toBe(360);
    expect(r.dipPct).toBeCloseTo(-30, 5);
  });

  it('prefers shorter passing window first', () => {
    const ctx: DipContextByWindows = new Map([
      [120, { high_px: 0.1, low_px: 0.07 }],
      [360, { high_px: 0.12, low_px: 0.07 }],
    ]);
    const r = evaluateDip(base, row(0.07), ctx);
    expect(r.dipLookbackUsedMin).toBe(120);
  });

  it('fails when no window passes', () => {
    const ctx: DipContextByWindows = new Map([
      [120, { high_px: 0.1, low_px: 0.095 }],
      [360, { high_px: 0.1, low_px: 0.095 }],
    ]);
    const r = evaluateDip(base, row(0.095), ctx);
    expect(r.reasons.length).toBe(1);
    expect(r.reasons[0]).toContain('dip_no_window_pass');
    expect(r.dipPct).toBeNull();
  });
});

describe('evaluateDipOneWindow', () => {
  it('matches prior single-window semantics', () => {
    const c = cfg({
      dipLookbackWindowsMin: [60],
      dipMinDropPct: -10,
      dipMaxDropPct: -40,
      dipMinImpulsePct: 15,
      dipMinAgeMin: 0,
    });
    const ctx = { high_px: 0.1, low_px: 0.08 };
    const r = evaluateDipOneWindow(c, row(0.095), ctx); // −5% vs high — shallower than −10% floor
    expect(r.reasons).toContain(`dip_not_deep_enough>${c.dipMinDropPct}%`);
  });
});
