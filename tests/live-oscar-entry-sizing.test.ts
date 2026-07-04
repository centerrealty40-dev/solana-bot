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
  resolveLiveOscarEntrySplitLeg8Usd,
  resolveLiveOscarEntrySplitLegUsd,
  resolveLiveOscarEntrySplitTotalUsd,
  resolveLiveOscarProdMcapBand,
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
      'PAPER_LIVE_STAGED_ENTRY_ENTRY_SPLIT_LEG8_USD',
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
      'PAPER_LIVE_OSCAR_LOW_MCAP_ENTRY_SPLIT_LEG4_USD',
      'PAPER_LIVE_OSCAR_LOW_MCAP_ENTRY_SPLIT_LEG5_USD',
      'PAPER_LIVE_OSCAR_LOW_MCAP_POSITION_USD',
      'PAPER_LIVE_OSCAR_LOW_MCAP_STAGED_AVG_LEG_USD',
      'PAPER_LIVE_OSCAR_LOW_MCAP_STAGED_AVG_DROP_PCT',
      'PAPER_LIVE_OSCAR_LOW_MCAP_STAGED_AVG_SECOND_LEG_USD',
      'PAPER_LIVE_OSCAR_LOW_MCAP_STAGED_AVG_SECOND_DROP_PCT',
      'PAPER_LIVE_OSCAR_MICRO_MCAP_LANE_ENABLED',
      'PAPER_LIVE_OSCAR_MICRO_MCAP_ENTRY_SPLIT_LEG_USD',
      'PAPER_LIVE_OSCAR_MICRO_MCAP_ENTRY_SPLIT_LEG2_USD',
      'PAPER_LIVE_OSCAR_MICRO_MCAP_POSITION_USD',
      'PAPER_LIVE_OSCAR_MICRO_MCAP_STAGED_AVG_LEG_USD',
      'PAPER_LIVE_OSCAR_MICRO_MCAP_STAGED_AVG_DROP_PCT',
      'PAPER_LIVE_OSCAR_PROD_MCAP_BAND_12M_USD',
      'PAPER_LIVE_OSCAR_PROD_MCAP_MAX_3_12_USD',
      'PAPER_LIVE_OSCAR_PROD_MCAP_MAX_12_PLUS_USD',
      'PAPER_LIVE_STAGED_ENTRY_ENTRY_SPLIT_DELAY_MS',
    ];
    for (const k of keys) envBackup[k] = process.env[k];
    process.env.PAPER_STRATEGY_ID = 'live-oscar';
    process.env.PAPER_LIVE_STAGED_ENTRY_ENABLED = '1';
    process.env.PAPER_LIVE_STAGED_ENTRY_ENTRY_SPLIT_LEG_USD = '1000';
    process.env.PAPER_LIVE_STAGED_ENTRY_ENTRY_SPLIT_LEG2_USD = '1000';
    process.env.PAPER_LIVE_STAGED_ENTRY_ENTRY_SPLIT_LEG3_USD = '1000';
    process.env.PAPER_LIVE_STAGED_ENTRY_ENTRY_SPLIT_LEG4_USD = '1000';
    process.env.PAPER_LIVE_STAGED_ENTRY_ENTRY_SPLIT_LEG5_USD = '1000';
    process.env.PAPER_LIVE_STAGED_ENTRY_ENTRY_SPLIT_LEG6_USD = '0';
    process.env.PAPER_LIVE_STAGED_ENTRY_ENTRY_SPLIT_LEG7_USD = '0';
    process.env.PAPER_LIVE_STAGED_ENTRY_ENTRY_SPLIT_LEG8_USD = '0';
    process.env.PAPER_LIVE_STAGED_ENTRY_FIRST_LEG_USD = '1000';
    process.env.PAPER_POSITION_USD = '5000';
    process.env.PAPER_LIVE_STAGED_ENTRY_SECOND_LEG_USD = '300';
    process.env.PAPER_LIVE_STAGED_ENTRY_SECOND_DROP_PCT = '10';
    process.env.PAPER_LIVE_STAGED_ENTRY_THIRD_LEG_USD = '400';
    process.env.PAPER_LIVE_STAGED_ENTRY_THIRD_DROP_PCT = '20';
    process.env.PAPER_LIVE_OSCAR_MICRO_MCAP_LANE_ENABLED = '0';
    process.env.PAPER_LIVE_OSCAR_LOW_MCAP_LANE_ENABLED = '1';
    process.env.PAPER_LIVE_OSCAR_LOW_MCAP_MIN_USD = '2000000';
    process.env.PAPER_LIVE_OSCAR_LOW_MCAP_MAX_USD = '3000000';
    process.env.PAPER_LIVE_OSCAR_LOW_MCAP_ENTRY_SPLIT_LEG_USD = '300';
    process.env.PAPER_LIVE_OSCAR_LOW_MCAP_ENTRY_SPLIT_LEG2_USD = '300';
    process.env.PAPER_LIVE_OSCAR_LOW_MCAP_ENTRY_SPLIT_LEG3_USD = '300';
    process.env.PAPER_LIVE_OSCAR_LOW_MCAP_ENTRY_SPLIT_LEG4_USD = '300';
    process.env.PAPER_LIVE_OSCAR_LOW_MCAP_ENTRY_SPLIT_LEG5_USD = '300';
    process.env.PAPER_LIVE_OSCAR_LOW_MCAP_POSITION_USD = '1500';
    process.env.PAPER_LIVE_OSCAR_LOW_MCAP_STAGED_AVG_LEG_USD = '300';
    process.env.PAPER_LIVE_OSCAR_LOW_MCAP_STAGED_AVG_DROP_PCT = '10';
    process.env.PAPER_LIVE_OSCAR_LOW_MCAP_STAGED_AVG_SECOND_LEG_USD = '400';
    process.env.PAPER_LIVE_OSCAR_LOW_MCAP_STAGED_AVG_SECOND_DROP_PCT = '20';
    process.env.PAPER_LIVE_OSCAR_MICRO_MCAP_LANE_ENABLED = '0';
    process.env.PAPER_LIVE_OSCAR_MICRO_MCAP_ENTRY_SPLIT_LEG_USD = '150';
    process.env.PAPER_LIVE_OSCAR_MICRO_MCAP_ENTRY_SPLIT_LEG2_USD = '150';
    process.env.PAPER_LIVE_OSCAR_MICRO_MCAP_POSITION_USD = '300';
    process.env.PAPER_LIVE_OSCAR_MICRO_MCAP_STAGED_AVG_LEG_USD = '210';
    process.env.PAPER_LIVE_OSCAR_MICRO_MCAP_STAGED_AVG_DROP_PCT = '10';
    process.env.PAPER_LIVE_OSCAR_PROD_MCAP_BAND_12M_USD = '12000000';
    process.env.PAPER_LIVE_OSCAR_PROD_MCAP_MAX_3_12_USD = '5700';
    process.env.PAPER_LIVE_OSCAR_PROD_MCAP_MAX_12_PLUS_USD = '5700';
    process.env.PAPER_LIVE_STAGED_ENTRY_ENTRY_SPLIT_DELAY_MS = '10000';
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
    expect(resolveLiveOscarEntrySplitLegUsd(cfg, 'prod')).toBe(1000);
    expect(resolveLiveOscarEntrySplitLeg2Usd(cfg, 'prod')).toBe(1000);
    expect(resolveLiveOscarEntrySplitLeg3Usd(cfg, 'prod')).toBe(1000);
    expect(resolveLiveOscarEntrySplitLeg4Usd(cfg, 'prod')).toBe(1000);
    expect(resolveLiveOscarEntrySplitLeg5Usd(cfg, 'prod')).toBe(1000);
    expect(resolveLiveOscarEntrySplitLeg6Usd(cfg, 'prod')).toBe(0);
    expect(resolveLiveOscarEntrySplitLeg7Usd(cfg, 'prod')).toBe(0);
    expect(resolveLiveOscarEntrySplitLeg8Usd(cfg, 'prod')).toBe(0);
    expect(resolveLiveOscarEntrySplitTotalUsd(cfg, 'prod')).toBe(5000);
    expect(resolveLiveOscarEntrySplitLegUsd(cfg, 'low')).toBe(300);
    expect(resolveLiveOscarEntrySplitLeg2Usd(cfg, 'low')).toBe(300);
    expect(resolveLiveOscarEntrySplitLeg3Usd(cfg, 'low')).toBe(300);
    expect(resolveLiveOscarEntrySplitLeg4Usd(cfg, 'low')).toBe(300);
    expect(resolveLiveOscarEntrySplitLeg5Usd(cfg, 'low')).toBe(300);
    expect(resolveLiveOscarEntrySplitTotalUsd(cfg, 'low')).toBe(1500);
  });

  it('throws when low-mcap position is not leg1..leg5 sum', () => {
    process.env.PAPER_LIVE_OSCAR_LOW_MCAP_POSITION_USD = '1400';
    const cfg = loadPaperTraderConfig();
    expect(() => assertLiveOscarUnifiedEntrySizing(cfg)).toThrow(/LOW_MCAP_POSITION/);
  });

  it('tier-aware staged avg: low −10%/$300 + −20%/$400; prod −10%/$300 + −20%/$400; micro −10% $210', () => {
    const cfg = loadPaperTraderConfig();
    expect(resolveLiveOscarStagedAvgFirstDropPct(cfg, 'low')).toBe(10);
    expect(resolveLiveOscarStagedAvgLegUsd(cfg, 'low')).toBe(300);
    expect(resolveLiveOscarStagedAvgSecondLegUsd(cfg, 'low')).toBe(400);
    expect(resolveLiveOscarStagedAvgFirstDropPct(cfg, 'prod')).toBe(10);
    expect(resolveLiveOscarStagedAvgLegUsd(cfg, 'prod')).toBe(300);
    expect(resolveLiveOscarStagedAvgSecondLegUsd(cfg, 'prod')).toBe(400);
    expect(resolveLiveOscarStagedAvgFirstDropPct(cfg, 'micro')).toBe(10);
    expect(resolveLiveOscarStagedAvgLegUsd(cfg, 'micro')).toBe(210);
    expect(resolveLiveOscarStagedEntryMaxUsd(cfg, 'low')).toBe(2200);
    expect(resolveLiveOscarStagedEntryMaxUsd(cfg, 'prod')).toBe(5700);
    expect(resolveLiveOscarStagedEntryMaxUsd(cfg, 'micro')).toBe(510);
  });

  it('buildLiveStagedEntryState uses $300/$400 avg @ −10%/−20% for low mcap', () => {
    const cfg = loadPaperTraderConfig();
    const st = buildLiveStagedEntryState(cfg, { signalTs: 1, signalPriceUsd: 0.01 }, { marketCapUsd: 2_500_000 });
    expect(st.avgSecondLegUsd).toBe(300);
    expect(st.avgSecondDropPct).toBe(10);
    expect(st.avgThirdLegUsd).toBe(400);
    expect(st.avgThirdDropPct).toBe(20);
    expect(st.entrySplitLeg5Usd).toBe(300);
    expect(st.entrySplitLeg5Done).toBe(false);
  });

  it('buildLiveStagedEntryState uses 5×$1000 split + prod avg for prod mcap $3–12M', () => {
    const cfg = loadPaperTraderConfig();
    const st = buildLiveStagedEntryState(cfg, { signalTs: 1, signalPriceUsd: 0.01 }, { marketCapUsd: 4_000_000 });
    expect(st.entrySplitLegUsd).toBe(1000);
    expect(st.entrySplitLeg5Usd).toBe(1000);
    expect(st.entrySplitLeg5Done).toBe(false);
    expect(st.entrySplitLeg6Usd).toBe(0);
    expect(st.entrySplitLeg6Done).toBe(true);
    expect(st.avgSecondLegUsd).toBe(300);
    expect(st.avgThirdLegUsd).toBe(400);
    expect(resolveLiveOscarStagedEntryMaxUsd(cfg, 'prod', 4_000_000)).toBe(5700);
  });

  it('prod mcap bands: $3–12M and ≥$12M both $5700 with avg legs', () => {
    const cfg = loadPaperTraderConfig();
    expect(resolveLiveOscarProdMcapBand(cfg, 4_000_000)).toBe('3_12');
    expect(resolveLiveOscarProdMcapBand(cfg, 6_000_000)).toBe('3_12');
    expect(resolveLiveOscarProdMcapBand(cfg, 10_000_000)).toBe('3_12');
    expect(resolveLiveOscarProdMcapBand(cfg, 15_000_000)).toBe('12_plus');

    expect(resolveLiveOscarStagedEntryMaxUsd(cfg, 'prod', 4_000_000)).toBe(5700);
    expect(resolveLiveOscarStagedEntryMaxUsd(cfg, 'prod', 6_000_000)).toBe(5700);
    expect(resolveLiveOscarStagedEntryMaxUsd(cfg, 'prod', 10_000_000)).toBe(5700);
    expect(resolveLiveOscarStagedEntryMaxUsd(cfg, 'prod', 15_000_000)).toBe(5700);

    const st6m = buildLiveStagedEntryState(cfg, { signalTs: 1, signalPriceUsd: 0.01 }, { marketCapUsd: 6_000_000 });
    expect(st6m.avgSecondLegUsd).toBe(300);
    expect(st6m.avgThirdLegUsd).toBe(400);
    expect(resolveLiveOscarEntrySplitTotalUsd(cfg, 'prod', 6_000_000)).toBe(5000);

    const st10m = buildLiveStagedEntryState(cfg, { signalTs: 1, signalPriceUsd: 0.01 }, { marketCapUsd: 10_000_000 });
    expect(st10m.avgSecondLegUsd).toBe(300);
    expect(st10m.avgThirdLegUsd).toBe(400);
    expect(resolveLiveOscarEntrySplitLeg5Usd(cfg, 'prod', 10_000_000)).toBe(1000);
    expect(resolveLiveOscarEntrySplitLeg8Usd(cfg, 'prod', 10_000_000)).toBe(0);

    const st12 = buildLiveStagedEntryState(cfg, { signalTs: 1, signalPriceUsd: 0.01 }, { marketCapUsd: 15_000_000 });
    expect(st12.avgSecondLegUsd).toBe(300);
    expect(st12.avgThirdLegUsd).toBe(400);
    expect(resolveLiveOscarEntrySplitLeg8Usd(cfg, 'prod', 15_000_000)).toBe(0);
    expect(resolveLiveOscarEntrySplitTotalUsd(cfg, 'prod', 15_000_000)).toBe(5000);
  });

  it('buildLiveStagedEntryState uses full $5700 plan at $12M boundary ($3–12M band)', () => {
    const cfg = loadPaperTraderConfig();
    expect(resolveLiveOscarProdMcapBand(cfg, 12_000_000)).toBe('12_plus');
    expect(resolveLiveOscarProdMcapBand(cfg, 11_999_999)).toBe('3_12');
    const st = buildLiveStagedEntryState(cfg, { signalTs: 1, signalPriceUsd: 0.01 }, { marketCapUsd: 5_000_000 });
    expect(st.entrySplitLegUsd).toBe(1000);
    expect(st.entrySplitLeg5Usd).toBe(1000);
    expect(st.entrySplitLeg5Done).toBe(false);
    expect(st.avgSecondLegUsd).toBe(300);
    expect(st.avgSecondDropPct).toBe(10);
    expect(st.avgThirdLegUsd).toBe(400);
    expect(st.avgThirdDropPct).toBe(20);
    expect(st.entrySplitDelayMs).toBe(10000);
    expect(resolveLiveOscarStagedEntryMaxUsd(cfg, 'prod', 5_000_000)).toBe(5700);
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
    expect(ot.legs[0]!.sizeUsd).toBe(300);
    expect(ot.liveStagedEntry!.entrySplitLegUsd).toBe(300);
    expect(ot.totalInvestedUsd).toBe(300);
  });

  it('applyCanonicalStagedEntrySizing upgrades restored plan', () => {
    const cfg = loadPaperTraderConfig();
    const st = buildLiveStagedEntryState(cfg, { signalTs: 1, signalPriceUsd: 0.01 });
    st.entrySplitLegUsd = 200;
    st.entrySplitLeg2Usd = 100;
    st.entrySplitDelayMs = 5000;
    applyCanonicalStagedEntrySizing(cfg, st);
    expect(st.entrySplitLegUsd).toBe(1000);
    expect(st.entrySplitLeg2Usd).toBe(1000);
    expect(st.entrySplitLeg3Usd).toBe(1000);
    expect(st.entrySplitLeg4Usd).toBe(1000);
    expect(st.entrySplitLeg5Usd).toBe(1000);
    expect(st.entrySplitLeg6Usd).toBe(0);
    expect(st.entrySplitLeg7Usd).toBe(0);
    expect(st.entrySplitLeg8Usd).toBe(0);
    expect(st.entrySplitDelayMs).toBe(10000);
  });
});
