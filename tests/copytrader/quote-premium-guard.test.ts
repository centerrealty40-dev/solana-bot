import { describe, expect, it } from 'vitest';
import {
  checkQuotePremium,
  effectiveQuotePremiumCap,
} from '../../src/copytrader/evaluate.js';
import { isBuyTerminalError } from '../../src/copytrader/pending-buy-retry.js';

describe('checkQuotePremium', () => {
  it('passes a quote at the leader price', () => {
    const v = checkQuotePremium({ quotePriceUsd: 100, leaderPriceUsd: 100, maxPremiumPct: 6 });
    expect(v.block).toBe(false);
    expect(v.premiumPct).toBeCloseTo(0, 6);
  });

  it('passes a quote below the leader price', () => {
    const v = checkQuotePremium({ quotePriceUsd: 92, leaderPriceUsd: 100, maxPremiumPct: 6 });
    expect(v.block).toBe(false);
    expect(v.premiumPct).toBeCloseTo(-8, 6);
  });

  it('passes exactly at the cap', () => {
    const v = checkQuotePremium({ quotePriceUsd: 106, leaderPriceUsd: 100, maxPremiumPct: 6 });
    expect(v.block).toBe(false);
  });

  it('blocks just over the cap', () => {
    const v = checkQuotePremium({ quotePriceUsd: 106.01, leaderPriceUsd: 100, maxPremiumPct: 6 });
    expect(v.block).toBe(true);
    if (!v.block) throw new Error('expected block');
    expect(v.maxAllowedPriceUsd).toBeCloseTo(106, 6);
    expect(v.reason).toContain('quote_premium_too_high');
  });

  /**
   * The live case this guard exists for: leader filled GfyVVfTS at 2.4197e-5,
   * our Jupiter fill landed at 2.9718e-5 (+22.8%) on a 3% snapshot cap, and the
   * position was killed at −59% while the leader closed the session at +20.7%.
   */
  it('blocks the GfyVVfTS-shaped fill that the snapshot cap let through', () => {
    const v = checkQuotePremium({
      quotePriceUsd: 0.000029717743972954914,
      leaderPriceUsd: 0.000024196542037827247,
      maxPremiumPct: 6,
    });
    expect(v.block).toBe(true);
    if (!v.block) throw new Error('expected block');
    expect(v.premiumPct).toBeGreaterThan(22);
    expect(v.premiumPct).toBeLessThan(23);
  });

  it('does not block when the leader price anchor is missing', () => {
    const v = checkQuotePremium({ quotePriceUsd: 100, leaderPriceUsd: 0, maxPremiumPct: 6 });
    expect(v.block).toBe(false);
    expect(v.premiumPct).toBeNull();
  });

  it('does not block when the quote price is unresolvable', () => {
    const v = checkQuotePremium({ quotePriceUsd: 0, leaderPriceUsd: 100, maxPremiumPct: 6 });
    expect(v.block).toBe(false);
    expect(v.premiumPct).toBeNull();
  });

  it('treats a zero cap as at-or-below-leader, not as disabled', () => {
    expect(checkQuotePremium({ quotePriceUsd: 100, leaderPriceUsd: 100, maxPremiumPct: 0 }).block).toBe(
      false,
    );
    expect(
      checkQuotePremium({ quotePriceUsd: 100.5, leaderPriceUsd: 100, maxPremiumPct: 0 }).block,
    ).toBe(true);
  });
});

describe('effectiveQuotePremiumCap', () => {
  it('uses the wider first-shot cap inside the grace window', () => {
    const v = effectiveQuotePremiumCap({
      guardPct: 6,
      firstShotPct: 10,
      graceMs: 8_000,
      leaderBuyTs: 1_000,
      nowMs: 1_000 + 3_000,
    });
    expect(v.firstShot).toBe(true);
    expect(v.maxPremiumPct).toBe(10);
  });

  it('falls back to the steady guard after the grace window', () => {
    const v = effectiveQuotePremiumCap({
      guardPct: 6,
      firstShotPct: 10,
      graceMs: 8_000,
      leaderBuyTs: 1_000,
      nowMs: 1_000 + 9_000,
    });
    expect(v.firstShot).toBe(false);
    expect(v.maxPremiumPct).toBe(6);
  });

  it('lets a 9% quote clear on the first shot but not after grace', () => {
    const first = effectiveQuotePremiumCap({
      guardPct: 6,
      firstShotPct: 10,
      graceMs: 8_000,
      leaderBuyTs: 1_000,
      nowMs: 1_000 + 4_000,
    });
    expect(
      checkQuotePremium({ quotePriceUsd: 109, leaderPriceUsd: 100, maxPremiumPct: first.maxPremiumPct })
        .block,
    ).toBe(false);

    const late = effectiveQuotePremiumCap({
      guardPct: 6,
      firstShotPct: 10,
      graceMs: 8_000,
      leaderBuyTs: 1_000,
      nowMs: 1_000 + 20_000,
    });
    expect(
      checkQuotePremium({ quotePriceUsd: 109, leaderPriceUsd: 100, maxPremiumPct: late.maxPremiumPct })
        .block,
    ).toBe(true);
  });
});

describe('isBuyTerminalError', () => {
  it('treats a quote-premium miss as terminal so we skip instead of chase', () => {
    // HgU5fJ88: 14 blocked retries then a late fill into −20% while the leader
    // closed +23% two minutes earlier.
    expect(isBuyTerminalError('quote_premium_too_high premium=10.69%>max=6%')).toBe(true);
  });

  it('still retries transient swap failures', () => {
    expect(isBuyTerminalError('jupiter_buy_quote_failed')).toBe(false);
    expect(isBuyTerminalError('sim_failed:{"InstructionError":[3,{"Custom":6024}]}')).toBe(false);
    expect(isBuyTerminalError('qn_rate:Too Many Requests')).toBe(false);
  });
});
