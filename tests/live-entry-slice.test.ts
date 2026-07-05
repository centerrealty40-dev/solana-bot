import { describe, expect, it } from 'vitest';
import {
  entryBuySliceEligibleForOpen,
  isEntryBuySliceTierEligible,
  planEntryBuySlices,
  runSlicedSolToTokenPipeline,
  shouldRunEntryBuySlices,
} from '../src/live/entry-slice.js';
import type { LiveOscarConfig } from '../src/live/config.js';
import type { LiveBuyPipelineResult } from '../src/live/phase4-types.js';
import type { PaperTraderConfig } from '../src/papertrader/config.js';

describe('planEntryBuySlices', () => {
  it('returns single slice when notional <= max', () => {
    expect(planEntryBuySlices({ totalUsdNotional: 500, maxUsdPerSlice: 500 })).toEqual([500]);
    expect(planEntryBuySlices({ totalUsdNotional: 300, maxUsdPerSlice: 500 })).toEqual([300]);
  });

  it('splits buys into max-USD chunks', () => {
    expect(planEntryBuySlices({ totalUsdNotional: 1200, maxUsdPerSlice: 500 })).toEqual([
      500, 500, 200,
    ]);
  });
});

describe('isEntryBuySliceTierEligible', () => {
  it('allows low and prod only', () => {
    expect(isEntryBuySliceTierEligible('low')).toBe(true);
    expect(isEntryBuySliceTierEligible('prod')).toBe(true);
    expect(isEntryBuySliceTierEligible('micro')).toBe(false);
    expect(isEntryBuySliceTierEligible('below')).toBe(false);
    expect(isEntryBuySliceTierEligible(undefined)).toBe(false);
  });
});

describe('entryBuySliceEligibleForOpen', () => {
  const cfg = {
    strategyId: 'live-oscar',
    liveOscarLowMcapLaneEnabled: true,
    liveOscarLowMcapMinUsd: 2_000_000,
    liveOscarLowMcapMaxUsd: 3_000_000,
  } as PaperTraderConfig;

  it('resolves from entry mcap', () => {
    expect(entryBuySliceEligibleForOpen(cfg, { entryMarketCapUsd: 2_500_000 })).toBe(true);
    expect(entryBuySliceEligibleForOpen(cfg, { entryMarketCapUsd: 3_500_000 })).toBe(true);
    expect(entryBuySliceEligibleForOpen(cfg, { entryMarketCapUsd: 1_500_000 })).toBe(false);
  });

  it('prefers stamped tier on open trade', () => {
    expect(entryBuySliceEligibleForOpen(cfg, { liveOscarMcapTier: 'prod' })).toBe(true);
    expect(entryBuySliceEligibleForOpen(cfg, { liveOscarMcapTier: 'micro' })).toBe(false);
  });
});

describe('shouldRunEntryBuySlices', () => {
  const liveCfg = {
    liveEntrySliceMaxUsd: 500,
    liveEntrySliceDelayMs: 10_000,
  } as LiveOscarConfig;

  it('skips buy_open and ineligible tiers', () => {
    expect(
      shouldRunEntryBuySlices({
        liveCfg,
        usdNotional: 1000,
        intentKind: 'buy_open',
        entryBuySliceEligible: true,
      }),
    ).toBe(false);
    expect(
      shouldRunEntryBuySlices({
        liveCfg,
        usdNotional: 1000,
        intentKind: 'dca_add',
        entryBuySliceEligible: false,
      }),
    ).toBe(false);
  });

  it('slices dca_add when eligible and above max', () => {
    expect(
      shouldRunEntryBuySlices({
        liveCfg,
        usdNotional: 600,
        intentKind: 'dca_add',
        entryBuySliceEligible: true,
      }),
    ).toBe(true);
  });
});

describe('runSlicedSolToTokenPipeline', () => {
  const baseCfg = {
    liveEntrySliceMaxUsd: 500,
    liveEntrySliceDelayMs: 0,
  } as LiveOscarConfig;

  const args = {
    mint: 'Mint1111111111111111111111111111111111',
    symbol: 'TEST',
    usdNotional: 1200,
    intentKind: 'dca_add' as const,
    entryBuySliceEligible: true,
  };

  it('passes through when slicing disabled', async () => {
    let calls = 0;
    const runOne = async (): Promise<LiveBuyPipelineResult> => {
      calls += 1;
      return { ok: true, anchorMode: 'simulate', executedUsdNotional: 1200 };
    };
    const r = await runSlicedSolToTokenPipeline(
      { ...baseCfg, liveEntrySliceMaxUsd: 0 },
      args,
      runOne,
    );
    expect(r.ok).toBe(true);
    expect(calls).toBe(1);
  });

  it('runs multiple slices and aggregates executed USD', async () => {
    const notionals: number[] = [];
    const runOne = async (
      _cfg: LiveOscarConfig,
      a: { usdNotional: number },
    ): Promise<LiveBuyPipelineResult> => {
      const idx = notionals.length;
      notionals.push(a.usdNotional);
      return {
        ok: true,
        anchorMode: 'chain',
        executedUsdNotional: a.usdNotional,
        confirmedBuyTxSignature: `sig-${idx}`,
      };
    };
    const r = await runSlicedSolToTokenPipeline(baseCfg, args, runOne);
    expect(r.ok).toBe(true);
    expect(notionals).toEqual([500, 500, 200]);
    expect(r.executedUsdNotional).toBe(1200);
    expect(r.confirmedBuyTxSignatures).toEqual(['sig-0', 'sig-1', 'sig-2']);
  });
});
