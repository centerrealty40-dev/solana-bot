import { describe, expect, it } from 'vitest';
import {
  pickJupiterExecutablePx,
  rejectPgSnapshotWickHighForMtm,
  resolveLiveExitMtmMark,
} from '../src/live/live-exit-mtm.js';

describe('rejectPgSnapshotWickHighForMtm', () => {
  it('CHANCE regression: fresh PG wick far above executable sell is dropped', () => {
    const r = rejectPgSnapshotWickHighForMtm({
      snapPx: 0.002883,
      executablePx: 0.001773,
      maxPremiumOverExecutablePct: 6,
    });
    expect(r.rejected).toBe(true);
    expect(r.reason).toBe('wick_high');
    expect(r.snapPx).toBe(0);
  });
});

describe('pickJupiterExecutablePx', () => {
  it('prefers sell-probe over buy-probe', () => {
    expect(
      pickJupiterExecutablePx({ jupiterSellPx: 0.00177, jupiterBuyPx: 0.00185 }).source,
    ).toBe('sell');
  });
});

describe('resolveLiveExitMtmMark', () => {
  it('CHANCE regression: PG wick must not arm peak; exit uses executable sell', () => {
    const r = resolveLiveExitMtmMark({
      snapPx: 0.002883,
      jupiterSellPx: 0.001773,
      jupiterBuyPx: 0.001821,
      maxPremiumOverSnapshotPct: 6,
      anchorPx: 0.001821,
    });
    expect(r.pgRejected).toBe(true);
    expect(r.exitMtmUsd).toBeCloseTo(0.001773, 8);
    expect(r.peakMtmUsd).toBeCloseTo(0.001773, 8);
    expect(r.peakMtmUsd).toBeLessThan(0.002);
  });

  it('Cupsey regression: stale-low PG below entry while Jupiter sell above entry → trust Jupiter', () => {
    const anchor = 0.006326;
    const snap = 0.00584;
    const jupSell = 0.0074;
    const r = resolveLiveExitMtmMark({
      snapPx: snap,
      jupiterSellPx: jupSell,
      jupiterBuyPx: jupSell,
      maxPremiumOverSnapshotPct: 6,
      anchorPx: anchor,
    });
    expect(r.bandClamp).toBe('anchor_stale_low');
    expect(r.exitMtmUsd).toBe(jupSell);
    expect(r.peakMtmUsd).toBe(jupSell);
    expect(r.exitMtmUsd / anchor - 1).toBeGreaterThan(0.08);
  });

  it('USDUC regression: stale high PG must not imply phantom TP when sell is flat', () => {
    const avgEntry = 0.0052646;
    const snap = 0.00569;
    const jupSell = 0.00527;
    const r = resolveLiveExitMtmMark({
      snapPx: snap,
      jupiterSellPx: jupSell,
      jupiterBuyPx: jupSell,
      maxPremiumOverSnapshotPct: 6,
    });
    expect(r.exitMtmUsd).toBe(jupSell);
    expect(r.exitMtmUsd / avgEntry - 1).toBeLessThan(0.05);
  });

  it('without executable quotes: no exit MTM and no peak advance', () => {
    const r = resolveLiveExitMtmMark({
      snapPx: 0.002883,
      jupiterSellPx: null,
      jupiterBuyPx: null,
      maxPremiumOverSnapshotPct: 6,
    });
    expect(r.exitMtmUsd).toBe(0);
    expect(r.peakMtmUsd).toBe(0);
  });

  it('buy-only probe may drive exit MTM but must not advance peak', () => {
    const r = resolveLiveExitMtmMark({
      snapPx: 0.0018,
      jupiterSellPx: null,
      jupiterBuyPx: 0.00175,
      maxPremiumOverSnapshotPct: 6,
    });
    expect(r.exitMtmUsd).toBeGreaterThan(0);
    expect(r.peakMtmUsd).toBe(0);
  });
});
