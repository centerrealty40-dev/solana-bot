import { describe, expect, it } from 'vitest';
import { liveTrackerMtmUsdPreferSnapshotOnUpwardGhost } from '../src/live/mtm-snapshot-guard.js';

describe('liveTrackerMtmUsdPreferSnapshotOnUpwardGhost', () => {
  it('uses Jupiter when within premium cap vs snapshot', () => {
    const snap = 0.005821;
    const jup = snap * 1.04; // +4%
    const r = liveTrackerMtmUsdPreferSnapshotOnUpwardGhost({
      snapPx: snap,
      jupiterPx: jup,
      maxPremiumOverSnapshotPct: 6,
    });
    expect(r.clampedFromJupiter).toBe(false);
    expect(r.useUsd).toBeCloseTo(jup, 12);
  });

  it('clamps to snapshot when Jupiter exceeds cap (BULL-style ghost ~+13%)', () => {
    const snap = 0.005821;
    const jup = 0.006595;
    const r = liveTrackerMtmUsdPreferSnapshotOnUpwardGhost({
      snapPx: snap,
      jupiterPx: jup,
      maxPremiumOverSnapshotPct: 6,
    });
    expect(r.clampedFromJupiter).toBe(true);
    expect(r.useUsd).toBe(snap);
  });

  it('disabled when max premium is 0', () => {
    const snap = 0.005821;
    const jup = 0.006595;
    const r = liveTrackerMtmUsdPreferSnapshotOnUpwardGhost({
      snapPx: snap,
      jupiterPx: jup,
      maxPremiumOverSnapshotPct: 0,
    });
    expect(r.clampedFromJupiter).toBe(false);
    expect(r.useUsd).toBe(jup);
  });

  it('uses Jupiter when snapshot missing', () => {
    const r = liveTrackerMtmUsdPreferSnapshotOnUpwardGhost({
      snapPx: 0,
      jupiterPx: 0.006595,
      maxPremiumOverSnapshotPct: 6,
    });
    expect(r.clampedFromJupiter).toBe(false);
    expect(r.useUsd).toBe(0.006595);
  });
});
