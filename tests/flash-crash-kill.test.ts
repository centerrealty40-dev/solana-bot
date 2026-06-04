import { describe, it, expect } from 'vitest';
import {
  appendFlashKillPriceSample,
  evaluateFlashCrashKill,
  stampFlashKillLastBuyLeg,
  isFlashKillDcaBlocked,
  markFlashKillDcaBlocked,
} from '../src/papertrader/executor/flash-crash-kill.js';
import type { OpenTrade } from '../src/papertrader/types.js';

const aggressiveCfg = {
  flashCrashKillEnabled: true,
  flashCrashKillDrop30sPct: -0.06,
  flashCrashKillDrop60sPct: -0.08,
  flashCrashKillDrop180sPct: -0.12,
  flashCrashKillPostDcaWarnPct: -0.05,
  flashCrashKillPostDcaFullPct: -0.07,
  flashCrashKillPostDcaWarnWindowMs: 120_000,
  flashCrashKillPostDcaFullWindowMs: 180_000,
  flashCrashKillQuoteMaxDiscountPct: 0.08,
  flashCrashKillQuoteDrop60sPct: -0.05,
  flashCrashKillPartialSellFraction: 0.75,
  flashCrashKillDcaBlockMs: 300_000,
} as never;

function minimalOt(): OpenTrade {
  return {
    mint: 'test',
    symbol: 'GACHA',
    lane: 'graduated',
    source: 'raydium',
    metricType: 'price',
    dex: 'raydium',
    entryTs: 0,
    entryMcUsd: 1,
    peakMcUsd: 1,
    peakPnlPct: 0,
    trailingArmed: false,
    legs: [],
    partialSells: [],
    totalInvestedUsd: 100,
    avgEntry: 1,
    avgEntryMarket: 1,
    remainingFraction: 1,
    dcaUsedLevels: new Set(),
    dcaUsedIndices: new Set(),
    ladderUsedLevels: new Set(),
    ladderUsedIndices: new Set(),
    pairAddress: null,
  };
}

describe('evaluateFlashCrashKill', () => {
  it('returns none when disabled', () => {
    const ot = minimalOt();
    const v = evaluateFlashCrashKill(
      { ...aggressiveCfg, flashCrashKillEnabled: false } as never,
      ot,
      1000,
      1,
    );
    expect(v.kind).toBe('none');
  });

  it('full exit on −8% / 60s impulse (GACHA-style knife after DCA)', () => {
    const ot = minimalOt();
    const t0 = 1_700_000_000_000;
    appendFlashKillPriceSample(ot, t0 - 60_000, 0.0037);
    appendFlashKillPriceSample(ot, t0 - 30_000, 0.0036);
    appendFlashKillPriceSample(ot, t0, 0.0033);
    const v = evaluateFlashCrashKill(aggressiveCfg, ot, t0, 0.0033);
    expect(v.kind).toBe('full');
    if (v.kind === 'full') expect(v.trigger).toMatch(/impulse_-6%\/30s/);
  });

  it('partial then full post-fill after last buy leg (DCA stamp)', () => {
    const ot = minimalOt();
    const buyTs = 1_700_000_000_000;
    stampFlashKillLastBuyLeg(ot, 0.0038, buyTs);
    const warn = evaluateFlashCrashKill(aggressiveCfg, ot, buyTs + 90_000, 0.00361);
    expect(warn.kind).toBe('partial');
    if (warn.kind === 'partial') expect(warn.sellFraction).toBe(0.75);

    const full = evaluateFlashCrashKill(aggressiveCfg, ot, buyTs + 120_000, 0.00353);
    expect(full.kind).toBe('full');
    if (full.kind === 'full') expect(full.trigger).toMatch(/post_fill_-7%/);
  });

  it('blocks DCA after markFlashKillDcaBlocked', () => {
    const ot = minimalOt();
    const now = Date.now();
    markFlashKillDcaBlocked(ot, aggressiveCfg, now);
    expect(isFlashKillDcaBlocked(aggressiveCfg, ot, now + 1)).toBe(true);
    expect(isFlashKillDcaBlocked(aggressiveCfg, ot, now + 400_000)).toBe(false);
  });
});
