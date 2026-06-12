import { describe, it, expect } from 'vitest';
import type { OpenTrade } from '../src/papertrader/types.js';
import {
  waveBPreArmKillEligible,
  waveBUpdatePreArmReached,
  waveBAbsoluteKillEligible,
  WAVE_B_PRE_ARM_KILL_ARM_PNL_FRAC,
} from '../src/papertrader/executor/exit-policy-wave-b.js';
import { stampLiveOscarExitPolicyOnOpen } from '../src/papertrader/executor/exit-policy-wave-b.js';
import { loadPaperTraderConfig } from '../src/papertrader/config.js';

function waveBOpen(entryMarket = 1): OpenTrade {
  process.env.PAPER_STRATEGY_ID = 'live-oscar';
  process.env.PAPER_LIVE_OSCAR_EXIT_POLICY_WAVE_B = '1';
  const cfg = loadPaperTraderConfig();
  const ot: OpenTrade = {
    mint: 'mint',
    symbol: 'SYM',
    lane: 'post_migration',
    source: 'pumpswap',
    metricType: 'price',
    dex: 'pumpswap',
    entryTs: Date.now(),
    entryMcUsd: entryMarket,
    entryMarketCapUsd: null,
    entryMetrics: {
      uniqueBuyers: 0,
      uniqueSellers: 0,
      sumBuySol: 0,
      sumSellSol: 0,
      topBuyerShare: 0,
      bcProgress: 0,
    },
    peakMcUsd: entryMarket,
    peakPnlPct: 0,
    trailingArmed: false,
    legs: [
      {
        ts: Date.now(),
        price: entryMarket,
        marketPrice: entryMarket,
        sizeUsd: 500,
        reason: 'open',
      },
    ],
    partialSells: [],
    totalInvestedUsd: 500,
    avgEntry: entryMarket,
    avgEntryMarket: entryMarket,
    remainingFraction: 1,
    dcaUsedLevels: new Set(),
    dcaUsedIndices: new Set(),
    ladderUsedLevels: new Set(),
    ladderUsedIndices: new Set(),
    pairAddress: null,
    entryLiqUsd: null,
    liveKillstopBelowStreak: 0,
  };
  stampLiveOscarExitPolicyOnOpen(ot, cfg);
  return ot;
}

describe('wave B pre-arm kill', () => {
  it('fires kill at −9% before +7.5% touch', () => {
    const ot = waveBOpen(1);
    expect(waveBPreArmKillEligible(ot, -0.09, 0.9)).toBe(true);
    expect(waveBPreArmKillEligible(ot, -0.09, 0.91)).toBe(true);
    expect(waveBPreArmKillEligible(ot, -0.09, 0.92)).toBe(false);
  });

  it('disables pre-arm kill after +7.5% but absolute −9% floor remains', () => {
    const ot = waveBOpen(1);
    const armPx = 1 * (1 + WAVE_B_PRE_ARM_KILL_ARM_PNL_FRAC);
    waveBUpdatePreArmReached(ot, armPx);
    expect(ot.liveWavePreArmReached).toBe(true);
    expect(waveBPreArmKillEligible(ot, -0.09, 0.85)).toBe(false);
    expect(waveBAbsoluteKillEligible(ot, -0.09, 0.9, -0.095)).toBe(true);
  });
});
