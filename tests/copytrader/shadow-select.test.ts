import { describe, expect, it } from 'vitest';
import { evaluateShadowSelect, shadowSelectRuleId } from '../../src/copytrader/shadow-select.js';
import type { CopyEntryContext } from '../../src/copytrader/entry-context.js';

const baseCfg = {
  shadowSelectEnabled: true,
  shadowSelectMinVolume5mUsd: 2_000,
  shadowSelectMinBuySellRatio5m: 1,
  shadowSelectMinMcapUsd: 0,
  shadowSelectMinLiquidityUsd: 0,
  shadowSelectRequireCtx: true,
};

function ctx(partial: Partial<CopyEntryContext>): CopyEntryContext {
  return {
    mint: 'Mint111',
    pairAgeHours: 2,
    buys5m: 100,
    sells5m: 80,
    buySellRatio5m: 1.25,
    priceChange5mPct: 3,
    liquidityUsd: 40_000,
    marketCapUsd: 400_000,
    volume5mUsd: 12_000,
    volume1hUsd: 80_000,
    fetchedAtMs: Date.now(),
    ...partial,
  };
}

describe('evaluateShadowSelect', () => {
  it('passes fitted vol+pressure rule', () => {
    const r = evaluateShadowSelect(baseCfg, ctx({}));
    expect(r.wouldBuy).toBe(true);
    expect(r.reasons).toEqual([]);
  });

  it('fails low volume', () => {
    const r = evaluateShadowSelect(baseCfg, ctx({ volume5mUsd: 500 }));
    expect(r.wouldBuy).toBe(false);
    expect(r.reasons.some((x) => x.startsWith('volume_5m_usd='))).toBe(true);
  });

  it('fails low pressure', () => {
    const r = evaluateShadowSelect(baseCfg, ctx({ buySellRatio5m: 0.7 }));
    expect(r.wouldBuy).toBe(false);
  });

  it('fails closed on missing ctx when required', () => {
    const r = evaluateShadowSelect(baseCfg, null);
    expect(r.wouldBuy).toBe(false);
    expect(r.reasons).toContain('ctx_missing');
  });

  it('rule id encodes thresholds', () => {
    expect(shadowSelectRuleId(baseCfg)).toContain('vol5m>=2000');
  });
});
