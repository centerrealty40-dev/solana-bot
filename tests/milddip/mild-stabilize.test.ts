import { describe, expect, it } from 'vitest';
import {
  evaluateMildStabilizeFromRing,
  mildStabilizeScaleInOk,
} from '../../src/milddip/mild-stabilize.js';
import { MildDipPriceRing } from '../../src/milddip/price-ring.js';

describe('evaluateMildStabilizeFromRing', () => {
  const mint = 'BBhTbMvpQMgsoMdhHC4RQaw66aDGFr4QuHZxKdmxpump';
  const t0 = 1_700_000_000_000;
  const gates = {
    enabled: true,
    minDumpPct: -25,
    maxDumpPct: -5,
    minBouncePct: 1.5,
    maxBouncePct: 8,
    troughMinAgeMs: 15_000,
    lookbackMs: 600_000,
    scaleInMinDumpBelowEntryPct: 3,
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
});

describe('mildStabilizeScaleInOk', () => {
  it('requires trough below entry by min %', () => {
    expect(
      mildStabilizeScaleInOk({
        entryPriceUsd: 1.0,
        troughPriceUsd: 0.98, // only −2%
        minDumpBelowEntryPct: 3,
      }).pass,
    ).toBe(false);
    expect(
      mildStabilizeScaleInOk({
        entryPriceUsd: 1.0,
        troughPriceUsd: 0.98,
        minDumpBelowEntryPct: 3,
      }).reason,
    ).toMatch(/scale_in_dump/);
    expect(
      mildStabilizeScaleInOk({
        entryPriceUsd: 1.0,
        troughPriceUsd: 0.95, // −5%
        minDumpBelowEntryPct: 3,
      }).pass,
    ).toBe(true);
  });
});
