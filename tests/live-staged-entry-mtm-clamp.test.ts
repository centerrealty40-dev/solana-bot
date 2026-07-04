import { describe, it, expect } from 'vitest';
import { clampLiveTrackerMtmForExit } from '../src/papertrader/executor/exit-policy-wave-b.js';
import { resolveObservedPriceUsdForJournal } from '../src/live/sell-price-sanity.js';
import { resolveObservedPriceUsdForJournal } from '../src/live/sell-price-sanity.js';
import {
  signalDropPctFromState,
  stagedAvgFirstEligible,
} from '../src/papertrader/executor/live-staged-entry-gates.js';
import type { LiveStagedEntryState, OpenTrade } from '../src/papertrader/types.js';

function stagedState(overrides: Partial<LiveStagedEntryState> = {}): LiveStagedEntryState {
  return {
    signalTs: 1_700_000_000_000,
    signalPriceUsd: 0.006226,
    killDropPct: 15,
    firstLegUsd: 200,
    secondLegUsd: 600,
    secondDropPct: 10,
    thirdLegUsd: 0,
    thirdDropPct: 0,
    entrySplitV2: true,
    entrySplitLeg2Done: true,
    avgSecondLegUsd: 600,
    avgSecondDropPct: 10,
    avgThirdDropPct: 15,
    avgFirstCooldownMs: 0,
    entrySplitLeg1Ts: 1_700_000_000_000,
    ...overrides,
  };
}

describe('staged entry vs MTM tick clamp', () => {
  it('PG snapshot dip triggers leg3 while Jupiter exit MTM stays above −10% threshold', () => {
    const signalPx = 0.006226;
    const snapPgPx = signalPx * 0.88; // −12% vs signal (between −10% and −15% band)
    const jupiterMtmPx = signalPx * 0.92; // −8% tradable quote lags the dip
    const ot = {
      lastObservedPriceUsd: signalPx,
      avgEntryMarket: signalPx,
      avgEntry: signalPx,
    } as OpenTrade;

    const clampedExit = clampLiveTrackerMtmForExit(ot, jupiterMtmPx);
    const st = stagedState();

    const pgDrop = signalDropPctFromState(st, snapPgPx)!;
    const exitDrop = signalDropPctFromState(st, clampedExit)!;

    expect(pgDrop).toBeLessThanOrEqual(-10);
    expect(exitDrop).toBeGreaterThan(-10);
    expect(stagedAvgFirstEligible({ st, signalDropPct: pgDrop, nowMs: st.entrySplitLeg1Ts! + 1 })).toBe(true);
    expect(stagedAvgFirstEligible({ st, signalDropPct: exitDrop, nowMs: st.entrySplitLeg1Ts! + 1 })).toBe(false);
  });

  it('staged entry prefers PG snapshot over Jupiter MTM for signal-drop math', () => {
    const signalPx = 1.0;
    const snapPgPx = 0.88;
    const jupiterMtmPx = 0.92;
    const stagedPx = snapPgPx > 0 ? snapPgPx : jupiterMtmPx;
    expect(stagedPx).toBe(snapPgPx);
    expect((stagedPx / signalPx - 1) * 100).toBeLessThanOrEqual(-10);
    expect((jupiterMtmPx / signalPx - 1) * 100).toBeGreaterThan(-10);
  });

  it('lastObservedPriceUsd stores exit-clamped MTM when ghost tick clamp applies', () => {
    const prev = 1.0;
    const rawMtm = 0.5; // −50% single tick
    const ot = { lastObservedPriceUsd: prev } as OpenTrade;
    const clamped = clampLiveTrackerMtmForExit(ot, rawMtm);
    expect(clamped).toBeGreaterThan(rawMtm);
    ot.lastObservedPriceUsd = resolveObservedPriceUsdForJournal(rawMtm, clamped);
    expect(ot.lastObservedPriceUsd).toBe(clamped);
    expect(ot.lastObservedPriceUsd).not.toBe(rawMtm);
  });
});
