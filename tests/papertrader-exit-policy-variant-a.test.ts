import { describe, expect, it } from 'vitest';
import type { PaperTraderConfig } from '../src/papertrader/config.js';
import type { OpenTrade } from '../src/papertrader/types.js';
import {
  isVariantAExitPolicy,
  stampVariantAOnOpen,
  variantAEvalTimedExit,
  variantAMoonExitTriggered,
  variantATrailFullExitTriggered,
} from '../src/papertrader/executor/exit-policy-variant-a.js';
import { stampLiveOscarExitPolicyOnOpen } from '../src/papertrader/executor/exit-policy-wave-b.js';

function cfg(partial: Partial<PaperTraderConfig> = {}): PaperTraderConfig {
  return {
    strategyId: 'live-oscar',
    liveOscarExitPolicyVariantAEnabled: true,
    liveOscarExitPolicyWaveBEnabled: true,
    timeoutHours: 48,
    liveOscarVariantASalvage24Enabled: true,
    liveOscarVariantASalvage24MinPeakPct: 5,
    liveOscarVariantASmart48Enabled: true,
    liveOscarVariantAMaxHorizonHours: 96,
    liveOscarVariantAMoonTargetPct: 0.5,
    liveOscarVariantATrailArmPct: 0.35,
    liveOscarVariantATrailRetracePct: 0.12,
    ...partial,
  } as PaperTraderConfig;
}

function ot(): OpenTrade {
  return {
    mint: 'mint',
    symbol: 'SYM',
    lane: 'post_migration',
    source: 'pumpswap',
    metricType: 'price',
    dex: 'pumpswap',
    entryTs: Date.now() - 3600_000,
    entryMcUsd: 1,
    entryMetrics: {
      uniqueBuyers: 0,
      uniqueSellers: 0,
      sumBuySol: 0,
      sumSellSol: 0,
      topBuyerShare: 0,
      bcProgress: 0,
    },
    peakMcUsd: 1,
    peakPnlPct: 0,
    trailingArmed: false,
    legs: [{ ts: Date.now(), price: 1, marketPrice: 1, sizeUsd: 800, reason: 'open' }],
    partialSells: [],
    totalInvestedUsd: 800,
    avgEntry: 1,
    avgEntryMarket: 1,
    remainingFraction: 1,
    dcaUsedLevels: new Set(),
    dcaUsedIndices: new Set(),
    ladderUsedLevels: new Set(),
    ladderUsedIndices: new Set(),
  };
}

describe('exit-policy-variant-a', () => {
  it('stamps variant_a on open when enabled (over wave B)', () => {
    const trade = ot();
    stampLiveOscarExitPolicyOnOpen(trade, cfg());
    expect(trade.liveExitPolicyId).toBe('variant_a_v1');
    expect(isVariantAExitPolicy(trade)).toBe(true);
    expect(trade.tpGridOverrides?.gridStepPnl).toBe(0);
  });

  it('moon exit at +50%', () => {
    const trade = ot();
    stampVariantAOnOpen(trade, cfg());
    expect(variantAMoonExitTriggered(trade, cfg(), 0.51)).toBe(true);
    expect(variantAMoonExitTriggered(trade, cfg(), 0.49)).toBe(false);
  });

  it('trail full exit after arm + retrace', () => {
    const trade = ot();
    stampVariantAOnOpen(trade, cfg());
    trade.liveVariantATrailArmed = true;
    trade.liveVariantARemainderPeakPnlFrac = 0.4;
    expect(variantATrailFullExitTriggered(trade, cfg(), 0.27)).toBe(true);
    expect(variantATrailFullExitTriggered(trade, cfg(), 0.29)).toBe(false);
  });

  it('salvage24 at 24h when peak < 5% and pnl <= 0', () => {
    const trade = ot();
    stampVariantAOnOpen(trade, cfg());
    trade.liveVariantARemainderPeakPnlFrac = 0.02;
    const tag = variantAEvalTimedExit(trade, cfg(), -0.01, 24);
    expect(tag).toBe('salvage24');
  });

  it('h48_loss at 48h when still negative', () => {
    const trade = ot();
    stampVariantAOnOpen(trade, cfg());
    trade.liveVariantASalvage24Checked = true;
    const tag = variantAEvalTimedExit(trade, cfg(), -0.05, 48);
    expect(tag).toBe('h48_loss');
  });

  it('smart48 extends winners to 96h', () => {
    const trade = ot();
    stampVariantAOnOpen(trade, cfg());
    trade.liveVariantASalvage24Checked = true;
    const at48 = variantAEvalTimedExit(trade, cfg(), 0.08, 48);
    expect(at48).toBe(null);
    expect(trade.liveVariantASmart48Extended).toBe(true);
    expect(variantAEvalTimedExit(trade, cfg(), 0.06, 96)).toBe('horizon96');
  });
});
