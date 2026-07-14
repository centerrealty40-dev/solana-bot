import { describe, expect, it } from 'vitest';
import { evaluateRangeBaseDip } from '../src/papertrader/discovery/range-base-dip.js';
import type { PaperTraderConfig } from '../src/papertrader/config.js';
import type { SnapshotCandidateRow } from '../src/papertrader/types.js';
import type { RangeBaseDipFeatures } from '../src/papertrader/discovery/range-base-dip.js';

function cfg(partial: Partial<PaperTraderConfig> = {}): PaperTraderConfig {
  return {
    dipRangeBaseEnabled: true,
    dipRangeBaseLookbackHours: 48,
    dipRangeBaseMaxSpanPct: 15,
    dipRangeBaseMaxNetMovePct: 10,
    dipRangeBaseMinVol5mSpikeMult: 2,
    dipRangeBaseMinPgSamples: 8,
    dipMinDropPct: -18,
    dipMaxDropPct: -50,
    dipMinAgeMin: 60,
    ...partial,
  } as PaperTraderConfig;
}

function row(partial: Partial<SnapshotCandidateRow>): SnapshotCandidateRow {
  return {
    mint: '6NwarBvDkXhByqVp2Qkq5i9XbtA2B3Bwe8SWGu9vpump',
    symbol: 'Cupsey',
    ts: new Date(),
    launch_ts: null,
    age_min: 250000,
    price_usd: 0.0033,
    liquidity_usd: 195_000,
    volume_5m: 12_000,
    volume_1h: 72_000,
    buys_5m: 10,
    sells_5m: 8,
    market_cap_usd: 3_300_000,
    holder_count: 0,
    token_age_min: 250000,
    pair_address: 'pair',
    source: 'pumpswap',
    ...partial,
  };
}

function ctx(partial: Partial<RangeBaseDipFeatures>): RangeBaseDipFeatures {
  return {
    lookbackHours: 48,
    rangeLo: 0.0040,
    rangeHi: 0.0045,
    rangeAvg: 0.00425,
    rangeSpanPct: 11.8,
    netMove48hPct: -2,
    dropFromRangeLowPct: null,
    vol5mSpikeRatio: null,
    pgSnapsCount: 40,
    coverageOk: true,
    ...partial,
  };
}

describe('evaluateRangeBaseDip', () => {
  it('passes 6Nwar-class sideways flush from range low with vol5m spike', () => {
    const res = evaluateRangeBaseDip(
      cfg(),
      row({ price_usd: 0.00324, volume_5m: 12_000, volume_1h: 72_000 }),
      ctx({}),
    );
    expect(res.pass).toBe(true);
    expect(res.dipPct).not.toBeNull();
    expect((res.dipPct ?? 0) <= -18).toBe(true);
    expect(res.dipLookbackUsedMin).toBe(48 * 60);
  });

  it('rejects wide 48h range (not sideways)', () => {
    const res = evaluateRangeBaseDip(
      cfg(),
      row({}),
      ctx({ rangeSpanPct: 22, rangeLo: 0.0025, rangeHi: 0.0040, rangeAvg: 0.0032 }),
    );
    expect(res.pass).toBe(false);
    expect(res.reasons.some((r) => r.startsWith('range_base_span'))).toBe(true);
  });

  it('rejects without vol5m spike', () => {
    const res = evaluateRangeBaseDip(cfg(), row({ volume_5m: 1000, volume_1h: 100_000 }), ctx({}));
    expect(res.pass).toBe(false);
    expect(res.reasons.some((r) => r.startsWith('range_base_vol5m_spike'))).toBe(true);
  });

  it('rejects shallow dip from range low', () => {
    const res = evaluateRangeBaseDip(cfg(), row({ price_usd: 0.00342 }), ctx({ rangeLo: 0.0035 }));
    expect(res.pass).toBe(false);
    expect(res.reasons.some((r) => r.startsWith('range_base_drop'))).toBe(true);
  });
});
