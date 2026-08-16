import { describe, expect, it } from 'vitest';
import {
  resetFastPathStateForTests,
  shouldJournalLeaderSeenSkip,
  streamObservabilitySnapshot,
} from '../../src/milddip/fast-path.js';
import { mildDipPriceRing } from '../../src/milddip/price-ring.js';

describe('leader-seen observability', () => {
  it('includes stream metrics in the enriched snapshot', () => {
    resetFastPathStateForTests();
    const mint = 'LeaderSeenObservabilityMintxxxxxxxxxxxxxxxxx';
    const nowMs = 1_800_000_000_000;
    mildDipPriceRing.note(mint, 1, { tsMs: nowMs - 120_000, source: 'stream' });
    mildDipPriceRing.note(mint, 2, { tsMs: nowMs - 60_000, source: 'stream' });
    mildDipPriceRing.note(mint, 1.8, { tsMs: nowMs - 1_000, source: 'stream' });

    const snapshot = streamObservabilitySnapshot(mint, 300_000, nowMs, 0.75);
    expect(snapshot).toMatchObject({
      streamPriceUsd: 1.8,
      streamBounceFromTroughPct: 80,
      streamRallyIntoPeakPct: 100,
      streamSampleCount: 3,
      streamOldestSampleAgeMs: 120_000,
      pairAgeHours: 0.75,
    });
    expect(snapshot.streamDumpExtentFromPeakPct).toBeCloseTo(-10, 10);
  });

  it('deduplicates enriched leader-seen skips per mint for one minute', () => {
    resetFastPathStateForTests();
    expect(shouldJournalLeaderSeenSkip('mint', 'entry', 1_000)).toBe(true);
    expect(shouldJournalLeaderSeenSkip('mint', 'entry', 60_999)).toBe(false);
    expect(shouldJournalLeaderSeenSkip('mint', 'entry', 61_000)).toBe(true);
    expect(shouldJournalLeaderSeenSkip('mint', 'fastpath', 1_000)).toBe(true);
    expect(shouldJournalLeaderSeenSkip('mint', 'fastpath_first_touch', 1_000)).toBe(true);
  });
});
