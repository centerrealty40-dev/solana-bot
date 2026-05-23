import { describe, expect, it } from 'vitest';
import type { PaperTraderConfig } from '../src/papertrader/config.js';
import type { OpenTrade } from '../src/papertrader/types.js';
import {
  VARIANT_A_V3_POLICY_ID,
  isVariantAScratchExitPolicy,
  isVariantALegacyV1ExitPolicy,
  stampVariantAOnOpen,
  variantAEvalTimedExit,
  variantAScratchEvalFlush,
  variantAScratchHadTp,
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
    liveOscarVariantASmart48Enabled: false,
    liveOscarVariantAScratchGapTailPct: 0.03,
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

describe('exit-policy-variant-a v3 scratch', () => {
  it('stamps variant_a_v3 on open when enabled (over wave B)', () => {
    const trade = ot();
    stampLiveOscarExitPolicyOnOpen(trade, cfg());
    expect(trade.liveExitPolicyId).toBe(VARIANT_A_V3_POLICY_ID);
    expect(isVariantAScratchExitPolicy(trade)).toBe(true);
    expect(trade.tpGridOverrides?.gridStepPnl).toBe(0);
    expect(trade.liveVariantAScratchHadTp).toBe(false);
  });

  it('flush @0% after TP crossing', () => {
    const trade = ot();
    stampVariantAOnOpen(trade, cfg());
    trade.partialSells.push({
      ts: Date.now(),
      price: 1.05,
      marketPrice: 1.05,
      sellFraction: 0.3,
      proceedsUsd: 100,
      grossProceedsUsd: 100,
      pnlUsd: 10,
      grossPnlUsd: 10,
      reason: 'TP_LADDER',
    });
    expect(variantAScratchHadTp(trade)).toBe(true);
    const flush = variantAScratchEvalFlush(trade, cfg(), 0, 0.06);
    expect(flush.kind).toBe('flush_all');
    if (flush.kind === 'flush_all') {
      expect(flush.tag).toBe('scratch_flush0');
    }
  });

  it('gap flush when PG skips through 0 to −3%', () => {
    const trade = ot();
    stampVariantAOnOpen(trade, cfg());
    trade.partialSells.push({
      ts: Date.now(),
      price: 1.05,
      marketPrice: 1.05,
      sellFraction: 0.3,
      proceedsUsd: 100,
      grossProceedsUsd: 100,
      pnlUsd: 10,
      grossPnlUsd: 10,
      reason: 'TP_LADDER',
    });
    const flush = variantAScratchEvalFlush(trade, cfg(), -0.03, 0.04);
    expect(flush.kind).toBe('flush_all');
    if (flush.kind === 'flush_all') {
      expect(flush.tag).toBe('scratch_gap_flush');
      expect(flush.useAvgPrice).toBe(true);
    }
  });

  it('h48 loss at 48h when still negative and no TP; skipped after TP', () => {
    const trade = ot();
    stampVariantAOnOpen(trade, cfg());
    trade.liveVariantASalvage24Checked = true;
    expect(variantAEvalTimedExit(trade, cfg(), -0.05, 48)).toBe('h48_loss');
    trade.partialSells.push({
      ts: Date.now(),
      price: 1.05,
      marketPrice: 1.05,
      sellFraction: 0.3,
      proceedsUsd: 100,
      grossProceedsUsd: 100,
      pnlUsd: 10,
      grossPnlUsd: 10,
      reason: 'TP_LADDER',
    });
    trade.liveVariantAH48Checked = false;
    expect(variantAEvalTimedExit(trade, cfg(), -0.05, 48)).toBe(null);
  });

  it('salvage24 at 24h when peak < 5% and pnl <= 0', () => {
    const trade = ot();
    stampVariantAOnOpen(trade, cfg());
    trade.liveVariantAScratchPeakPnlFrac = 0.02;
    const tag = variantAEvalTimedExit(trade, cfg(), -0.01, 24);
    expect(tag).toBe('salvage24');
  });
});

describe('exit-policy-variant-a v1 legacy', () => {
  it('moon and full trail apply only to v1', () => {
    const trade = ot();
    trade.liveExitPolicyId = 'variant_a_v1';
    trade.liveVariantATrailArmed = true;
    trade.liveVariantARemainderPeakPnlFrac = 0.4;
    expect(variantAMoonExitTriggered(trade, cfg(), 0.51)).toBe(true);
    expect(variantATrailFullExitTriggered(trade, cfg(), 0.27)).toBe(true);
    expect(isVariantALegacyV1ExitPolicy(trade)).toBe(true);
  });
});
