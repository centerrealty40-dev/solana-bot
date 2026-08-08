import { describe, expect, it } from 'vitest';
import {
  evaluateMildStabilizeFromRing,
  mildStabilizeLaneAllowed,
} from '../../src/milddip/mild-stabilize.js';
import { MildDipPriceRing } from '../../src/milddip/price-ring.js';

describe('evaluateMildStabilizeFromRing', () => {
  const mint = 'BBhTbMvpQMgsoMdhHC4RQaw66aDGFr4QuHZxKdmxpump';
  const t0 = 1_700_000_000_000;
  const gates = {
    enabled: true,
    minDumpPct: -25,
    maxDumpPct: -8,
    minBouncePct: 1.5,
    maxBouncePct: 8,
    troughMinAgeMs: 15_000,
    lookbackMs: 600_000,
    minBelowPeakPct: 2,
  };

  it('passes dump then bounce (leader-style RRG)', () => {
    const r = new MildDipPriceRing({ maxSamplesPerMint: 60, ttlMs: 3_600_000 });
    r.note(mint, 1.0, { tsMs: t0, source: 'stream' }); // peak
    r.note(mint, 0.92, { tsMs: t0 + 60_000, source: 'stream' }); // dump −8%
    r.note(mint, 0.9, { tsMs: t0 + 90_000, source: 'stream' }); // trough −10%
    r.note(mint, 0.945, { tsMs: t0 + 120_000, source: 'stream' }); // bounce +5% off trough
    const v = evaluateMildStabilizeFromRing(r, mint, t0 + 120_000, gates);
    expect(v.pass).toBe(true);
    expect(v.dumpPct).toBeLessThanOrEqual(-5);
    expect(v.bouncePct).toBeGreaterThanOrEqual(1.5);
  });

  it('rejects trough that is too fresh', () => {
    const r = new MildDipPriceRing({ maxSamplesPerMint: 60, ttlMs: 3_600_000 });
    r.note(mint, 1.0, { tsMs: t0, source: 'stream' });
    r.note(mint, 0.9, { tsMs: t0 + 90_000, source: 'stream' });
    r.note(mint, 0.945, { tsMs: t0 + 95_000, source: 'stream' });
    const v = evaluateMildStabilizeFromRing(r, mint, t0 + 95_000, gates);
    expect(v.pass).toBe(false);
    expect(v.reasons.some((x) => x.startsWith('mild_stabilize_trough_age='))).toBe(true);
  });

  it('rejects chase bounce > max', () => {
    const r = new MildDipPriceRing({ maxSamplesPerMint: 60, ttlMs: 3_600_000 });
    r.note(mint, 1.0, { tsMs: t0, source: 'stream' });
    r.note(mint, 0.9, { tsMs: t0 + 90_000, source: 'stream' });
    r.note(mint, 1.0, { tsMs: t0 + 120_000, source: 'stream' }); // +11% off trough
    const v = evaluateMildStabilizeFromRing(r, mint, t0 + 120_000, gates);
    expect(v.pass).toBe(false);
  });

  it('rejects Gymbmn micro-dip green reclaim to peak (25rbPvD)', () => {
    // Live: dump −5.17% then bounce +5.29% → last ~0.15% below peak.
    const live = 'Gymbmn9wwMKe4NnmVceyyfpncp9arbwPfSdBsyY9pump';
    const r = new MildDipPriceRing({ maxSamplesPerMint: 60, ttlMs: 3_600_000 });
    r.note(live, 0.0007212, { tsMs: t0, source: 'stream' });
    r.note(live, 0.0006839, { tsMs: t0 + 60_000, source: 'stream' });
    r.note(live, 0.0007201, { tsMs: t0 + 90_000, source: 'stream' });
    const v = evaluateMildStabilizeFromRing(r, live, t0 + 90_000, gates);
    expect(v.pass).toBe(false);
    expect(
      v.reasons.some(
        (x) => x.startsWith('mild_stabilize_dump=') || x.startsWith('mild_stabilize_below_peak='),
      ),
    ).toBe(true);
  });
});

describe('mildStabilizeLaneAllowed', () => {
  it('live default: fresh seats off', () => {
    expect(
      mildStabilizeLaneAllowed({
        enabled: true,
        freshEntryEnabled: false,
        hasOtherDipSource: false,
      }),
    ).toBe(false);
  });

  it('allows fresh when enabled and no other dip source', () => {
    expect(
      mildStabilizeLaneAllowed({
        enabled: true,
        freshEntryEnabled: true,
        hasOtherDipSource: false,
      }),
    ).toBe(true);
    expect(
      mildStabilizeLaneAllowed({
        enabled: true,
        freshEntryEnabled: true,
        hasOtherDipSource: true,
      }),
    ).toBe(false);
  });
});
