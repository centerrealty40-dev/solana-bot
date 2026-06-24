import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadPaperTraderConfig } from '../src/papertrader/config.js';
import { buildLiveStagedEntryState } from '../src/papertrader/executor/live-staged-entry-gates.js';
import { resolveLiveOscarMcapTier } from '../src/papertrader/live-oscar-mcap-tier.js';
import {
  applyCanonicalOpenLegUsd,
  applyCanonicalStagedEntrySizing,
  assertLiveOscarUnifiedEntrySizing,
  resolveLiveOscarEntrySplitLeg2Usd,
  resolveLiveOscarEntrySplitLegUsd,
  resolveLiveOscarEntrySplitTotalUsd,
  resolveLiveOscarStagedAvgLegUsd,
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
      'PAPER_LIVE_STAGED_ENTRY_FIRST_LEG_USD',
      'PAPER_POSITION_USD',
      'PAPER_LIVE_OSCAR_MICRO_MCAP_LANE_ENABLED',
      'PAPER_LIVE_OSCAR_MICRO_MCAP_MIN_USD',
      'PAPER_LIVE_OSCAR_MICRO_MCAP_MAX_USD',
      'PAPER_LIVE_OSCAR_MICRO_MCAP_ENTRY_SPLIT_LEG_USD',
      'PAPER_LIVE_OSCAR_MICRO_MCAP_ENTRY_SPLIT_LEG2_USD',
      'PAPER_LIVE_OSCAR_MICRO_MCAP_POSITION_USD',
      'PAPER_LIVE_OSCAR_MICRO_MCAP_STAGED_AVG_LEG_USD',
      'PAPER_LIVE_OSCAR_LOW_MCAP_LANE_ENABLED',
      'PAPER_LIVE_OSCAR_LOW_MCAP_MIN_USD',
      'PAPER_LIVE_OSCAR_LOW_MCAP_MAX_USD',
      'PAPER_LIVE_OSCAR_LOW_MCAP_ENTRY_SPLIT_LEG_USD',
      'PAPER_LIVE_OSCAR_LOW_MCAP_ENTRY_SPLIT_LEG2_USD',
      'PAPER_LIVE_OSCAR_LOW_MCAP_POSITION_USD',
      'PAPER_LIVE_OSCAR_LOW_MCAP_STAGED_AVG_LEG_USD',
      'PAPER_LIVE_STAGED_ENTRY_SECOND_LEG_USD',
    ];
    for (const k of keys) envBackup[k] = process.env[k];
    process.env.PAPER_STRATEGY_ID = 'live-oscar';
    process.env.PAPER_LIVE_STAGED_ENTRY_ENABLED = '1';
    process.env.PAPER_LIVE_STAGED_ENTRY_ENTRY_SPLIT_LEG_USD = '1000';
    process.env.PAPER_LIVE_STAGED_ENTRY_ENTRY_SPLIT_LEG2_USD = '500';
    process.env.PAPER_LIVE_STAGED_ENTRY_FIRST_LEG_USD = '1000';
    process.env.PAPER_POSITION_USD = '1500';
    process.env.PAPER_LIVE_OSCAR_MICRO_MCAP_LANE_ENABLED = '1';
    process.env.PAPER_LIVE_OSCAR_MICRO_MCAP_MIN_USD = '500000';
    process.env.PAPER_LIVE_OSCAR_MICRO_MCAP_MAX_USD = '1300000';
    process.env.PAPER_LIVE_OSCAR_MICRO_MCAP_ENTRY_SPLIT_LEG_USD = '300';
    process.env.PAPER_LIVE_OSCAR_MICRO_MCAP_ENTRY_SPLIT_LEG2_USD = '200';
    process.env.PAPER_LIVE_OSCAR_MICRO_MCAP_POSITION_USD = '500';
    process.env.PAPER_LIVE_OSCAR_LOW_MCAP_LANE_ENABLED = '1';
    process.env.PAPER_LIVE_OSCAR_LOW_MCAP_MIN_USD = '1300000';
    process.env.PAPER_LIVE_OSCAR_LOW_MCAP_MAX_USD = '3000000';
    process.env.PAPER_LIVE_OSCAR_LOW_MCAP_ENTRY_SPLIT_LEG_USD = '1000';
    process.env.PAPER_LIVE_OSCAR_LOW_MCAP_ENTRY_SPLIT_LEG2_USD = '500';
    process.env.PAPER_LIVE_OSCAR_LOW_MCAP_POSITION_USD = '1500';
    process.env.PAPER_LIVE_OSCAR_LOW_MCAP_STAGED_AVG_LEG_USD = '300';
    process.env.PAPER_LIVE_OSCAR_MICRO_MCAP_STAGED_AVG_LEG_USD = '100';
    process.env.PAPER_LIVE_STAGED_ENTRY_SECOND_LEG_USD = '300';
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
    expect(resolveLiveOscarEntrySplitLegUsd(cfg)).toBe(1000);
    expect(resolveLiveOscarEntrySplitLeg2Usd(cfg)).toBe(500);
    expect(resolveLiveOscarEntrySplitTotalUsd(cfg)).toBe(1500);
    expect(resolveLiveOscarEntrySplitLegUsd(cfg, 'micro')).toBe(300);
    expect(resolveLiveOscarEntrySplitLeg2Usd(cfg, 'micro')).toBe(200);
  });

  it('throws when low-mcap split diverges from prod split', () => {
    process.env.PAPER_LIVE_OSCAR_LOW_MCAP_ENTRY_SPLIT_LEG_USD = '200';
    const cfg = loadPaperTraderConfig();
    expect(() => assertLiveOscarUnifiedEntrySizing(cfg)).toThrow(/LOW_MCAP_ENTRY_SPLIT/);
  });

  it('throws when micro position is not leg1+leg2', () => {
    process.env.PAPER_LIVE_OSCAR_MICRO_MCAP_POSITION_USD = '600';
    const cfg = loadPaperTraderConfig();
    expect(() => assertLiveOscarUnifiedEntrySizing(cfg)).toThrow(/MICRO_MCAP_POSITION/);
  });

  it('tier-aware staged avg leg: micro $100, low/prod per fixtures', () => {
    const cfg = loadPaperTraderConfig();
    expect(resolveLiveOscarStagedAvgLegUsd(cfg, 'micro')).toBe(100);
    expect(resolveLiveOscarStagedAvgLegUsd(cfg, 'low')).toBe(300);
    expect(resolveLiveOscarStagedAvgLegUsd(cfg, 'prod')).toBe(300);
    expect(resolveLiveOscarStagedEntryMaxUsd(cfg, 'micro')).toBe(600);
    expect(resolveLiveOscarStagedEntryMaxUsd(cfg, 'low')).toBe(1800);
    expect(resolveLiveOscarStagedEntryMaxUsd(cfg, 'prod')).toBe(1800);
  });

  it('buildLiveStagedEntryState uses $100 avg leg for micro mcap', () => {
    const cfg = loadPaperTraderConfig();
    const st = buildLiveStagedEntryState(cfg, { signalTs: 1, signalPriceUsd: 0.01 }, { marketCapUsd: 800_000 });
    expect(st.avgSecondLegUsd).toBe(100);
    expect(st.secondLegUsd).toBe(100);
  });

  it('buildLiveStagedEntryState uses $300 avg leg for low mcap', () => {
    const cfg = loadPaperTraderConfig();
    const st = buildLiveStagedEntryState(cfg, { signalTs: 1, signalPriceUsd: 0.01 }, { marketCapUsd: 1_900_000 });
    expect(st.avgSecondLegUsd).toBe(300);
    expect(st.secondLegUsd).toBe(300);
  });

  it('buildLiveStagedEntryState uses $300 avg leg for prod mcap', () => {
    const cfg = loadPaperTraderConfig();
    const st = buildLiveStagedEntryState(cfg, { signalTs: 1, signalPriceUsd: 0.01 }, { marketCapUsd: 5_000_000 });
    expect(st.avgSecondLegUsd).toBe(300);
    expect(st.secondLegUsd).toBe(300);
  });

  it('buildLiveStagedEntryState uses $300+$200 split (leg-2 @ −5% re-enabled) for micro mcap', () => {
    const cfg = loadPaperTraderConfig();
    expect(cfg.liveOscarMicroMcapLaneEnabled).toBe(true);
    expect(resolveLiveOscarMcapTier(cfg, 800_000)).toBe('micro');
    expect(resolveLiveOscarTradeTierFromMcap(cfg, 800_000)).toBe('micro');
    expect(resolveLiveOscarEntrySplitLegUsd(cfg, 'micro')).toBe(300);
    expect(resolveLiveOscarEntrySplitLeg2Usd(cfg, 'micro')).toBe(200);
    const st = buildLiveStagedEntryState(cfg, { signalTs: 1, signalPriceUsd: 0.01 }, { marketCapUsd: 800_000 });
    expect(st.firstLegUsd).toBe(300);
    expect(st.entrySplitLegUsd).toBe(300);
    expect(st.entrySplitLeg2Usd).toBe(200);
    expect(st.entrySplitLeg2Done).toBe(false);
    expect(st.entrySplitDelayMs).toBe(5000);
  });

  it('buildLiveStagedEntryState uses $1000+$500 split for low mcap', () => {
    const cfg = loadPaperTraderConfig();
    const st = buildLiveStagedEntryState(cfg, { signalTs: 1, signalPriceUsd: 0.01 }, { marketCapUsd: 1_900_000 });
    expect(st.firstLegUsd).toBe(1000);
    expect(st.entrySplitLegUsd).toBe(1000);
    expect(st.entrySplitLeg2Usd).toBe(500);
  });

  it('applyCanonicalOpenLegUsd fixes pre-buy open leg after tier drift (micro)', () => {
    const cfg = loadPaperTraderConfig();
    const st = buildLiveStagedEntryState(cfg, { signalTs: 1, signalPriceUsd: 0.01 }, { marketCapUsd: 800_000 });
    st.firstLegUsd = 200;
    st.entrySplitLegUsd = 200;
    const ot: OpenTrade = {
      mint: 'mint',
      symbol: 'T',
      lane: 'post_migration',
      source: 'pumpswap',
      metricType: 'price',
      dex: 'pumpswap',
      entryTs: 1,
      entryMcUsd: 0.01,
      entryMarketCapUsd: 800_000,
      liveOscarMcapTier: 'micro',
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
    expect(ot.legs[0]!.sizeUsd).toBe(300);
    expect(ot.liveStagedEntry!.entrySplitLegUsd).toBe(300);
    expect(ot.liveStagedEntry!.entrySplitLeg2Usd).toBe(200);
    expect(ot.totalInvestedUsd).toBe(300);
  });

  it('applyCanonicalStagedEntrySizing upgrades restored plan for 2nd leg', () => {
    const cfg = loadPaperTraderConfig();
    const st = buildLiveStagedEntryState(cfg, { signalTs: 1, signalPriceUsd: 0.01 });
    st.entrySplitLegUsd = 200;
    st.entrySplitLeg2Usd = 100;
    st.entrySplitDelayMs = 10_000;
    applyCanonicalStagedEntrySizing(cfg, st);
    expect(st.entrySplitLegUsd).toBe(1000);
    expect(st.entrySplitLeg2Usd).toBe(500);
    expect(st.entrySplitDelayMs).toBe(5000);
  });
});
