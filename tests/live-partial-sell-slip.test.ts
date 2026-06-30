import { describe, expect, it } from 'vitest';
import { tokenAmountRawFromUsd } from '../src/live/phase4-execution.js';
import {
  computeSlipRealizedPct,
  resolvePartialSellTokensSold,
} from '../src/papertrader/executor/tracker.js';

/** WORLD partial (2026-06-30): planned ~$663 exit-slice notional, first $250 slice on chain. */
const WORLD = {
  marketSell: 0.002823798418746513,
  avgEntry: 0.002684382616162134,
  avgEntryMarket: 0.002661966977856011,
  totalInvestedUsd: 1250,
  sellFraction: 0.5,
  remainingFraction: 1,
  sliceUsd: 250,
  chainProceedsUsd: 249.66048418403625,
  decimals: 6,
};

describe('resolvePartialSellTokensSold', () => {
  it('world-like partial: $663 planned, $250 slice — slip ~0% not 62%', () => {
    const investedSoldUsd =
      WORLD.totalInvestedUsd * WORLD.remainingFraction * WORLD.sellFraction;
    const tokenSizingUsdForSwap =
      investedSoldUsd * (WORLD.marketSell / WORLD.avgEntryMarket);
    expect(tokenSizingUsdForSwap).toBeGreaterThan(650);
    expect(tokenSizingUsdForSwap).toBeLessThan(670);

    const tokenAmountRawSold = tokenAmountRawFromUsd(
      WORLD.sliceUsd,
      WORLD.marketSell,
      WORLD.decimals,
    );
    expect(tokenAmountRawSold).toBeTruthy();

    const tokensSold = resolvePartialSellTokensSold({
      tokenAmountRawSold: tokenAmountRawSold!,
      tokenDecimals: WORLD.decimals,
      actualProceedsUsd: WORLD.chainProceedsUsd,
      marketSell: WORLD.marketSell,
      tokenSizingUsdForSwap,
      investedSoldUsd,
      avgEntry: WORLD.avgEntry,
    });

    const inflatedTokens = tokenSizingUsdForSwap / WORLD.marketSell;
    const effectiveSell = WORLD.chainProceedsUsd / tokensSold;
    const slip = computeSlipRealizedPct(WORLD.marketSell, effectiveSell);
    const buggySlip = computeSlipRealizedPct(
      WORLD.marketSell,
      WORLD.chainProceedsUsd / inflatedTokens,
    );

    expect(buggySlip).toBeGreaterThan(60);
    expect(slip).not.toBeNull();
    expect(slip!).toBeLessThan(2);
    expect(slip!).toBeGreaterThan(-2);
  });

  it('falls back to proceeds/market when token raw missing', () => {
    const tokensSold = resolvePartialSellTokensSold({
      tokenDecimals: 6,
      actualProceedsUsd: 250,
      marketSell: 1,
      tokenSizingUsdForSwap: 663,
      investedSoldUsd: 625,
      avgEntry: 0.5,
    });
    expect(tokensSold).toBe(250);
    expect(computeSlipRealizedPct(1, 250 / tokensSold)).toBe(0);
  });
});
