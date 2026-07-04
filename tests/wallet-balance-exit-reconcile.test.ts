import { describe, expect, it } from 'vitest';
import type { OpenTrade } from '../src/papertrader/types.js';
import {
  effectiveRemainingUsdForExit,
  hasManagedWalletExposure,
  planFullExitUsdNotional,
  planPartialSellUsdNotional,
  resyncRemainingFractionFromChain,
  WALLET_RECONCILE_REMAINING_EPS,
} from '../src/live/wallet-balance-exit-reconcile.js';

function testOpen(overrides: Partial<OpenTrade> = {}): OpenTrade {
  return {
    mint: 'CFPkPqTestMint1111111111111111111111111',
    symbol: 'MENSA',
    entryTs: Date.now() - 3_600_000,
    totalInvestedUsd: 200,
    remainingFraction: 0,
    avgEntry: 0.04,
    avgEntryMarket: 0.04,
    tokenDecimals: 6,
    legs: [{ ts: Date.now(), price: 0.04, marketPrice: 0.04, usd: 200, reason: 'open' }],
    partialSells: [],
    dcaUsedIndices: new Set(),
    dcaUsedLevels: new Set(),
    peakPnlPct: 50,
    trailingArmed: true,
    peakMcUsd: 0.08,
    dex: 'raydium',
    source: 'raydium',
    ...overrides,
  } as OpenTrade;
}

describe('wallet-balance-exit-reconcile', () => {
  it('MENSA scenario: journal 0, chain $400+ → resync + managed exposure', () => {
    const ot = testOpen({ remainingFraction: 0 });
    const chainUsd = 420;

    expect(hasManagedWalletExposure({ ot, chainOscarUsd: chainUsd, minUsd: 5 })).toBe(true);

    const r = resyncRemainingFractionFromChain({ ot, chainOscarUsd: chainUsd, minUsd: 5 });
    expect(r.resynced).toBe(true);
    expect(r.reason).toBe('journal_zero_chain_holds');
    expect(ot.remainingFraction).toBe(1);

    const capped = testOpen({ remainingFraction: 0, totalInvestedUsd: 500 });
    const r2 = resyncRemainingFractionFromChain({ ot: capped, chainOscarUsd: 420, minUsd: 5 });
    expect(r2.resynced).toBe(true);
    expect(capped.remainingFraction).toBeCloseTo(0.84, 5);
  });

  it('resyncs upward when manual buy doubles chain vs journal', () => {
    const ot = testOpen({ remainingFraction: 0.25, totalInvestedUsd: 200 });
    const r = resyncRemainingFractionFromChain({ ot, chainOscarUsd: 180, minUsd: 5 });
    expect(r.resynced).toBe(true);
    expect(r.reason).toBe('chain_above_journal');
    expect(ot.remainingFraction).toBeCloseTo(0.9, 5);
  });

  it('does not shrink journal when chain is below journal', () => {
    const ot = testOpen({ remainingFraction: 0.5, totalInvestedUsd: 200 });
    const before = ot.remainingFraction;
    const r = resyncRemainingFractionFromChain({ ot, chainOscarUsd: 50, minUsd: 5 });
    expect(r.resynced).toBe(false);
    expect(ot.remainingFraction).toBe(before);
  });

  it('planFullExitUsdNotional prefers chain when journal is zero', () => {
    const ot = testOpen({ remainingFraction: 0 });
    expect(planFullExitUsdNotional({ ot, chainOscarUsd: 400 })).toBe(400);
    expect(effectiveRemainingUsdForExit(0, 400)).toBe(400);
  });

  it('planPartialSellUsdNotional sizes from chain for trail/TP partial', () => {
    const ot = testOpen({ remainingFraction: 0, totalInvestedUsd: 200 });
    const usd = planPartialSellUsdNotional({
      ot,
      chainOscarUsd: 400,
      sellFraction: 0.5,
      marketPrice: 0.1,
    });
    expect(usd).toBeCloseTo(200, 1);
  });

  it('journal-only path unchanged when chain empty', () => {
    const ot = testOpen({ remainingFraction: 0.5 });
    expect(hasManagedWalletExposure({ ot, chainOscarUsd: 0, minUsd: 5 })).toBe(true);
    expect(ot.remainingFraction).toBeGreaterThan(WALLET_RECONCILE_REMAINING_EPS);
    expect(planFullExitUsdNotional({ ot, chainOscarUsd: 0 })).toBe(100);
  });
});
