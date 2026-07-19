import { describe, it, expect } from 'vitest';
import {
  computeClosePnl,
  confirmedBuyCostUsd,
  evaluateExitGuard,
  defaultPositionEngineConfig,
  buildEntrySplitProgress,
  derivePhase,
  snapshotFromOpenTrade,
  type PositionSnapshot,
  type ChainSnapshot,
} from '../src/live/position-engine/index.js';
import type { OpenTrade } from '../src/papertrader/types.js';

function ge87Chain(): ChainSnapshot {
  return {
    rawTokenBalance: 37_600_000_000_000n,
    decimals: 6,
    priceUsd: 0.00806,
    oscarAttributedUsd: 297,
  };
}

function ge87OpenTrade(): OpenTrade {
  const ts = Date.now();
  const price = 0.00808;
  return {
    mint: 'Ge87EtsjwRQbHaqQmKRno69RFTwh9bfSsm99XNxTpump',
    symbol: 'Jimothy',
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
    peakPnlPct: -0.8,
    trailingArmed: false,
    legs: [
      { ts, price, marketPrice: price, sizeUsd: 300, reason: 'open' },
      { ts: ts + 1, price, marketPrice: price, sizeUsd: 300, reason: 'entry_split' },
      { ts: ts + 2, price, marketPrice: price, sizeUsd: 300, reason: 'entry_split' },
      { ts: ts + 3, price, marketPrice: price, sizeUsd: 300, reason: 'entry_split' },
    ],
    partialSells: [],
    totalInvestedUsd: 1200,
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
    entryLegSignatures: [
      '5'.repeat(64),
      '6'.repeat(64),
      '7'.repeat(64),
      '8'.repeat(64),
    ],
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
    liveExitProfileMode: 'B',
  };
}

describe('Unified Position Engine — Ge87 regression', () => {
  it('derives ACQUIRING when entry split v2 incomplete', () => {
    const ot = ge87OpenTrade();
    const snap = snapshotFromOpenTrade({ ot, chain: ge87Chain() });
    expect(snap.phase).toBe('acquiring');
    expect(snap.entrySplit.plannedLegs).toBe(4);
    expect(snap.entrySplit.completedLegs).toBe(1);
    expect(snap.entrySplit.allLegsDone).toBe(false);
  });

  it('blocks KILLSTOP during ACQUIRING (UPE-I1)', () => {
    const ot = ge87OpenTrade();
    const snap = snapshotFromOpenTrade({ ot, chain: ge87Chain() });
    const cfg = defaultPositionEngineConfig();
    const d = evaluateExitGuard(snap, cfg, { exitReason: 'KILLSTOP' });
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.invariant).toBe('UPE-I1');
  });

  it('blocks full exit when chain << journal (UPE-I2)', () => {
    const ot = ge87OpenTrade();
    ot.liveStagedEntry = undefined;
    const snap: PositionSnapshot = {
      ...snapshotFromOpenTrade({ ot, chain: ge87Chain() }),
      phase: 'managed',
      entrySplit: buildEntrySplitProgress({ active: false, plannedLegs: 0, completedLegs: 0 }),
    };
    const cfg = defaultPositionEngineConfig();
    const d = evaluateExitGuard(snap, cfg, { exitReason: 'KILLSTOP' });
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.invariant).toBe('UPE-I2');
  });

  it('close PnL on flat price is not −75% when desync-adjusted', () => {
    const ot = ge87OpenTrade();
    const buys = snapshotFromOpenTrade({ ot, chain: ge87Chain() }).confirmedBuys.map((b) => ({
      ...b,
      sizeUsd: 300,
    }));
    const pnl = computeClosePnl({
      confirmedBuys: buys,
      confirmedSells: [],
      journalInvestedUsd: 1200,
      chain: ge87Chain(),
      finalProceedsUsd: 297,
    });
    expect(pnl.desyncAdjusted).toBe(true);
    expect(pnl.netPnlPct).toBeGreaterThan(-10);
    expect(pnl.netPnlPct).toBeLessThan(5);
  });

  it('allows LIQ_DRAIN during ACQUIRING when configured', () => {
    const ot = ge87OpenTrade();
    const snap = snapshotFromOpenTrade({ ot, chain: ge87Chain() });
    const cfg = defaultPositionEngineConfig({ allowLiqDrainDuringAcquire: true });
    const d = evaluateExitGuard(snap, cfg, { exitReason: 'LIQ_DRAIN' });
    expect(d.allowed).toBe(true);
  });

  it('MANAGED phase after all entry legs done', () => {
    const phase = derivePhase({
      entrySplit: buildEntrySplitProgress({ active: true, plannedLegs: 4, completedLegs: 4 }),
      exitInFlight: false,
      confirmedLegCount: 4,
      chainHasTokens: true,
    });
    expect(phase).toBe('managed');
  });

  it('confirmed buy cost sums legs', () => {
    const ot = ge87OpenTrade();
    const snap = snapshotFromOpenTrade({ ot, chain: ge87Chain() });
    expect(confirmedBuyCostUsd(snap.confirmedBuys)).toBe(1200);
  });
});
