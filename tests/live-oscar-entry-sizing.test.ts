import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadPaperTraderConfig } from '../src/papertrader/config.js';
import { buildLiveStagedEntryState } from '../src/papertrader/executor/live-staged-entry-gates.js';
import { resolveLiveOscarMcapTier } from '../src/papertrader/live-oscar-mcap-tier.js';
import {
  applyCanonicalOpenLegUsd,
  applyCanonicalStagedEntrySizing,
  assertLiveOscarUnifiedEntrySizing,
  resolveLiveOscarEntrySplitLeg2Usd,
  resolveLiveOscarEntrySplitLeg3Usd,
  resolveLiveOscarEntrySplitLeg4Usd,
  resolveLiveOscarEntrySplitLeg5Usd,
  resolveLiveOscarEntrySplitLeg6Usd,
  resolveLiveOscarEntrySplitLeg7Usd,
  resolveLiveOscarEntrySplitLegUsd,
  resolveLiveOscarEntrySplitTotalUsd,
  resolveLiveOscarStagedAvgFirstDropPct,
  resolveLiveOscarStagedAvgLegUsd,
  resolveLiveOscarStagedAvgSecondLegUsd,
  resolveLiveOscarStagedEntryMaxUsd,
  resolveLiveOscarTradeTierFromMcap,
} from '../src/papertrader/live-oscar-entry-sizing.js';
import type { OpenTrade } from '../src/papertrader/types.js';

describe('live-oscar-entry-sizing', () => {
  const envBackup: Record<string, string | undefined> = {};

  beforeEach(() => {
    const keys = [
      'PAPER_STRATEGY_ID',
      'PAPER_LIVE_STAGED_ENTRY_ENABLED',
      'PAPER_LIVE_STAGED_ENTRY_ENTRY_SPLIT_LEG_USD',
      'PAPER_LIVE_STAGED_ENTRY_ENTRY_SPLIT_LEG2_USD',
      'PAPER_LIVE_STAGED_ENTRY_ENTRY_SPLIT_LEG3_USD',
      'PAPER_LIVE_STAGED_ENTRY_ENTRY_SPLIT_LEG4_USD',
      'PAPER_LIVE_STAGED_ENTRY_ENTRY_SPLIT_LEG5_USD',
      'PAPER_LIVE_STAGED_ENTRY_ENTRY_SPLIT_LEG6_USD',
      'PAPER_LIVE_STAGED_ENTRY_ENTRY_SPLIT_LEG7_USD',
      'PAPER_LIVE_STAGED_ENTRY_FIRST_LEG_USD',
      'PAPER_POSITION_USD',
      'PAPER_LIVE_STAGED_ENTRY_SECOND_LEG_USD',
      'PAPER_LIVE_STAGED_ENTRY_SECOND_DROP_PCT',
      'PAPER_LIVE_STAGED_ENTRY_THIRD_LEG_USD',
      'PAPER_LIVE_STAGED_ENTRY_THIRD_DROP_PCT',
      'PAPER_LIVE_OSCAR_MICRO_MCAP_LANE_ENABLED',
      'PAPER_LIVE_OSCAR_LOW_MCAP_LANE_ENABLED',
      'PAPER_LIVE_OSCAR_LOW_MCAP_MIN_USD',
      'PAPER_LIVE_OSCAR_LOW_MCAP_MAX_USD',
      'PAPER_LIVE_OSCAR_LOW_MCAP_ENTRY_SPLIT_LEG_USD',
      'PAPER_LIVE_OSCAR_LOW_MCAP_ENTRY_SPLIT_LEG2_USD',
      'PAPER_LIVE_OSCAR_LOW_MCAP_ENTRY_SPLIT_LEG3_USD',
      'PAPER_LIVE_OSCAR_LOW_MCAP_POSITION_USD',
      'PAPER_LIVE_OSCAR_LOW_MCAP_STAGED_AVG_LEG_USD',
      'PAPER_LIVE_OSCAR_LOW_MCAP_STAGED_AVG_DROP_PCT',
      'PAPER_LIVE_STAGED_ENTRY_ENTRY_SPLIT_DELAY_MS',
    ];
    for (const k of keys) envBackup[k] = process.env[k];
    process.env.PAPER_STRATEGY_ID = 'live-oscar';
    process.env.PAPER_LIVE_STAGED_ENTRY_ENABLED = '1';
    process.env.PAPER_LIVE_STAGED_ENTRY_ENTRY_SPLIT_LEG_USD = '300';
    process.env.PAPER_LIVE_STAGED_ENTRY_ENTRY_SPLIT_LEG2_USD = '300';
    process.env.PAPER_LIVE_STAGED_ENTRY_ENTRY_SPLIT_LEG3_USD = '300';
    process.env.PAPER_LIVE_STAGED_ENTRY_ENTRY_SPLIT_LEG4_USD = '300';
    process.env.PAPER_LIVE_STAGED_ENTRY_ENTRY_SPLIT_LEG5_USD = '300';
    process.env.PAPER_LIVE_STAGED_ENTRY_ENTRY_SPLIT_LEG6_USD = '300';
    process.env.PAPER_LIVE_STAGED_ENTRY_ENTRY_SPLIT_LEG7_USD = '300';
    process.env.PAPER_LIVE_STAGED_ENTRY_FIRST_LEG_USD = '300';
    process.env.PAPER_POSITION_USD = '2100';
    process.env.PAPER_LIVE_STAGED_ENTRY_SECOND_LEG_USD = '400';
    process.env.PAPER_LIVE_STAGED_ENTRY_SECOND_DROP_PCT = '10';
    process.env.PAPER_LIVE_STAGED_ENTRY_THIRD_LEG_USD = '600';
    process.env.PAPER_LIVE_STAGED_ENTRY_THIRD_DROP_PCT = '20';
    process.env.PAPER_LIVE_OSCAR_MICRO_MCAP_LANE_ENABLED = '0';
    process.env.PAPER_LIVE_OSCAR_LOW_MCAP_LANE_ENABLED = '1';
    process.env.PAPER_LIVE_OSCAR_LOW_MCAP_MIN_USD = '2000000';
    process.env.PAPER_LIVE_OSCAR_LOW_MCAP_MAX_USD = '3000000';
    process.env.PAPER_LIVE_OSCAR_LOW_MCAP_ENTRY_SPLIT_LEG_USD = '250';
    process.env.PAPER_LIVE_OSCAR_LOW_MCAP_ENTRY_SPLIT_LEG2_USD = '250';
    process.env.PAPER_LIVE_OSCAR_LOW_MCAP_ENTRY_SPLIT_LEG3_USD = '0';
    process.env.PAPER_LIVE_OSCAR_LOW_MCAP_POSITION_USD = '500';
    process.env.PAPER_LIVE_OSCAR_LOW_MCAP_STAGED_AVG_LEG_USD = '350';
    process.env.PAPER_LIVE_OSCAR_LOW_MCAP_STAGED_AVG_DROP_PCT = '10';
    process.env.PAPER_LIVE_STAGED_ENTRY_ENTRY_SPLIT_DELAY_MS = '5000';
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(envBackup)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('passes boot validation when env is aligned', () => {
    const cfg = loadPaperTraderConfig();
    expect(() => assertLiveOscarUnifiedEntrySizing(cfg)).not.toThrow();
    expect(resolveLiveOscarEntrySplitLegUsd(cfg, 'prod')).toBe(300);
    expect(resolveLiveOscarEntrySplitLeg2Usd(cfg, 'prod')).toBe(300);
    expect(resolveLiveOscarEntrySplitLeg3Usd(cfg, 'prod')).toBe(300);
    expect(resolveLiveOscarEntrySplitLeg4Usd(cfg, 'prod')).toBe(300);
    expect(resolveLiveOscarEntrySplitLeg5Usd(cfg, 'prod')).toBe(300);
    expect(resolveLiveOscarEntrySplitLeg6Usd(cfg, 'prod')).toBe(300);
    expect(resolveLiveOscarEntrySplitLeg7Usd(cfg, 'prod')).toBe(300);
    expect(resolveLiveOscarEntrySplitTotalUsd(cfg, 'prod')).toBe(2100);
    expect(resolveLiveOscarEntrySplitLegUsd(cfg, 'low')).toBe(250);
    expect(resolveLiveOscarEntrySplitLeg2Usd(cfg, 'low')).toBe(250);
    expect(resolveLiveOscarEntrySplitLeg3Usd(cfg, 'low')).toBe(0);
  });

  it('throws when low-mcap position is not leg1+leg2', () => {
    process.env.PAPER_LIVE_OSCAR_LOW_MCAP_POSITION_USD = '600';
    const cfg = loadPaperTraderConfig();
    expect(() => assertLiveOscarUnifiedEntrySizing(cfg)).toThrow(/LOW_MCAP_POSITION/);
  });

  it('tier-aware staged avg: low −10% $350; prod −10%/$400 + −20%/$600', () => {
    const cfg = loadPaperTraderConfig();
    expect(resolveLiveOscarStagedAvgFirstDropPct(cfg, 'low')).toBe(10);
    expect(resolveLiveOscarStagedAvgLegUsd(cfg, 'low')).toBe(350);
    expect(resolveLiveOscarStagedAvgFirstDropPct(cfg, 'prod')).toBe(10);
    expect(resolveLiveOscarStagedAvgLegUsd(cfg, 'prod')).toBe(400);
    expect(resolveLiveOscarStagedAvgSecondLegUsd(cfg, 'prod')).toBe(600);
    expect(resolveLiveOscarStagedEntryMaxUsd(cfg, 'low')).toBe(850);
    expect(resolveLiveOscarStagedEntryMaxUsd(cfg, 'prod')).toBe(3100);
  });

  it('buildLiveStagedEntryState uses $350 avg @ −10% for low mcap', () => {
    const cfg = loadPaperTraderConfig();
    const st = buildLiveStagedEntryState(cfg, { signalTs: 1, signalPriceUsd: 0.01 }, { marketCapUsd: 2_500_000 });
    expect(st.avgSecondLegUsd).toBe(350);
    expect(st.avgSecondDropPct).toBe(10);
    expect(st.entrySplitLeg3Usd).toBe(0);
    expect(st.entrySplitLeg3Done).toBe(true);
  });

  it('buildLiveStagedEntryState uses 7×$300 split + prod avg for prod mcap', () => {
    const cfg = loadPaperTraderConfig();
    const st = buildLiveStagedEntryState(cfg, { signalTs: 1, signalPriceUsd: 0.01 }, { marketCapUsd: 5_000_000 });
    expect(st.entrySplitLegUsd).toBe(300);
    expect(st.entrySplitLeg2Usd).toBe(300);
    expect(st.entrySplitLeg3Usd).toBe(300);
    expect(st.entrySplitLeg4Usd).toBe(300);
    expect(st.entrySplitLeg5Usd).toBe(300);
    expect(st.entrySplitLeg6Usd).toBe(300);
    expect(st.entrySplitLeg7Usd).toBe(300);
    expect(st.entrySplitLeg7Done).toBe(false);
    expect(st.avgSecondLegUsd).toBe(400);
    expect(st.avgSecondDropPct).toBe(10);
    expect(st.avgThirdLegUsd).toBe(600);
    expect(st.avgThirdDropPct).toBe(20);
    expect(st.entrySplitDelayMs).toBe(5000);
  });

  it('below $2M resolves to below tier when micro disabled', () => {
    const cfg = loadPaperTraderConfig();
    expect(resolveLiveOscarMcapTier(cfg, 1_500_000)).toBe('below');
    expect(resolveLiveOscarTradeTierFromMcap(cfg, 1_500_000)).toBeUndefined();
  });

  it('applyCanonicalOpenLegUsd fixes pre-buy open leg for low tier', () => {
    const cfg = loadPaperTraderConfig();
    const st = buildLiveStagedEntryState(cfg, { signalTs: 1, signalPriceUsd: 0.01 }, { marketCapUsd: 2_500_000 });
    const ot: OpenTrade = {
      mint: 'mint',
      symbol: 'T',
      lane: 'post_migration',
      source: 'pumpswap',
      metricType: 'price',
      dex: 'pumpswap',
      entryTs: 1,
      entryMcUsd: 0.01,
      entryMarketCapUsd: 2_500_000,
      liveOscarMcapTier: 'low',
      entryMetrics: {
        uniqueBuyers: 0,
        uniqueSellers: 0,
        sumBuySol: 0,
        sumSellSol: 0,
        topBuyerShare: 0,
        bcProgress: 0,
      },
      peakMcUsd: 0.01,
      peakPnlPct: 0,
      trailingArmed: false,
      legs: [{ ts: 1, price: 0.01, marketPrice: 0.01, sizeUsd: 200, reason: 'open' }],
      partialSells: [],
      totalInvestedUsd: 200,
      avgEntry: 0.01,
      avgEntryMarket: 0.01,
      remainingFraction: 1,
      dcaUsedLevels: new Set(),
      dcaUsedIndices: new Set(),
      ladderUsedLevels: new Set(),
      ladderUsedIndices: new Set(),
      liveStagedEntry: st,
    };
    applyCanonicalOpenLegUsd(cfg, ot);
    expect(ot.legs[0]!.sizeUsd).toBe(250);
    expect(ot.liveStagedEntry!.entrySplitLegUsd).toBe(250);
    expect(ot.totalInvestedUsd).toBe(250);
  });

  it('applyCanonicalStagedEntrySizing upgrades restored plan', () => {
    const cfg = loadPaperTraderConfig();
    const st = buildLiveStagedEntryState(cfg, { signalTs: 1, signalPriceUsd: 0.01 });
    st.entrySplitLegUsd = 200;
    st.entrySplitLeg2Usd = 100;
    st.entrySplitDelayMs = 10000;
    applyCanonicalStagedEntrySizing(cfg, st);
    expect(st.entrySplitLegUsd).toBe(300);
    expect(st.entrySplitLeg2Usd).toBe(300);
    expect(st.entrySplitLeg3Usd).toBe(300);
    expect(st.entrySplitLeg4Usd).toBe(300);
    expect(st.entrySplitLeg5Usd).toBe(300);
    expect(st.entrySplitLeg6Usd).toBe(300);
    expect(st.entrySplitLeg7Usd).toBe(300);
    expect(st.entrySplitDelayMs).toBe(5000);
  });
});
