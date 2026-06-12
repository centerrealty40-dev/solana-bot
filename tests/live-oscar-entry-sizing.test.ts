import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadPaperTraderConfig } from '../src/papertrader/config.js';
import {
  applyCanonicalOpenLegUsd,
  applyCanonicalStagedEntrySizing,
  assertLiveOscarUnifiedEntrySizing,
  resolveLiveOscarEntrySplitLegUsd,
} from '../src/papertrader/live-oscar-entry-sizing.js';
import { buildLiveStagedEntryState } from '../src/papertrader/executor/live-staged-entry-gates.js';
import type { OpenTrade } from '../src/papertrader/types.js';

describe('live-oscar-entry-sizing', () => {
  const envBackup: Record<string, string | undefined> = {};

  beforeEach(() => {
    const keys = [
      'PAPER_STRATEGY_ID',
      'PAPER_LIVE_STAGED_ENTRY_ENABLED',
      'PAPER_LIVE_STAGED_ENTRY_ENTRY_SPLIT_LEG_USD',
      'PAPER_LIVE_STAGED_ENTRY_FIRST_LEG_USD',
      'PAPER_POSITION_USD',
      'PAPER_LIVE_OSCAR_LOW_MCAP_LANE_ENABLED',
      'PAPER_LIVE_OSCAR_LOW_MCAP_ENTRY_SPLIT_LEG_USD',
      'PAPER_LIVE_OSCAR_LOW_MCAP_POSITION_USD',
      'PAPER_LIVE_STAGED_ENTRY_ENTRY_SPLIT_DELAY_MS',
    ];
    for (const k of keys) envBackup[k] = process.env[k];
    process.env.PAPER_STRATEGY_ID = 'live-oscar';
    process.env.PAPER_LIVE_STAGED_ENTRY_ENABLED = '1';
    process.env.PAPER_LIVE_STAGED_ENTRY_ENTRY_SPLIT_LEG_USD = '730';
    process.env.PAPER_LIVE_STAGED_ENTRY_FIRST_LEG_USD = '730';
    process.env.PAPER_POSITION_USD = '1460';
    process.env.PAPER_LIVE_OSCAR_LOW_MCAP_LANE_ENABLED = '1';
    process.env.PAPER_LIVE_OSCAR_LOW_MCAP_ENTRY_SPLIT_LEG_USD = '730';
    process.env.PAPER_LIVE_OSCAR_LOW_MCAP_POSITION_USD = '1460';
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
    expect(resolveLiveOscarEntrySplitLegUsd(cfg)).toBe(730);
  });

  it('throws when low-mcap split diverges from prod split', () => {
    process.env.PAPER_LIVE_OSCAR_LOW_MCAP_ENTRY_SPLIT_LEG_USD = '200';
    const cfg = loadPaperTraderConfig();
    expect(() => assertLiveOscarUnifiedEntrySizing(cfg)).toThrow(/LOW_MCAP_ENTRY_SPLIT/);
  });

  it('buildLiveStagedEntryState uses canonical split for low mcap', () => {
    const cfg = loadPaperTraderConfig();
    const st = buildLiveStagedEntryState(cfg, { signalTs: 1, signalPriceUsd: 0.01 }, { marketCapUsd: 1_900_000 });
    expect(st.firstLegUsd).toBe(730);
    expect(st.entrySplitLegUsd).toBe(730);
    expect(st.entrySplitDelayMs).toBe(5000);
  });

  it('applyCanonicalOpenLegUsd fixes pre-buy open leg after tier drift', () => {
    const cfg = loadPaperTraderConfig();
    const st = buildLiveStagedEntryState(cfg, { signalTs: 1, signalPriceUsd: 0.01 }, { marketCapUsd: 1_900_000 });
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
      entryMarketCapUsd: 1_900_000,
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
    expect(ot.legs[0]!.sizeUsd).toBe(730);
    expect(ot.liveStagedEntry!.entrySplitLegUsd).toBe(730);
    expect(ot.totalInvestedUsd).toBe(730);
  });

  it('applyCanonicalStagedEntrySizing upgrades restored plan for 2nd leg', () => {
    const cfg = loadPaperTraderConfig();
    const st = buildLiveStagedEntryState(cfg, { signalTs: 1, signalPriceUsd: 0.01 });
    st.entrySplitLegUsd = 200;
    st.entrySplitDelayMs = 10_000;
    applyCanonicalStagedEntrySizing(cfg, st);
    expect(st.entrySplitLegUsd).toBe(730);
    expect(st.entrySplitDelayMs).toBe(5000);
  });
});
