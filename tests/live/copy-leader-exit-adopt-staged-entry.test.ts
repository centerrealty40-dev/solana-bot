import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  adoptCopyLeaderExitOpens,
  attachCopyLeaderDiscoveryStagedEntryTopUp,
  resolveCopyLeaderAdoptTier,
} from '../../src/live/copy-leader-exit-adopt.js';
import { entrySplitLegDoneFromState } from '../../src/papertrader/entry-split-legs.js';
import {
  resolveLiveOscarEntrySplitLeg3Usd,
  resolveLiveOscarEntrySplitLegUsd,
} from '../../src/papertrader/live-oscar-entry-sizing.js';
import { loadPaperTraderConfig } from '../../src/papertrader/config.js';
import type { OpenTrade } from '../../src/papertrader/types.js';

describe('copy-leader exit adopt sizing', () => {
  const tmpFiles: string[] = [];
  const envBackup: Record<string, string | undefined> = {};

  afterEach(() => {
    for (const [k, v] of Object.entries(envBackup)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    for (const f of tmpFiles) {
      try {
        fs.unlinkSync(f);
      } catch {
        // ignore
      }
    }
  });

  function saveEnv(key: string): void {
    if (!(key in envBackup)) envBackup[key] = process.env[key];
  }

  function mockResolveMcap(mcapUsd: number | null) {
    return async () => mcapUsd;
  }

  function stagedEntryPaperCfg() {
    for (const key of [
      'PAPER_STRATEGY_ID',
      'PAPER_LIVE_STAGED_ENTRY_ENABLED',
      'PAPER_LIVE_STAGED_ENTRY_ENTRY_SPLIT_LEG_USD',
      'PAPER_LIVE_STAGED_ENTRY_ENTRY_SPLIT_LEG2_USD',
      'PAPER_LIVE_STAGED_ENTRY_ENTRY_SPLIT_LEG3_USD',
      'PAPER_LIVE_STAGED_ENTRY_ENTRY_SPLIT_LEG4_USD',
      'PAPER_LIVE_STAGED_ENTRY_ENTRY_SPLIT_LEG5_USD',
      'PAPER_LIVE_STAGED_ENTRY_ENTRY_SPLIT_LEG6_USD',
      'PAPER_LIVE_STAGED_ENTRY_SECOND_LEG_USD',
      'PAPER_LIVE_STAGED_ENTRY_SECOND_DROP_PCT',
      'PAPER_LIVE_STAGED_ENTRY_THIRD_LEG_USD',
      'PAPER_LIVE_STAGED_ENTRY_THIRD_DROP_PCT',
    ]) {
      saveEnv(key);
    }
    process.env.PAPER_STRATEGY_ID = 'live-oscar';
    process.env.PAPER_LIVE_STAGED_ENTRY_ENABLED = '1';
    process.env.PAPER_LIVE_STAGED_ENTRY_ENTRY_SPLIT_LEG_USD = '1000';
    process.env.PAPER_LIVE_STAGED_ENTRY_ENTRY_SPLIT_LEG2_USD = '1000';
    process.env.PAPER_LIVE_STAGED_ENTRY_ENTRY_SPLIT_LEG3_USD = '1000';
    process.env.PAPER_LIVE_STAGED_ENTRY_ENTRY_SPLIT_LEG4_USD = '0';
    process.env.PAPER_LIVE_STAGED_ENTRY_ENTRY_SPLIT_LEG5_USD = '0';
    process.env.PAPER_LIVE_STAGED_ENTRY_ENTRY_SPLIT_LEG6_USD = '0';
    process.env.PAPER_LIVE_STAGED_ENTRY_SECOND_LEG_USD = '1000';
    process.env.PAPER_LIVE_STAGED_ENTRY_SECOND_DROP_PCT = '10';
    process.env.PAPER_LIVE_STAGED_ENTRY_THIRD_LEG_USD = '1000';
    process.env.PAPER_LIVE_STAGED_ENTRY_THIRD_DROP_PCT = '20';
    return loadPaperTraderConfig();
  }

  function writeCopyState(args: {
    mint: string;
    promotedAt: number;
    entryPriceUsd: number;
    entryMcapUsd?: number;
    costBasisUsd?: number;
  }): string {
    const fp = path.join(os.tmpdir(), `ct-staged-${Date.now()}-${Math.random()}.json`);
    fs.writeFileSync(
      fp,
      JSON.stringify({
        positions: {
          [args.mint]: {
            mint: args.mint,
            symbol: 'STG',
            entryTs: args.promotedAt - 60_000,
            entryPriceUsd: args.entryPriceUsd,
            entryMcapUsd: args.entryMcapUsd,
            sizeUsd: args.costBasisUsd ?? 1000,
            entryDeployedCostUsd: args.costBasisUsd ?? 1000,
            positionSource: 'copy_leader',
            oscarPromotedAt: args.promotedAt,
          },
        },
      }),
      'utf8',
    );
    tmpFiles.push(fp);
    return fp;
  }

  it('adopts copy half only without liveStagedEntry plan', async () => {
    const mint = 'MintCopyStaged111111111111111111111111111111';
    const promotedAt = Date.now() - 120_000;
    const entryPriceUsd = 0.0042;
    const statePath = writeCopyState({
      mint,
      promotedAt,
      entryPriceUsd,
      entryMcapUsd: 5_000_000,
      costBasisUsd: 1000,
    });
    const paperCfg = stagedEntryPaperCfg();
    const open = new Map<string, OpenTrade>();

    const r = await adoptCopyLeaderExitOpens({
      open,
      paperCfg,
      statePath,
      resolveMcapUsd: mockResolveMcap(5_000_000),
    });
    expect(r.adopted).toEqual([mint]);

    const ot = open.get(mint)!;
    expect(ot.entryMarketCapUsd).toBe(5_000_000);
    expect(ot.liveOscarMcapTier).toBe('prod');
    expect(ot.copyToOscarPromoted).toBe(true);
    expect(ot.totalInvestedUsd).toBe(1000);
    expect(ot.liveStagedEntry).toBeUndefined();
  });

  it('attachCopyLeaderDiscoveryStagedEntryTopUp schedules pending split legs', () => {
    const mint = 'MintCopyDiscovery111111111111111111111111111';
    const promotedAt = Date.now() - 120_000;
    const entryPriceUsd = 0.0042;
    const paperCfg = stagedEntryPaperCfg();
    const ot: OpenTrade = {
      mint,
      symbol: 'DISC',
      lane: 'post_migration',
      metricType: 'price',
      dex: 'raydium',
      entryTs: promotedAt - 60_000,
      entryMcUsd: entryPriceUsd,
      entryMarketCapUsd: 5_000_000,
      entryMetrics: {
        uniqueBuyers: 0,
        uniqueSellers: 0,
        sumBuySol: 0,
        sumSellSol: 0,
        topBuyerShare: 0,
        bcProgress: 0,
      },
      peakMcUsd: entryPriceUsd,
      peakPnlPct: 0,
      trailingArmed: false,
      legs: [
        {
          ts: promotedAt - 60_000,
          price: entryPriceUsd,
          marketPrice: entryPriceUsd,
          sizeUsd: 1000,
          reason: 'open',
        },
      ],
      partialSells: [],
      totalInvestedUsd: 1000,
      avgEntry: entryPriceUsd,
      avgEntryMarket: entryPriceUsd,
      remainingFraction: 1,
      dcaUsedLevels: new Set(),
      dcaUsedIndices: new Set(),
      ladderUsedLevels: new Set(),
      ladderUsedIndices: new Set(),
      pairAddress: null,
      entryLiqUsd: null,
      copyToOscarPromoted: true,
      liveOscarMcapTier: 'prod',
    };

    const attached = attachCopyLeaderDiscoveryStagedEntryTopUp(ot, {
      paperCfg,
      entryTs: Date.now() - 30_000,
      entryPriceUsd: 0.0045,
      entryMcapUsd: 5_000_000,
      tradeTier: 'prod',
    });
    expect(attached).toBe(true);

    const st = ot.liveStagedEntry!;
    expect(st.signalPriceUsd).toBe(0.0045);
    expect(entrySplitLegDoneFromState(st, 1)).toBe(true);
    expect(st.entrySplitLeg2Done).toBe(false);
    expect(st.avgSecondLegUsd).toBe(1000);
    expect(st.avgThirdLegUsd).toBe(1000);
    expect(st.avgFirstLegDone).toBe(false);
    expect(ot.totalInvestedUsd).toBe(1000);
  });

  it('uses low-tier avg sizing from entry mcap on discovery top-up', () => {
    for (const key of [
      'PAPER_LIVE_OSCAR_LOW_MCAP_LANE_ENABLED',
      'PAPER_LIVE_OSCAR_LOW_MCAP_MIN_USD',
      'PAPER_LIVE_OSCAR_LOW_MCAP_MAX_USD',
      'PAPER_LIVE_OSCAR_LOW_MCAP_STAGED_AVG_LEG_USD',
      'PAPER_LIVE_OSCAR_LOW_MCAP_STAGED_AVG_SECOND_LEG_USD',
    ]) {
      saveEnv(key);
    }
    process.env.PAPER_LIVE_OSCAR_LOW_MCAP_LANE_ENABLED = '1';
    process.env.PAPER_LIVE_OSCAR_LOW_MCAP_MIN_USD = '2000000';
    process.env.PAPER_LIVE_OSCAR_LOW_MCAP_MAX_USD = '3000000';
    process.env.PAPER_LIVE_OSCAR_LOW_MCAP_STAGED_AVG_LEG_USD = '500';
    process.env.PAPER_LIVE_OSCAR_LOW_MCAP_STAGED_AVG_SECOND_LEG_USD = '500';

    const paperCfg = stagedEntryPaperCfg();
    const ot: OpenTrade = {
      mint: 'MintCopyLowStg1111111111111111111111111111111',
      symbol: 'LOW',
      lane: 'post_migration',
      metricType: 'price',
      dex: 'raydium',
      entryTs: Date.now() - 90_000,
      entryMcUsd: 0.002,
      entryMarketCapUsd: 2_500_000,
      entryMetrics: {
        uniqueBuyers: 0,
        uniqueSellers: 0,
        sumBuySol: 0,
        sumSellSol: 0,
        topBuyerShare: 0,
        bcProgress: 0,
      },
      peakMcUsd: 0.002,
      peakPnlPct: 0,
      trailingArmed: false,
      legs: [
        {
          ts: Date.now() - 90_000,
          price: 0.002,
          marketPrice: 0.002,
          sizeUsd: 500,
          reason: 'open',
        },
      ],
      partialSells: [],
      totalInvestedUsd: 500,
      avgEntry: 0.002,
      avgEntryMarket: 0.002,
      remainingFraction: 1,
      dcaUsedLevels: new Set(),
      dcaUsedIndices: new Set(),
      ladderUsedLevels: new Set(),
      ladderUsedIndices: new Set(),
      pairAddress: null,
      entryLiqUsd: null,
      copyToOscarPromoted: true,
    };

    attachCopyLeaderDiscoveryStagedEntryTopUp(ot, {
      paperCfg,
      entryTs: Date.now() - 60_000,
      entryPriceUsd: 0.002,
      entryMcapUsd: 2_500_000,
      tradeTier: 'low',
    });

    expect(ot.liveOscarMcapTier).toBe('low');
    expect(ot.liveStagedEntry!.avgSecondLegUsd).toBe(500);
    expect(ot.liveStagedEntry!.avgThirdLegUsd).toBe(500);
  });

  it('blocks adopt when mcap is below discovery threshold', async () => {
    for (const key of ['PAPER_DISCOVERY_MIN_MARKET_CAP_USD', 'PAPER_LIVE_OSCAR_LOW_MCAP_LANE_ENABLED']) {
      saveEnv(key);
    }
    process.env.PAPER_DISCOVERY_MIN_MARKET_CAP_USD = '2000000';
    process.env.PAPER_LIVE_OSCAR_LOW_MCAP_LANE_ENABLED = '0';

    const mint = 'MintCopyBelow1111111111111111111111111111111';
    const statePath = writeCopyState({
      mint,
      promotedAt: Date.now() - 60_000,
      entryPriceUsd: 0.001,
      entryMcapUsd: 1_500_000,
      costBasisUsd: 500,
    });
    const paperCfg = stagedEntryPaperCfg();
    const open = new Map<string, OpenTrade>();

    const r = await adoptCopyLeaderExitOpens({
      open,
      paperCfg,
      statePath,
      resolveMcapUsd: mockResolveMcap(1_500_000),
    });

    expect(r.adopted).toEqual([]);
    expect(r.skippedBelowMcap).toEqual([mint]);
    expect(open.has(mint)).toBe(false);
  });

  it('does not enable prod split legs for sub-prod mcap without tier', () => {
    for (const key of ['PAPER_DISCOVERY_MIN_MARKET_CAP_USD', 'PAPER_LIVE_OSCAR_LOW_MCAP_LANE_ENABLED']) {
      saveEnv(key);
    }
    process.env.PAPER_DISCOVERY_MIN_MARKET_CAP_USD = '2000000';
    process.env.PAPER_LIVE_OSCAR_LOW_MCAP_LANE_ENABLED = '0';

    const cfg = stagedEntryPaperCfg();
    expect(resolveLiveOscarEntrySplitLegUsd(cfg, undefined, 1_500_000)).toBe(0);
    expect(resolveLiveOscarEntrySplitLeg3Usd(cfg, undefined, 1_500_000)).toBe(0);
  });

  it('resolveCopyLeaderAdoptTier blocks unknown mcap', () => {
    const cfg = stagedEntryPaperCfg();
    const r = resolveCopyLeaderAdoptTier(cfg, null);
    expect(r.adoptBlocked).toBe(true);
    expect(r.blockReason).toBe('mcap_unknown');
  });

  it('skips adopt when open already exists (no retro staged entry)', async () => {
    const mint = 'MintCopyRetroStg111111111111111111111111111111';
    const promotedAt = Date.now() - 60_000;
    const entryPriceUsd = 0.0033;
    const statePath = writeCopyState({
      mint,
      promotedAt,
      entryPriceUsd,
      entryMcapUsd: 6_000_000,
      costBasisUsd: 1000,
    });
    const paperCfg = stagedEntryPaperCfg();
    const open = new Map<string, OpenTrade>();
    open.set(mint, {
      mint,
      symbol: 'RETRO',
      lane: 'post_migration',
      metricType: 'price',
      dex: 'raydium',
      entryTs: promotedAt - 60_000,
      entryMcUsd: entryPriceUsd,
      entryMarketCapUsd: null,
      entryMetrics: {
        uniqueBuyers: 0,
        uniqueSellers: 0,
        sumBuySol: 0,
        sumSellSol: 0,
        topBuyerShare: 0,
        bcProgress: 0,
      },
      peakMcUsd: entryPriceUsd,
      peakPnlPct: 0,
      trailingArmed: false,
      legs: [
        {
          ts: promotedAt - 60_000,
          price: entryPriceUsd,
          marketPrice: entryPriceUsd,
          sizeUsd: 1000,
          reason: 'open',
        },
      ],
      partialSells: [],
      totalInvestedUsd: 1000,
      avgEntry: entryPriceUsd,
      avgEntryMarket: entryPriceUsd,
      remainingFraction: 1,
      dcaUsedLevels: new Set(),
      dcaUsedIndices: new Set(),
      ladderUsedLevels: new Set(),
      ladderUsedIndices: new Set(),
      pairAddress: null,
      entryLiqUsd: null,
      copyToOscarPromoted: true,
      liveExitPolicyId: 'wave_b_v1',
      liveWaveFlatTpMode: 'half8_runner',
    });

    const r = await adoptCopyLeaderExitOpens({
      open,
      paperCfg,
      statePath,
      resolveMcapUsd: mockResolveMcap(6_000_000),
    });

    expect(r.adopted).toEqual([]);
    expect(r.skippedAlreadyOpen).toEqual([mint]);
    expect(open.get(mint)!.liveStagedEntry).toBeUndefined();
  });
});
