import { describe, expect, it } from 'vitest';
import type { CopyTraderConfig } from '../../src/copytrader/config.js';
import { assertCopyTraderIsolation } from '../../src/copytrader/isolation.js';

const baseCfg: CopyTraderConfig = {
  targetWallet: 'gasBidSWW5zmwXs3gn8TG2ijzKkrwpyM7ucwjgDQst6',
  rpcUrl: 'https://example.com',
  executionMode: 'paper',
  journalPath: 'data/copytrader/journal.jsonl',
  statePath: 'data/copytrader/state.json',
  pollIntervalMs: 12_000,
  signatureLimit: 25,
  tickIntervalMs: 2000,
  buyDelayMs: 600_000,
  buyRetryWindowMs: 7_200_000,
  buyRetryDeferLogMs: 60_000,
  sellRetryWindowMs: 7_200_000,
  sellRetryIntervalMs: 6_000,
  sellRetryDeferLogMs: 30_000,
  mirrorActionDelayMinMs: 5_000,
  mirrorActionDelayMaxMs: 10_000,
  sellDelayMinMs: 5_000,
  sellDelayMaxMs: 10_000,
  positionUsd: 50,
  addPositionUsd: 15,
  maxPositionUsd: 95,
  maxAddsPerMint: 3,
  minProportionalAddUsd: 3,
  minProportionalSellFraction: 0.005,
  buyPriceMaxPremiumPct: 2,
  addMaxPremiumPct: 5,
  partialSellMaxDrawdownPct: 5,
  sellSlippageBumpBps: 100,
  sellSlippageMaxBps: 2000,
  minLeaderBuyUsd: 50,
  minLiquidityUsd: 15_000,
  minMarketCapUsd: 0,
  maxMarketCapUsd: 0,
  minPairAgeHours: 0,
  maxOpenPositions: 5,
  slippageBps: 400,
  walletPubkeyExpected: 'HoFKBH9novJha1rzkHTBRqPrMbXtRNQL3wgJUWqfmp19',
};

describe('assertCopyTraderIsolation', () => {
  it('rejects journal paths that overlap live-oscar', () => {
    expect(() =>
      assertCopyTraderIsolation({
        ...baseCfg,
        journalPath: 'data/live/pt1-oscar-live.jsonl',
      }),
    ).toThrow(/overlaps live-oscar/);
  });

  it('allows dedicated copytrader paths', () => {
    expect(() => assertCopyTraderIsolation(baseCfg)).not.toThrow();
  });
});
