import { describe, expect, it } from 'vitest';
import {
  entrySplitBandOk,
  reconcileEntrySplitV2FromLegs,
  stagedAvgFirstEligible,
  stagedAvgSecondEligible,
} from '../src/papertrader/executor/live-staged-entry-gates.js';
import type { LiveStagedEntryState, OpenTrade } from '../src/papertrader/types.js';

function baseSt(): LiveStagedEntryState {
  return {
    signalTs: 1_000_000,
    signalPriceUsd: 1,
    firstDropPct: 0,
    firstLegUsd: 500,
    secondDropPct: 7,
    secondLegUsd: 150,
    thirdDropPct: 14,
    thirdLegUsd: 150,
    killDropPct: 23,
    entrySplitV2: true,
    entrySplitLeg1Ts: 1_000_000,
    avgSecondDropPct: 7,
    avgThirdDropPct: 14,
    avgFirstCooldownMs: 180_000,
    avgSecondCooldownMs: 300_000,
  };
}

describe('entrySplitBandOk', () => {
  it('allows +3% and -10%', () => {
    expect(entrySplitBandOk(3, 3, 10)).toBe(true);
    expect(entrySplitBandOk(-10, 3, 10)).toBe(true);
    expect(entrySplitBandOk(3.1, 3, 10)).toBe(false);
    expect(entrySplitBandOk(-10.1, 3, 10)).toBe(false);
  });
});

describe('stagedAvgFirstEligible', () => {
  it('requires cooldown and drop between -7% and -14%', () => {
    const st = baseSt();
    expect(stagedAvgFirstEligible({ st, signalDropPct: -8, nowMs: st.entrySplitLeg1Ts! + 179_000 })).toBe(false);
    expect(stagedAvgFirstEligible({ st, signalDropPct: -8, nowMs: st.entrySplitLeg1Ts! + 180_000 })).toBe(true);
    expect(stagedAvgFirstEligible({ st, signalDropPct: -15, nowMs: st.entrySplitLeg1Ts! + 200_000 })).toBe(false);
    expect(stagedAvgFirstEligible({ st, signalDropPct: -5, nowMs: st.entrySplitLeg1Ts! + 200_000 })).toBe(false);
  });
});

describe('stagedAvgSecondEligible', () => {
  it('requires 5m after first avg and drop <= -14%', () => {
    const st = { ...baseSt(), avgFirstLegDone: true, avgFirstLegTs: 2_000_000 };
    expect(stagedAvgSecondEligible({ st, signalDropPct: -15, nowMs: 2_299_000 })).toBe(false);
    expect(stagedAvgSecondEligible({ st, signalDropPct: -15, nowMs: 2_300_000 })).toBe(true);
    expect(stagedAvgSecondEligible({ st, signalDropPct: -10, nowMs: 2_400_000 })).toBe(false);
  });
});

describe('reconcileEntrySplitV2FromLegs', () => {
  it('marks entrySplitLeg2Done when entry_split leg exists after restore', () => {
    const st = { ...baseSt(), entrySplitLeg2Done: false };
    const ot = {
      legs: [
        { ts: 1, price: 0.123, marketPrice: 0.1229, sizeUsd: 500, reason: 'open' },
        { ts: 2, price: 0.124, marketPrice: 0.1233, sizeUsd: 500, reason: 'entry_split', triggerPct: 0.003 },
      ],
      liveStagedEntry: st,
    } as unknown as OpenTrade;
    reconcileEntrySplitV2FromLegs(ot);
    expect(st.entrySplitLeg2Done).toBe(true);
  });
});
