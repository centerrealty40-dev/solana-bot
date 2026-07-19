import { describe, it, expect } from 'vitest';
import {
  isUpeExitFrozen,
  canExecuteEntryLeg,
  onEntryLegConfirmed,
  evaluateExitIntent,
  createPartialExitIntent,
  createFullExitIntent,
  defaultPositionEngineConfig,
  snapshotFromOpenTrade,
  syncUpeOnTrackerTick,
} from '../src/live/position-engine/index.js';
import { liveEntryBlockedByUpe } from '../src/live/position-engine/buy-gate.js';
import type { OpenTrade } from '../src/papertrader/types.js';

function stagedOpen(): OpenTrade {
  const ts = Date.now();
  const price = 0.01;
  return {
    mint: 'MintStagedAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    symbol: 'T',
    lane: 'post_migration',
    metricType: 'price',
    dex: 'pumpswap',
    entryTs: ts,
    entryMcUsd: price,
    entryMetrics: {
      uniqueBuyers: 0,
      uniqueSellers: 0,
      sumBuySol: 0,
      sumSellSol: 0,
      topBuyerShare: 0,
      bcProgress: 0,
    },
    peakMcUsd: price,
    peakPnlPct: 0,
    trailingArmed: false,
    legs: [{ ts, price, marketPrice: price, sizeUsd: 300, reason: 'open' }],
    partialSells: [],
    totalInvestedUsd: 300,
    avgEntry: price,
    avgEntryMarket: price,
    remainingFraction: 1,
    dcaUsedLevels: new Set(),
    dcaUsedIndices: new Set(),
    ladderUsedLevels: new Set(),
    ladderUsedIndices: new Set(),
    pairAddress: null,
    entryLiqUsd: null,
    tokenDecimals: 6,
    entryLegSignatures: ['a'.repeat(64)],
    liveStagedEntry: {
      signalTs: ts,
      signalPriceUsd: price,
      killDropPct: 25,
      firstLegUsd: 300,
      entrySplitV2: true,
      entrySplitLegUsd: 300,
      entrySplitLeg2Usd: 300,
      entrySplitLeg3Usd: 300,
      entrySplitLeg4Usd: 300,
      entrySplitLeg2Done: false,
      entrySplitLeg3Done: false,
      entrySplitLeg4Done: false,
      secondLegDone: false,
      thirdLegDone: false,
      firstDropPct: 0,
      secondDropPct: 0,
      thirdDropPct: 0,
      secondLegUsd: 0,
      thirdLegUsd: 0,
    },
  };
}

describe('Unified Position Engine — phases B/C', () => {
  it('syncUpeOnTrackerTick stamps acquiring', () => {
    const ot = stagedOpen();
    const r = syncUpeOnTrackerTick({
      ot,
      chain: {
        rawTokenBalance: 1000n,
        decimals: 6,
        priceUsd: 0.01,
        oscarAttributedUsd: 300,
      },
    });
    expect(r.phase).toBe('acquiring');
    expect(r.exitsFrozen).toBe(true);
    expect(ot.liveUpePhase).toBe('acquiring');
  });

  it('isUpeExitFrozen during entry split', () => {
    const ot = stagedOpen();
    ot.liveUpePhase = 'acquiring';
    expect(isUpeExitFrozen(ot)).toBe(true);
    expect(canExecuteEntryLeg(ot)).toBe(true);
  });

  it('partial exit intent blocked during acquiring', () => {
    const ot = stagedOpen();
    const snap = snapshotFromOpenTrade({
      ot,
      chain: { rawTokenBalance: 1000n, decimals: 6, priceUsd: 0.01, oscarAttributedUsd: 300 },
    });
    const d = evaluateExitIntent(
      snap,
      defaultPositionEngineConfig(),
      createPartialExitIntent({ reason: 'TP_LADDER', sellFraction: 0.15 }),
    );
    expect(d.allowed).toBe(false);
  });

  it('onEntryLegConfirmed keeps acquiring until split done', () => {
    const ot = stagedOpen();
    onEntryLegConfirmed(ot);
    expect(ot.liveUpePhase).toBe('acquiring');
  });

  it('liveEntryBlockedByUpe when exit in flight', () => {
    const ot = stagedOpen();
    ot.liveUpeExitInFlight = true;
    expect(liveEntryBlockedByUpe(ot, true)).toBe(true);
  });

  it('full kill blocked when exit in flight', () => {
    const ot = stagedOpen();
    ot.liveStagedEntry = undefined;
    ot.liveUpePhase = 'managed';
    ot.liveUpeExitInFlight = true;
    const snap = snapshotFromOpenTrade({
      ot,
      chain: { rawTokenBalance: 1000n, decimals: 6, priceUsd: 0.01, oscarAttributedUsd: 300 },
      exitInFlight: true,
    });
    const d = evaluateExitIntent(
      snap,
      defaultPositionEngineConfig(),
      createFullExitIntent({ reason: 'KILLSTOP' }),
    );
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.invariant).toBe('UPE-I5');
  });
});
