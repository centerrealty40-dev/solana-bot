import { describe, expect, it } from 'vitest';
import {
  evaluateLeaderStyleEntry,
  evaluateLeaderStyleExit,
  shouldJournalLeaderStyleSkip,
} from '../../src/milddip/leader-style.js';
import { validateStreamDexPrice } from '../../src/milddip/price-sanity.js';

const entry = (overrides: Record<string, unknown> = {}) =>
  evaluateLeaderStyleEntry({
    enabled: true,
    dataAgeMs: 300_000,
    minDataAgeMs: 300_000,
    volume5mUsd: 300_000,
    liquidityUsd: 100_000,
    minVol5mToLiq: 3,
    minLiquidityUsd: 50_000,
    maxLiquidityUsd: 400_000,
    currentPriceUsd: 95,
    localHighUsd: 100,
    localLowUsd: 80,
    pullbackPct: 5,
    ...overrides,
  });

describe('leader-style pure gates', () => {
  it('requires minimum data age and turnover/liquidity corridor', () => {
    expect(entry({ dataAgeMs: 299_999 }).reason).toBe('insufficient_data_age');
    expect(entry({ volume5mUsd: 299_999 }).reason).toBe('turnover_below_floor');
    expect(entry({ liquidityUsd: 49_999 }).reason).toBe('liquidity_below_floor');
    expect(entry({ liquidityUsd: 400_001 }).reason).toBe('liquidity_above_ceiling');
  });

  it('requires a pullback above the local low', () => {
    expect(entry({ currentPriceUsd: 97 }).reason).toBe('no_pullback');
    expect(entry({ currentPriceUsd: 80 }).reason).toBe('at_local_low');
    expect(entry().pass).toBe(true);
  });

  it('accepts a young high-turnover green runner on its own lane', () => {
    expect(entry({
      dataAgeMs: 120_000,
      minDataAgeMs: 120_000,
      volume5mUsd: 2_000_000,
      liquidityUsd: 100_000,
    }).pass).toBe(true);
  });

  it('throttles skip journaling by mint and hourly budget', () => {
    expect(shouldJournalLeaderStyleSkip({
      lastAtMs: null, nowMs: 100_000, intervalMs: 60_000, hourCount: 0, maxPerHour: 60,
    })).toBe(true);
    expect(shouldJournalLeaderStyleSkip({
      lastAtMs: 100_000, nowMs: 120_000, intervalMs: 60_000, hourCount: 1, maxPerHour: 60,
    })).toBe(false);
    expect(shouldJournalLeaderStyleSkip({
      lastAtMs: 100_000, nowMs: 120_000, intervalMs: 60_000, hourCount: 60, maxPerHour: 60,
    })).toBe(false);
    expect(shouldJournalLeaderStyleSkip({
      lastAtMs: 100_000, nowMs: 200_000, intervalMs: 60_000, hourCount: 1, maxPerHour: 60,
    })).toBe(true);
  });

  it('supports rebound, pnl, fade, depth and hold exits', () => {
    const base = {
      heldMs: 1,
      maxHoldMs: 14_400_000,
      pnlPct: 0,
      pnlTpPct: 20,
      bounceOffTroughPct: 25,
      profitReboundPct: 25,
      liqRatio: 1,
      volumeFade: false,
      depthDrainRatio: 1,
      depthDrainMax: 1.06,
    };
    expect(evaluateLeaderStyleExit(base).reason).toBe('lstyle_profit_rebound');
    expect(evaluateLeaderStyleExit({ ...base, bounceOffTroughPct: 0, pnlPct: 20 }).reason).toBe('lstyle_pnl_tp');
    expect(evaluateLeaderStyleExit({ ...base, bounceOffTroughPct: 0, volumeFade: true }).reason).toBe('lstyle_vol_fade');
    expect(evaluateLeaderStyleExit({ ...base, bounceOffTroughPct: 0, depthDrainRatio: 1.07 }).reason).toBe('lstyle_depth_drain');
    expect(evaluateLeaderStyleExit({ ...base, bounceOffTroughPct: 0, heldMs: 14_400_000 }).reason).toBe('lstyle_max_hold');
    expect(evaluateLeaderStyleExit({ ...base, bounceOffTroughPct: 0 }).shouldExit).toBe(false);
  });
});

describe('stream/DEX price sanity', () => {
  it('accepts a matching pair and rejects divergent prices', () => {
    expect(validateStreamDexPrice({ streamPriceUsd: 2, dexPriceUsd: 1, maxDivergenceFactor: 2 }).valid).toBe(true);
    const bad = validateStreamDexPrice({
      streamPriceUsd: 2.13e-7,
      dexPriceUsd: 0.002336,
      maxDivergenceFactor: 2,
    });
    expect(bad.valid).toBe(false);
    expect(bad.divergence).toBeGreaterThan(2);
  });
});
