import { describe, expect, it } from 'vitest';
import {
  liveTrackerMtmUsdPreferSnapshotOnUpwardGhost,
  liveTrackerMtmUsdSnapJupiterSymmetricBand,
} from '../src/live/mtm-snapshot-guard.js';

describe('liveTrackerMtmUsdSnapJupiterSymmetricBand', () => {
  it('uses Jupiter when within symmetric band vs snapshot', () => {
    const snap = 0.005821;
    const jup = snap * 1.04; // +4%
    const r = liveTrackerMtmUsdSnapJupiterSymmetricBand({
      snapPx: snap,
      jupiterPx: jup,
      maxPremiumOverSnapshotPct: 6,
    });
    expect(r.clampedFromJupiter).toBe(false);
    expect(r.bandClamp).toBe(null);
    expect(r.useUsd).toBeCloseTo(jup, 12);
  });

  it('clamps to snapshot when Jupiter exceeds upper cap (BULL-style ghost ~+13%)', () => {
    const snap = 0.005821;
    const jup = 0.006595;
    const r = liveTrackerMtmUsdSnapJupiterSymmetricBand({
      snapPx: snap,
      jupiterPx: jup,
      maxPremiumOverSnapshotPct: 6,
    });
    expect(r.clampedFromJupiter).toBe(true);
    expect(r.bandClamp).toBe('high');
    expect(r.useUsd).toBe(snap);
  });

  it('clamps to snapshot when Jupiter is below symmetric discount floor (snap / (1+p%))', () => {
    const snap = 0.01448;
    const floor = snap / 1.06; // ~0.013660 — strictly below this triggers low clamp at p=6
    const jup = floor * 0.998;
    const r = liveTrackerMtmUsdSnapJupiterSymmetricBand({
      snapPx: snap,
      jupiterPx: jup,
      maxPremiumOverSnapshotPct: 6,
    });
    expect(r.clampedFromJupiter).toBe(true);
    expect(r.bandClamp).toBe('low');
    expect(r.useUsd).toBe(snap);
  });

  it('disabled when max premium is 0', () => {
    const snap = 0.005821;
    const jup = 0.006595;
    const r = liveTrackerMtmUsdSnapJupiterSymmetricBand({
      snapPx: snap,
      jupiterPx: jup,
      maxPremiumOverSnapshotPct: 0,
    });
    expect(r.clampedFromJupiter).toBe(false);
    expect(r.bandClamp).toBe(null);
    expect(r.useUsd).toBe(jup);
  });

  it('uses Jupiter when snapshot missing', () => {
    const r = liveTrackerMtmUsdSnapJupiterSymmetricBand({
      snapPx: 0,
      jupiterPx: 0.006595,
      maxPremiumOverSnapshotPct: 6,
    });
    expect(r.clampedFromJupiter).toBe(false);
    expect(r.bandClamp).toBe(null);
    expect(r.useUsd).toBe(0.006595);
  });
});

describe('liveTrackerMtmUsdPreferSnapshotOnUpwardGhost (alias)', () => {
  it('matches symmetric band (backward-compatible export)', () => {
    const snap = 0.01448;
    const args = {
      snapPx: snap,
      jupiterPx: (snap / 1.06) * 0.998,
      maxPremiumOverSnapshotPct: 6,
    };
    expect(liveTrackerMtmUsdPreferSnapshotOnUpwardGhost(args)).toEqual(
      liveTrackerMtmUsdSnapJupiterSymmetricBand(args),
    );
  });
});
