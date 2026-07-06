import { describe, expect, it } from 'vitest';
import type { PaperTraderConfig } from '../src/papertrader/config.js';
import type { ClosedTrade, OpenTrade } from '../src/papertrader/types.js';
import {
  clearPendingEntryLegsOnJournalClose,
  closeJournalGhostOpensWhenChainEmpty,
} from '../src/live/journal-ghost-close.js';

const cfg = { positionUsd: 500, networkFeeUsd: 0.01 } as PaperTraderConfig;

function testOpen(overrides: Partial<OpenTrade> = {}): OpenTrade {
  return {
    mint: 'GhostMint111111111111111111111111111111',
    symbol: 'GHOST',
    entryTs: Date.now() - 3_600_000,
    totalInvestedUsd: 200,
    remainingFraction: 1,
    avgEntry: 0.04,
    avgEntryMarket: 0.04,
    tokenDecimals: 6,
    legs: [{ ts: Date.now(), price: 0.04, marketPrice: 0.04, usd: 200, reason: 'open' }],
    partialSells: [],
    dcaUsedIndices: new Set(),
    dcaUsedLevels: new Set(),
    ladderUsedLevels: new Set(),
    ladderUsedIndices: new Set(),
    peakPnlPct: 0,
    trailingArmed: false,
    peakMcUsd: 0.08,
    dex: 'raydium',
    source: 'raydium',
    liveStagedEntry: {
      signalTs: Date.now(),
      signalPriceUsd: 0.04,
      entrySplitV2: true,
      entrySplitLeg1Done: true,
      entrySplitLeg2Done: false,
      entrySplitLegUsd: 500,
    },
    ...overrides,
  } as OpenTrade;
}

describe('journal-ghost-close', () => {
  it('clears pending staged entry legs on journal close', () => {
    const ot = testOpen();
    clearPendingEntryLegsOnJournalClose(ot);
    expect(ot.liveStagedEntry).toBeUndefined();
  });

  it('closes journal open when chain has zero balance (boot context)', () => {
    const ot = testOpen();
    const open = new Map<string, OpenTrade>([[ot.mint, ot]]);
    const closed: ClosedTrade[] = [];
    const chainMap = new Map<string, bigint>([[ot.mint, 0n]]);

    const r = closeJournalGhostOpensWhenChainEmpty({
      cfg,
      open,
      closed,
      chainMap,
      context: 'boot',
    });

    expect(r.closedMints).toHaveLength(1);
    expect(open.size).toBe(0);
    expect(closed).toHaveLength(1);
    expect(closed[0]!.exitReason).toBe('RECONCILE_ORPHAN');
  });

  it('does not close when chain holds material balance', () => {
    const ot = testOpen();
    const open = new Map<string, OpenTrade>([[ot.mint, ot]]);
    const closed: ClosedTrade[] = [];
    const chainMap = new Map<string, bigint>([[ot.mint, 1_000_000n]]);

    const r = closeJournalGhostOpensWhenChainEmpty({
      cfg,
      open,
      closed,
      chainMap,
      context: 'periodic_heal',
    });

    expect(r.closedMints).toHaveLength(0);
    expect(open.size).toBe(1);
  });
});
