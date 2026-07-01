import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadPaperTraderConfig } from '../../src/papertrader/config.js';
import type { EvalDecision } from '../../src/papertrader/discovery/dip-clones.js';
import type { OpenTrade } from '../../src/papertrader/types.js';
import {
  evaluateCopyToOscarPromotionPlan,
  resolveLiveBuyOpenIntendedUsd,
} from '../../src/live/copy-to-oscar-promotion.js';
import type { LivePhase4BuyOpenContext } from '../../src/live/phase4-types.js';
import type { LiveOscarConfig } from '../../src/live/config.js';

describe('copy-to-oscar-promotion', () => {
  const tmpFiles: string[] = [];
  const envBackup: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of [
      'PAPER_STRATEGY_ID',
      'PAPER_LIVE_STAGED_ENTRY_ENABLED',
      'PAPER_LIVE_STAGED_ENTRY_ENTRY_SPLIT_LEG_USD',
      'PAPER_POSITION_USD',
      'PAPER_LIVE_STAGED_ENTRY_SECOND_LEG_USD',
      'PAPER_LIVE_STAGED_ENTRY_THIRD_LEG_USD',
      'PAPER_LIVE_OSCAR_LOW_MCAP_LANE_ENABLED',
      'PAPER_LIVE_OSCAR_PROD_MCAP_BAND_12M_USD',
      'PAPER_LIVE_OSCAR_PROD_MCAP_MAX_3_12_USD',
      'PAPER_LIVE_OSCAR_PROD_MCAP_MAX_12_PLUS_USD',
      'LIVE_COPY_TO_OSCAR_PROMOTION_ENABLED',
      'LIVE_COPY_LEADER_STATE_PATH',
    ]) {
      envBackup[k] = process.env[k];
    }
    process.env.PAPER_STRATEGY_ID = 'live-oscar';
    process.env.PAPER_LIVE_STAGED_ENTRY_ENABLED = '1';
    process.env.PAPER_LIVE_STAGED_ENTRY_ENTRY_SPLIT_LEG_USD = '300';
    process.env.PAPER_POSITION_USD = '2400';
    process.env.PAPER_LIVE_STAGED_ENTRY_SECOND_LEG_USD = '300';
    process.env.PAPER_LIVE_STAGED_ENTRY_THIRD_LEG_USD = '300';
    process.env.PAPER_LIVE_OSCAR_LOW_MCAP_LANE_ENABLED = '1';
    process.env.PAPER_LIVE_OSCAR_PROD_MCAP_BAND_12M_USD = '12000000';
    process.env.PAPER_LIVE_OSCAR_PROD_MCAP_MAX_3_12_USD = '3100';
    process.env.PAPER_LIVE_OSCAR_PROD_MCAP_MAX_12_PLUS_USD = '3100';
    process.env.LIVE_COPY_TO_OSCAR_PROMOTION_ENABLED = '1';
  });

  afterEach(() => {
    for (const f of tmpFiles) {
      try {
        fs.unlinkSync(f);
      } catch {
        // ignore
      }
    }
    for (const [k, v] of Object.entries(envBackup)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  function writeCopyState(mint: string, positions: Record<string, unknown>): string {
    const fp = path.join(os.tmpdir(), `copy-promo-${Date.now()}-${Math.random()}.json`);
    fs.writeFileSync(fp, JSON.stringify({ positions: { [mint]: positions[mint] } }), 'utf8');
    tmpFiles.push(fp);
    process.env.LIVE_COPY_LEADER_STATE_PATH = fp;
    return fp;
  }

  function ctxFor(mint: string, mcapUsd: number): LivePhase4BuyOpenContext {
    const paperCfg = loadPaperTraderConfig();
    const decision = {
      pass: true,
      mint,
      symbol: 'TEST',
      lane: 'prod',
      source: 'dexscreener',
      reasons: [],
      features: { price_usd: 0.01, market_cap_usd: mcapUsd },
      liveOscarTradeLane: 'prod',
    } as EvalDecision;
    const ot = {
      mint,
      symbol: 'TEST',
      lane: 'prod',
      source: 'dexscreener',
      legs: [{ ts: Date.now(), price: 0.01, marketPrice: 0.01, sizeUsd: 300, reason: 'open' }],
    } as OpenTrade;
    return {
      liveCfg: { strategyEnabled: true, executionMode: 'live' } as LiveOscarConfig,
      paperCfg,
      ot,
      decision,
      snapshotEntryPriceUsd: 0.01,
      tokenDecimals: 6,
    };
  }

  it('MANIFEST-like: top-up to prod target when copy holds $500 and wallet gross ~$606', () => {
    const mint = 'ManifestLikeMint111111111111111111111111111';
    writeCopyState(mint, {
      [mint]: { entryDeployedCostUsd: 500, sizeUsd: 500, entryPriceUsd: 0.012 },
    });

    const plan = evaluateCopyToOscarPromotionPlan({
      ctx: ctxFor(mint, 5_000_000),
      walletGrossUsd: 606,
    });
    expect(plan).not.toBeNull();
    expect(plan!.copyCostBasisUsd).toBe(500);
    expect(plan!.targetUsd).toBe(3100);
    expect(plan!.topUpUsd).toBeCloseTo(2494, 0);

    const intended = resolveLiveBuyOpenIntendedUsd({
      ctx: ctxFor(mint, 5_000_000),
      walletGrossUsd: 606,
    });
    expect(intended.promotion).not.toBeNull();
    expect(intended.usd).toBeCloseTo(2494, 0);
  });

  it('returns null for runner_probe lane', () => {
    const mint = 'RunnerProbeMint1111111111111111111111111';
    writeCopyState(mint, {
      [mint]: { entryDeployedCostUsd: 500, sizeUsd: 500 },
    });
    const ctx = ctxFor(mint, 2_000_000);
    ctx.decision.liveOscarTradeLane = 'runner_probe';

    expect(
      evaluateCopyToOscarPromotionPlan({ ctx, walletGrossUsd: 600 }),
    ).toBeNull();
  });

  it('returns null when promotion disabled', () => {
    process.env.LIVE_COPY_TO_OSCAR_PROMOTION_ENABLED = '0';
    const mint = 'DisabledPromoMint111111111111111111111111';
    writeCopyState(mint, {
      [mint]: { entryDeployedCostUsd: 500, sizeUsd: 500 },
    });
    expect(
      evaluateCopyToOscarPromotionPlan({ ctx: ctxFor(mint, 5_000_000), walletGrossUsd: 600 }),
    ).toBeNull();
  });
});
