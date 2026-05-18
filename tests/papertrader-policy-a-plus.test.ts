import { describe, it, expect } from 'vitest';
import { evaluatePolicyAPlus } from '../src/papertrader/discovery/policy-a-plus.js';
import type { PaperTraderConfig } from '../src/papertrader/config.js';
import type { SnapshotCandidateRow } from '../src/papertrader/types.js';

/**
 * 1.11.167: Policy A+ entry filter — каждое из 4 правил тестируется по отдельности +
 * комбинированный сценарий + safe-skip при отсутствии PG-coverage.
 */

function cfg(overrides: Partial<PaperTraderConfig> = {}): PaperTraderConfig {
  return {
    policyAPlusEnabled: true,
    policyAPlusBounceFromMin30mEnabled: true,
    policyAPlusBounceFromMin30mMaxPct: 2.5,
    policyAPlusPriceChange1hEnabled: true,
    policyAPlusPriceChange1hMinPct: -20,
    policyAPlusVol1hEnabled: true,
    policyAPlusVol1hMaxUsd: 1_000_000,
    policyAPlusPriceChange30mEnabled: true,
    policyAPlusPriceChange30mMinPct: -10,
    ...overrides,
  } as unknown as PaperTraderConfig;
}

function row(overrides: Partial<SnapshotCandidateRow> = {}): SnapshotCandidateRow {
  return {
    mint: 'M',
    symbol: 'X',
    source: 'raydium',
    price_usd: 1.0,
    volume_1h: 500_000,
    ...overrides,
  } as unknown as SnapshotCandidateRow;
}

describe('Policy A+ rule 1: bounce_from_min_30m_pct > 2.5%', () => {
  it('blocks when bounce > threshold', () => {
    const ctx = {
      min30m: 0.95,
      price30mAgo: 1.0,
      price1hAgo: 1.0,
      bounceFromMin30mPct: null,
      priceChange30mPct: null,
      priceChange1hPct: null,
      vol1hUsd: null,
      pgSnapsCount: 10,
      coverageOk: true,
    };
    /** current 1.0, min 0.95 → bounce = 5.26%, > 2.5% → block */
    const res = evaluatePolicyAPlus(cfg(), row(), ctx);
    expect(res.blocked).toBe(true);
    expect(res.blockedReasons[0]).toContain('bounce_from_min_30m');
  });

  it('passes when bounce ≤ threshold', () => {
    const ctx = {
      min30m: 0.999,
      price30mAgo: 1.0,
      price1hAgo: 1.0,
      bounceFromMin30mPct: null,
      priceChange30mPct: null,
      priceChange1hPct: null,
      vol1hUsd: null,
      pgSnapsCount: 10,
      coverageOk: true,
    };
    /** bounce = 0.1% < 2.5% → pass */
    const res = evaluatePolicyAPlus(cfg(), row(), ctx);
    expect(res.blocked).toBe(false);
  });

  it('passes when bounce is between 1% and 2.5%', () => {
    const ctx = {
      min30m: 0.98,
      price30mAgo: 1.0,
      price1hAgo: 1.0,
      bounceFromMin30mPct: null,
      priceChange30mPct: -5,
      priceChange1hPct: -5,
      vol1hUsd: null,
      pgSnapsCount: 10,
      coverageOk: true,
    };
    /** bounce ≈ 2.04% — old 1% threshold blocked; 2.5% passes rule 1 */
    const res = evaluatePolicyAPlus(cfg(), row({ price_usd: 1.0 }), ctx);
    expect(res.blockedReasons.some((r) => r.includes('bounce_from_min_30m'))).toBe(false);
  });
});

describe('Policy A+ rule 2: price_change_1h_pct < −20%', () => {
  it('blocks when freefall > 20%', () => {
    const ctx = {
      min30m: 1.0,
      price30mAgo: 1.0,
      price1hAgo: 1.5,
      bounceFromMin30mPct: null,
      priceChange30mPct: null,
      priceChange1hPct: null,
      vol1hUsd: null,
      pgSnapsCount: 10,
      coverageOk: true,
    };
    /** 1.0 vs 1.5 → −33% < −20% → block */
    const res = evaluatePolicyAPlus(cfg(), row(), ctx);
    expect(res.blocked).toBe(true);
    expect(res.blockedReasons.some((r) => r.includes('price_change_1h'))).toBe(true);
  });

  it('passes when freefall ≤ 20%', () => {
    const ctx = {
      min30m: 1.0,
      price30mAgo: 1.0,
      price1hAgo: 1.1,
      bounceFromMin30mPct: null,
      priceChange30mPct: null,
      priceChange1hPct: null,
      vol1hUsd: null,
      pgSnapsCount: 10,
      coverageOk: true,
    };
    const res = evaluatePolicyAPlus(cfg(), row(), ctx);
    expect(res.blocked).toBe(false);
  });
});

describe('Policy A+ rule 3: vol_1h_usd > $1M', () => {
  it('blocks when vol > threshold', () => {
    const ctx = {
      min30m: 1.0,
      price30mAgo: 1.0,
      price1hAgo: 1.0,
      bounceFromMin30mPct: null,
      priceChange30mPct: null,
      priceChange1hPct: null,
      vol1hUsd: null,
      pgSnapsCount: 10,
      coverageOk: true,
    };
    const res = evaluatePolicyAPlus(cfg(), row({ volume_1h: 2_000_000 }), ctx);
    expect(res.blocked).toBe(true);
    expect(res.blockedReasons.some((r) => r.includes('vol_1h'))).toBe(true);
  });
});

describe('Policy A+ rule 4: price_change_30m_pct < −10%', () => {
  it('blocks when fresh 30m freefall > 10%', () => {
    const ctx = {
      min30m: 1.0,
      price30mAgo: 1.2,
      price1hAgo: 1.0,
      bounceFromMin30mPct: null,
      priceChange30mPct: null,
      priceChange1hPct: null,
      vol1hUsd: null,
      pgSnapsCount: 10,
      coverageOk: true,
    };
    /** 1.0 vs 1.2 → −16.6% < −10% → block */
    const res = evaluatePolicyAPlus(cfg(), row(), ctx);
    expect(res.blocked).toBe(true);
    expect(res.blockedReasons.some((r) => r.includes('price_change_30m'))).toBe(true);
  });
});

describe('Policy A+ safety: missing coverage → safe-skip', () => {
  it('does not block when PG coverage is insufficient', () => {
    const ctx = {
      min30m: null,
      price30mAgo: null,
      price1hAgo: null,
      bounceFromMin30mPct: null,
      priceChange30mPct: null,
      priceChange1hPct: null,
      vol1hUsd: null,
      pgSnapsCount: 0,
      coverageOk: false,
    };
    const res = evaluatePolicyAPlus(cfg(), row({ volume_1h: 5_000_000 }), ctx);
    /** Even with vol > $1M, missing coverage forces pass */
    expect(res.blocked).toBe(false);
  });

  it('returns features.coverageOk=false when ctx is undefined', () => {
    const res = evaluatePolicyAPlus(cfg(), row(), undefined);
    expect(res.blocked).toBe(false);
    expect(res.features.coverageOk).toBe(false);
  });
});

describe('Policy A+ disabled', () => {
  it('returns blocked=false regardless of features', () => {
    const ctx = {
      min30m: 0.5,
      price30mAgo: 2.0,
      price1hAgo: 5.0,
      bounceFromMin30mPct: null,
      priceChange30mPct: null,
      priceChange1hPct: null,
      vol1hUsd: null,
      pgSnapsCount: 100,
      coverageOk: true,
    };
    const res = evaluatePolicyAPlus(
      cfg({ policyAPlusEnabled: false }),
      row({ volume_1h: 10_000_000 }),
      ctx,
    );
    expect(res.blocked).toBe(false);
  });
});

describe('Policy A+ individual rule disable flags', () => {
  it('respects policyAPlusBounceFromMin30mEnabled=false', () => {
    const ctx = {
      min30m: 0.95,
      price30mAgo: 1.0,
      price1hAgo: 1.0,
      bounceFromMin30mPct: null,
      priceChange30mPct: null,
      priceChange1hPct: null,
      vol1hUsd: null,
      pgSnapsCount: 10,
      coverageOk: true,
    };
    const res = evaluatePolicyAPlus(
      cfg({ policyAPlusBounceFromMin30mEnabled: false }),
      row(),
      ctx,
    );
    expect(res.blocked).toBe(false);
  });
});
