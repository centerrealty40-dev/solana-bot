import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  adoptCopyLeaderExitOpens,
  attachCopyLeaderDiscoveryStagedEntryTopUp,
  reconcileCopyLeaderAdoptStagedEntryPlans,
  resolveCopyLeaderAdoptAvgLegPct,
  resolveCopyLeaderAdoptTier,
} from '../../src/live/copy-leader-exit-adopt.js';
import { entrySplitLegDoneFromState } from '../../src/papertrader/entry-split-legs.js';
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
      'PAPER_LIVE_STAGED_ENTRY_SECOND_LEG_USD',
      'PAPER_LIVE_STAGED_ENTRY_SECOND_DROP_PCT',
      'PAPER_LIVE_STAGED_ENTRY_THIRD_LEG_USD',
      'PAPER_LIVE_STAGED_ENTRY_THIRD_DROP_PCT',
      'LIVE_COPY_LEADER_ADOPT_AVG_LEG_PCT',
    ]) {
      saveEnv(key);
    }
    process.env.PAPER_STRATEGY_ID = 'live-oscar';
    process.env.PAPER_LIVE_STAGED_ENTRY_ENABLED = '1';
    process.env.PAPER_LIVE_STAGED_ENTRY_SECOND_LEG_USD = '1000';
    process.env.PAPER_LIVE_STAGED_ENTRY_SECOND_DROP_PCT = '10';
    process.env.PAPER_LIVE_STAGED_ENTRY_THIRD_LEG_USD = '1000';
    process.env.PAPER_LIVE_STAGED_ENTRY_THIRD_DROP_PCT = '20';
    process.env.LIVE_COPY_LEADER_ADOPT_AVG_LEG_PCT = '25';
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

  it('adopts copy position with staged-entry plan (25% @ −10% / −20%)', async () => {
    const mint = 'MintCopyStaged111111111111111111111111111111';
    const promotedAt = Date.now() - 120_000;
    const entryPriceUsd = 0.0042;
    const statePath = writeCopyState({
      mint,
      promotedAt,
      entryPriceUsd,
      entryMcapUsd: 5_000_000,
      costBasisUsd: 700,
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
    expect(ot.copyToOscarPromoted).toBe(true);
    expect(ot.totalInvestedUsd).toBe(700);

    const st = ot.liveStagedEntry!;
    expect(st.copyLeaderAdoptStagedPlan).toBe(true);
    expect(st.signalPriceUsd).toBe(entryPriceUsd);
    expect(st.avgSecondLegUsd).toBe(175);
    expect(st.avgThirdLegUsd).toBe(175);
    expect(st.avgSecondDropPct).toBe(10);
    expect(st.avgThirdDropPct).toBe(20);
    expect(entrySplitLegDoneFromState(st, 2)).toBe(true);
    expect(st.avgFirstLegDone).toBe(false);
  });

  it('attachCopyLeaderDiscoveryStagedEntryTopUp uses same 25% copy-adopt plan', () => {
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
          sizeUsd: 800,
          reason: 'open',
        },
      ],
      partialSells: [],
      totalInvestedUsd: 800,
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
    expect(st.avgSecondLegUsd).toBe(200);
    expect(st.avgThirdLegUsd).toBe(200);
    expect(st.avgSecondDropPct).toBe(10);
    expect(st.avgThirdDropPct).toBe(20);
    expect(ot.totalInvestedUsd).toBe(800);
  });

  it('heals already-open copy adopt without staged plan', async () => {
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
      entryMarketCapUsd: 6_000_000,
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
    expect(open.get(mint)!.copyToOscarPromoted).toBe(true);
    expect(open.get(mint)!.liveStagedEntry?.avgSecondLegUsd).toBe(250);
    expect(open.get(mint)!.liveStagedEntry?.copyLeaderAdoptStagedPlan).toBe(true);
  });

  it('reconcileCopyLeaderAdoptStagedEntryPlans attaches plan on open map', () => {
    const paperCfg = stagedEntryPaperCfg();
    const mint = 'MintHealOnly11111111111111111111111111111111';
    const open = new Map<string, OpenTrade>();
    open.set(mint, {
      mint,
      symbol: 'HEAL',
      lane: 'post_migration',
      metricType: 'price',
      dex: 'pumpswap',
      entryTs: Date.now() - 90_000,
      entryMcUsd: 0.01,
      entryMarketCapUsd: 10_000_000,
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
      legs: [{ ts: Date.now() - 90_000, price: 0.01, marketPrice: 0.01, sizeUsd: 400, reason: 'open' }],
      partialSells: [],
      totalInvestedUsd: 400,
      avgEntry: 0.01,
      avgEntryMarket: 0.01,
      remainingFraction: 1,
      dcaUsedLevels: new Set(),
      dcaUsedIndices: new Set(),
      ladderUsedLevels: new Set(),
      ladderUsedIndices: new Set(),
      pairAddress: null,
      entryLiqUsd: null,
      copyToOscarPromoted: true,
    });

    const attached = reconcileCopyLeaderAdoptStagedEntryPlans(open, paperCfg);
    expect(attached).toEqual([mint]);
    expect(open.get(mint)!.liveStagedEntry!.avgSecondLegUsd).toBe(100);
  });

  it('resolveCopyLeaderAdoptAvgLegPct defaults to 25', () => {
    saveEnv('LIVE_COPY_LEADER_ADOPT_AVG_LEG_PCT');
    delete process.env.LIVE_COPY_LEADER_ADOPT_AVG_LEG_PCT;
    expect(resolveCopyLeaderAdoptAvgLegPct()).toBe(25);
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

  it('resolveCopyLeaderAdoptTier blocks unknown mcap', () => {
    const cfg = stagedEntryPaperCfg();
    const r = resolveCopyLeaderAdoptTier(cfg, null);
    expect(r.adoptBlocked).toBe(true);
    expect(r.blockReason).toBe('mcap_unknown');
  });
});
