import { describe, expect, it, vi } from 'vitest';
import type { PaperTraderConfig } from '../src/papertrader/config.js';
import type { OpenTrade } from '../src/papertrader/types.js';
import { tryLiveStagedEntryV2TrackerStep } from '../src/papertrader/executor/live-staged-entry-lifecycle.js';

const cfg = { positionUsd: 500 } as PaperTraderConfig;

function openWithPendingLeg2(overrides: Partial<OpenTrade> = {}): OpenTrade {
  return {
    mint: 'CancelMint1111111111111111111111111111111',
    symbol: 'CNCL',
    entryTs: Date.now() - 120_000,
    totalInvestedUsd: 500,
    remainingFraction: 1,
    avgEntry: 0.04,
    avgEntryMarket: 0.04,
    tokenDecimals: 6,
    legs: [{ ts: Date.now(), price: 0.04, marketPrice: 0.04, sizeUsd: 500, reason: 'open' }],
    partialSells: [],
    dcaUsedIndices: new Set(),
    dcaUsedLevels: new Set(),
    ladderUsedLevels: new Set(),
    ladderUsedIndices: new Set(),
    peakPnlPct: 0,
    trailingArmed: false,
    peakMcUsd: 0.04,
    dex: 'raydium',
    source: 'raydium',
    livePendingEntryLegsCancelled: true,
    liveStagedEntry: {
      signalTs: Date.now() - 180_000,
      signalPriceUsd: 0.04,
      entrySplitV2: true,
      entrySplitLeg1Done: true,
      entrySplitLeg2Done: false,
      entrySplitLegUsd: 500,
      entrySplitLeg2Ts: Date.now() - 60_000,
    },
    ...overrides,
  } as OpenTrade;
}

describe('live staged entry full-close cancel', () => {
  it('tryLiveStagedEntryV2TrackerStep no-ops when legs cancelled', async () => {
    const journalAppend = vi.fn();
    const ot = openWithPendingLeg2();

    await tryLiveStagedEntryV2TrackerStep({
      cfg,
      ot,
      mint: ot.mint,
      curMetric: 0.038,
      livePhase4: {
        trySolToTokenBuy: vi.fn(async () => ({ ok: true })),
      } as never,
      journalAppend,
    });

    expect(journalAppend).not.toHaveBeenCalled();
  });
});
