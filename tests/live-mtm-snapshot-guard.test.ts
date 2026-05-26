import { describe, expect, it } from 'vitest';
import {
  liveTrackerMtmUsdPreferSnapshotOnUpwardGhost,
  liveTrackerMtmUsdSnapJupiterSymmetricBand,
} from '../src/live/mtm-snapshot-guard.js';

describe('liveTrackerMtmUsdSnapJupiterSymmetricBand', () => {
  it('uses min(snapshot,Jupiter) when Jupiter is above snapshot but within band', () => {
    const snap = 0.005821;
    const jup = snap * 1.04; // +4%
    const r = liveTrackerMtmUsdSnapJupiterSymmetricBand({
      snapPx: snap,
      jupiterPx: jup,
      maxPremiumOverSnapshotPct: 6,
    });
    expect(r.clampedFromJupiter).toBe(true);
    expect(r.bandClamp).toBe(null);
    expect(r.useUsd).toBeCloseTo(snap, 12);
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

  it('uses Jupiter when below symmetric discount floor (stale high PG snapshot)', () => {
    const snap = 0.00569;
    const jup = 0.00527;
    const r = liveTrackerMtmUsdSnapJupiterSymmetricBand({
      snapPx: snap,
      jupiterPx: jup,
      maxPremiumOverSnapshotPct: 6,
    });
    expect(r.clampedFromJupiter).toBe(true);
    expect(r.bandClamp).toBe('low');
    expect(r.useUsd).toBe(jup);
  });

  it('USDUC regression: stale snapshot must not imply +8% TP when Jupiter is flat at entry', () => {
    const avgEntry = 0.0052646;
    const snap = 0.00569;
    const jup = 0.00527;
    const r = liveTrackerMtmUsdSnapJupiterSymmetricBand({
      snapPx: snap,
      jupiterPx: jup,
      maxPremiumOverSnapshotPct: 6,
    });
    expect(r.useUsd).toBe(jup);
    const pnlFrac = r.useUsd / avgEntry - 1;
    expect(pnlFrac).toBeLessThan(0.05);
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
