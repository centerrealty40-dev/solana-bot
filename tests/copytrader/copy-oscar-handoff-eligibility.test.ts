import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  copyOscarHandoffEligibleForPosition,
  copyPositionOscarExitManaged,
  reconcileIneligibleOscarHandoffs,
} from '../../src/copytrader/copy-oscar-handoff-eligibility.js';
import type { CopyTraderConfig } from '../../src/copytrader/config.js';
import type { CopyPosition, CopyTraderState } from '../../src/copytrader/state.js';
import { emptyCopyTraderState } from '../../src/copytrader/state.js';
import { loadPaperTraderConfig } from '../../src/papertrader/config.js';

const cfgBase: CopyTraderConfig = {
  targetWallet: '498SWfPJisr26J4oCiZccyzReFrByNE7jsHwbm3caNma',
  rpcUrl: 'https://example.com',
  executionMode: 'paper',
  journalPath: 'data/copytrader/journal-elig-test.jsonl',
  statePath: 'data/copytrader/state-elig-test.json',
  pollIntervalMs: 5000,
  signatureLimit: 25,
  tickIntervalMs: 2000,
  buyDelayMs: 5000,
  entryProbeBuyDelayMs: 0,
  buyRetryWindowMs: 7_200_000,
  buyRetryDeferLogMs: 60_000,
  sellRetryWindowMs: 7_200_000,
  sellRetryIntervalMs: 3_000,
  sellRetryDeferLogMs: 30_000,
  minSellIntervalMs: 0,
  entryDipJupiterMinIntervalMs: 0,
  sellDelayMinMs: 0,
  sellDelayMaxMs: 2000,
  leaderFlatConfirmDelayMs: 3000,
  leaderFlatDustRaw: 10_000n,
  positionUsd: 500,
  initialMirrorRatio: 0.75,
  addPositionUsd: 500,
  maxPositionUsd: 0,
  maxAddsPerMint: 0,
  minProportionalAddUsd: 0,
  minProportionalSellFraction: 0,
  buyPriceMaxPremiumPct: 3,
  entryFullMcapUsd: 0,
  entryMidPositionUsd: 500,
  entryMidLegUsd: 500,
  entryProbeFraction: 1,
  entryDipDiscountPct: 0,
  entryDipConfirmTicks: 2,
  entryDipVsProbePct: 2,
  entryMinDeployFraction: 0.99,
  addPriceMaxPremiumPct: 0,
  allowLateEntryOnLeaderRebuy: true,
  minLeaderBuyUsd: 50,
  minLiquidityUsd: 15_000,
  minMarketCapUsd: 0,
  maxMarketCapUsd: 0,
  minPairAgeHours: 0,
  maxOpenPositions: 0,
  slippageBps: 100,
  sharedOscarWallet: true,
  exitMode: 'oscar_half8',
  spareCapitalGateEnabled: false,
};

describe('copy oscar handoff eligibility', () => {
  const prevDiscoveryMin = process.env.PAPER_DISCOVERY_MIN_MARKET_CAP_USD;
  const prevLowLane = process.env.PAPER_LIVE_OSCAR_LOW_MCAP_LANE_ENABLED;

  beforeEach(() => {
    process.env.PAPER_DISCOVERY_MIN_MARKET_CAP_USD = '3000000';
    process.env.PAPER_LIVE_OSCAR_LOW_MCAP_LANE_ENABLED = '0';
  });

  afterEach(() => {
    if (prevDiscoveryMin === undefined) delete process.env.PAPER_DISCOVERY_MIN_MARKET_CAP_USD;
    else process.env.PAPER_DISCOVERY_MIN_MARKET_CAP_USD = prevDiscoveryMin;
    if (prevLowLane === undefined) delete process.env.PAPER_LIVE_OSCAR_LOW_MCAP_LANE_ENABLED;
    else process.env.PAPER_LIVE_OSCAR_LOW_MCAP_LANE_ENABLED = prevLowLane;
  });

  it('blocks handoff below prod discovery mcap floor', () => {
    const paperCfg = loadPaperTraderConfig();
    const pos: CopyPosition = {
      mint: 'ATBR4i19gcQ31Rfr7ymA2XvkCQEAkNFGBtVKTmdqpump',
      symbol: 'Machi',
      entryTs: Date.now(),
      entryPriceUsd: 0.0007,
      sizeUsd: 500,
      entryMcapUsd: 700_000,
      addCount: 0,
      leaderWallet: cfgBase.targetWallet,
      leaderEntrySig: 'sig',
    };
    const elig = copyOscarHandoffEligibleForPosition(pos, paperCfg);
    expect(elig.eligible).toBe(false);
    expect(elig.blockReason).toBe('mcap_below_threshold');
  });

  it('allows handoff at prod mcap', () => {
    const pos: CopyPosition = {
      mint: 'MintProd1111111111111111111111111111111111',
      symbol: 'PROD',
      entryTs: Date.now(),
      entryPriceUsd: 0.01,
      sizeUsd: 500,
      entryMcapUsd: 5_000_000,
      addCount: 0,
      leaderWallet: cfgBase.targetWallet,
      leaderEntrySig: 'sig',
    };
    expect(copyOscarHandoffEligibleForPosition(pos, loadPaperTraderConfig()).eligible).toBe(true);
  });

  it('reverts stale promoted rows Oscar cannot adopt', () => {
    const state: CopyTraderState = emptyCopyTraderState();
    const mint = 'ATBR4i19gcQ31Rfr7ymA2XvkCQEAkNFGBtVKTmdqpump';
    state.positions[mint] = {
      mint,
      symbol: 'Machi',
      entryTs: Date.now() - 3600_000,
      entryPriceUsd: 0.0007,
      sizeUsd: 500,
      entryMcapUsd: 700_000,
      oscarPromotedAt: Date.now() - 3600_000,
      addCount: 0,
      leaderWallet: cfgBase.targetWallet,
      leaderEntrySig: 'sig',
    };

    const reverted = reconcileIneligibleOscarHandoffs(cfgBase, state);
    expect(reverted).toBe(1);
    expect(copyPositionOscarExitManaged(state.positions[mint])).toBe(false);
  });
});
