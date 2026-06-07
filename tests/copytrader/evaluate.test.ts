import { describe, expect, it } from 'vitest';
import type { CopyTraderConfig } from '../../src/copytrader/config.js';
import { evaluateCopyEntry } from '../../src/copytrader/evaluate.js';

const baseCfg: CopyTraderConfig = {
  targetWallet: 'Hb6NS1234567890123456789012345678901234567890',
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
  sellDelayMinMs: 20_000,
  sellDelayMaxMs: 30_000,
  positionUsd: 50,
  addPositionUsd: 15,
  maxPositionUsd: 95,
  maxAddsPerMint: 3,
  minProportionalAddUsd: 3,
  minProportionalSellFraction: 0.005,
  buyPriceMaxPremiumPct: 2,
  entryProbeFraction: 0.25,
  entryDipDiscountPct: 5,
  minLeaderBuyUsd: 50,
  minLiquidityUsd: 15_000,
  minMarketCapUsd: 0,
  maxMarketCapUsd: 0,
  minPairAgeHours: 0,
  maxOpenPositions: 5,
  slippageBps: 400,
};

describe('evaluateCopyEntry', () => {
  it('passes when price is at or below leader and liquidity ok', () => {
    const r = evaluateCopyEntry(baseCfg, {
      mint: 'Mint1111111111111111111111111111111111111',
      leaderPriceUsd: 0.001,
      leaderBuyUsd: 200,
      currentPriceUsd: 0.00095,
      dex: {
        symbol: 'TEST',
        name: 'Test',
        priceUsd: 0.00095,
        marketCap: 500_000,
        liquidityUsd: 40_000,
        volume24h: 100_000,
        volume1h: 5_000,
        pairCreatedAtMs: Date.now() - 48 * 3600_000,
        dexId: 'raydium',
      },
      nowMs: Date.now(),
    });
    expect(r.pass).toBe(true);
    expect(r.reasons).toHaveLength(0);
  });

  it('rejects when current price exceeds leader tolerance', () => {
    const r = evaluateCopyEntry(baseCfg, {
      mint: 'Mint1111111111111111111111111111111111111',
      leaderPriceUsd: 0.001,
      leaderBuyUsd: 200,
      currentPriceUsd: 0.00105,
      dex: {
        symbol: 'TEST',
        name: 'Test',
        priceUsd: 0.00105,
        marketCap: 500_000,
        liquidityUsd: 40_000,
        volume24h: 100_000,
        volume1h: 5_000,
        pairCreatedAtMs: Date.now() - 48 * 3600_000,
        dexId: 'raydium',
      },
      nowMs: Date.now(),
    });
    expect(r.pass).toBe(false);
    expect(r.reasons.some((x) => x.startsWith('price_too_high'))).toBe(true);
  });

  it('rejects low liquidity', () => {
    const r = evaluateCopyEntry(baseCfg, {
      mint: 'Mint1111111111111111111111111111111111111',
      leaderPriceUsd: 0.001,
      leaderBuyUsd: 200,
      currentPriceUsd: 0.001,
      dex: {
        symbol: 'TEST',
        name: 'Test',
        priceUsd: 0.001,
        marketCap: 50_000,
        liquidityUsd: 1000,
        volume24h: 500,
        volume1h: 50,
        pairCreatedAtMs: Date.now() - 48 * 3600_000,
        dexId: 'pumpswap',
      },
      nowMs: Date.now(),
    });
    expect(r.pass).toBe(false);
    expect(r.reasons.some((x) => x.startsWith('liquidity='))).toBe(true);
  });
});
