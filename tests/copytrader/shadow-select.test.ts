import { describe, expect, it } from 'vitest';
import { evaluateShadowSelect, shadowSelectRuleId } from '../../src/copytrader/shadow-select.js';
import type { CopyEntryContext } from '../../src/copytrader/entry-context.js';

/** Dump-first defaults: pc5 ≤ −5 and buys/sells < 1. */
const baseCfg = {
  shadowSelectEnabled: true,
  shadowSelectMaxPriceChange5mPct: -5,
  shadowSelectMaxBuySellRatio5m: 1,
  shadowSelectMinVolume5mUsd: 0,
  shadowSelectMinBuySellRatio5m: 0,
  shadowSelectMinMcapUsd: 0,
  shadowSelectMinLiquidityUsd: 0,
  shadowSelectRequireCtx: true,
};

function ctx(partial: Partial<CopyEntryContext>): CopyEntryContext {
  return {
    mint: 'Mint111',
    pairAgeHours: 2,
    buys5m: 40,
    sells5m: 80,
    buySellRatio5m: 0.5,
    priceChange5mPct: -8,
    liquidityUsd: 40_000,
    marketCapUsd: 400_000,
    volume5mUsd: 800,
    volume1hUsd: 80_000,
    fetchedAtMs: Date.now(),
    ...partial,
  };
}

describe('evaluateShadowSelect', () => {
  it('passes dump + sell-pressure rule', () => {
    const r = evaluateShadowSelect(baseCfg, ctx({}));
    expect(r.wouldBuy).toBe(true);
    expect(r.reasons).toEqual([]);
  });

  it('fails green / shallow dump (not enough proliv)', () => {
    const r = evaluateShadowSelect(baseCfg, ctx({ priceChange5mPct: -2 }));
    expect(r.wouldBuy).toBe(false);
    expect(r.reasons.some((x) => x.startsWith('dump_5m_pct='))).toBe(true);
  });

  it('fails pump candle', () => {
    const r = evaluateShadowSelect(baseCfg, ctx({ priceChange5mPct: 12 }));
    expect(r.wouldBuy).toBe(false);
  });

  it('fails buy pressure (bs >= 1)', () => {
    const r = evaluateShadowSelect(baseCfg, ctx({ buySellRatio5m: 1.25 }));
    expect(r.wouldBuy).toBe(false);
    expect(r.reasons.some((x) => x.startsWith('buy_sell_5m='))).toBe(true);
  });

  it('allows thin volume when vol floor is off', () => {
    const r = evaluateShadowSelect(baseCfg, ctx({ volume5mUsd: 50 }));
    expect(r.wouldBuy).toBe(true);
  });

  it('fails closed on missing ctx when required', () => {
    const r = evaluateShadowSelect(baseCfg, null);
    expect(r.wouldBuy).toBe(false);
    expect(r.reasons).toContain('ctx_missing');
  });

  it('rule id encodes dump thresholds', () => {
    expect(shadowSelectRuleId(baseCfg)).toContain('dump5m<=-5');
    expect(shadowSelectRuleId(baseCfg)).toContain('bs<1');
  });
});
