import { describe, expect, it } from 'vitest';
import {
  evaluateMildStabilizeFromRing,
  mildStabilizeDexDipOk,
  mildStabilizeLaneAllowed,
  mildStabilizeSkipTelemetryEligible,
  __resetMildStabilizeBudgetsForTests,
  takeMildStabilizeAttemptSlot,
  takeMildStabilizeSkipTelemetrySlot,
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

  it('accepts a trough held for the configured live minute', () => {
    const r = new MildDipPriceRing({ maxSamplesPerMint: 60, ttlMs: 3_600_000 });
    r.note(mint, 1.0, { tsMs: t0, source: 'stream' });
    r.note(mint, 0.9, { tsMs: t0 + 90_000, source: 'stream' });
    r.note(mint, 0.945, { tsMs: t0 + 150_000, source: 'stream' });
    const v = evaluateMildStabilizeFromRing(r, mint, t0 + 150_000, {
      ...gates,
      troughMinAgeMs: 60_000,
    });
    expect(v.pass).toBe(true);
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

describe('mild_stabilize rolling hourly buy cap', () => {
  it('allows under the cap, blocks at the cap, and allows after the window rolls', () => {
    __resetMildStabilizeBudgetsForTests();
    const t0 = 1_700_000_000_000;
    expect(takeMildStabilizeAttemptSlot(2, t0).allowed).toBe(true);
    expect(takeMildStabilizeAttemptSlot(2, t0 + 1).allowed).toBe(true);
    expect(takeMildStabilizeAttemptSlot(2, t0 + 2)).toMatchObject({
      allowed: false,
      count: 2,
      limit: 2,
    });
    expect(takeMildStabilizeAttemptSlot(2, t0 + 3_600_002)).toMatchObject({
      allowed: true,
      count: 1,
      limit: 2,
    });
    __resetMildStabilizeBudgetsForTests();
  });
});

describe('mild_stabilize skip telemetry budget', () => {
  it('rate-limits failed-verdict telemetry in a rolling hour', () => {
    __resetMildStabilizeBudgetsForTests();
    const t0 = 1_700_000_000_000;
    expect(takeMildStabilizeSkipTelemetrySlot(2, t0)).toBe(true);
    expect(takeMildStabilizeSkipTelemetrySlot(2, t0 + 1)).toBe(true);
    expect(takeMildStabilizeSkipTelemetrySlot(2, t0 + 2)).toBe(false);
    expect(takeMildStabilizeSkipTelemetrySlot(2, t0 + 3_600_002)).toBe(true);
    __resetMildStabilizeBudgetsForTests();
  });
});

describe('mild_stabilize skip telemetry filters', () => {
  it('drops shallow and implausible ring verdicts before reserving a slot', () => {
    __resetMildStabilizeBudgetsForTests();
    const filter = (dumpPct: number, troughAgeMs: number | null) =>
      mildStabilizeSkipTelemetryEligible({
        pass: false,
        reasons: ['mild_stabilize_bounce=0.00_outside'],
        dumpPct,
        troughAgeMs,
        minDumpPct: -3,
      });
    const reserveIfEligible = (dumpPct: number, troughAgeMs: number | null) =>
      filter(dumpPct, troughAgeMs) &&
      takeMildStabilizeSkipTelemetrySlot(1, 1_700_000_000_000);

    expect(reserveIfEligible(-0.97, 30_000)).toBe(false);
    expect(reserveIfEligible(-96.8, 0)).toBe(false);
    expect(takeMildStabilizeSkipTelemetrySlot(1, 1_700_000_000_000)).toBe(true);
    __resetMildStabilizeBudgetsForTests();
  });

  it('retains genuine failed verdicts and reserves their journal slot', () => {
    __resetMildStabilizeBudgetsForTests();
    expect(
      mildStabilizeSkipTelemetryEligible({
        pass: false,
        reasons: ['mild_stabilize_bounce=0.00_outside'],
        dumpPct: -12,
        troughAgeMs: 30_000,
        minDumpPct: -3,
      }),
    ).toBe(true);
    expect(takeMildStabilizeSkipTelemetrySlot(1, 1_700_000_000_000)).toBe(true);
    expect(takeMildStabilizeSkipTelemetrySlot(1, 1_700_000_000_001)).toBe(false);
    __resetMildStabilizeBudgetsForTests();
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

describe('mildStabilizeDexDipOk (1.11.800 EjD5Y9)', () => {
  it('blocks green / flat Dex even when ring bounce looks fine', () => {
    expect(
      mildStabilizeDexDipOk({ requireDexDip: true, dexPc5m: 4.91, dexMaxDipPct: -2 }),
    ).toBe(false);
    expect(
      mildStabilizeDexDipOk({ requireDexDip: true, dexPc5m: -0.5, dexMaxDipPct: -2 }),
    ).toBe(false);
    expect(
      mildStabilizeDexDipOk({ requireDexDip: true, dexPc5m: null, dexMaxDipPct: -2 }),
    ).toBe(false);
  });

  it('allows when Dex still dumping', () => {
    expect(
      mildStabilizeDexDipOk({ requireDexDip: true, dexPc5m: -8.4, dexMaxDipPct: -2 }),
    ).toBe(true);
    expect(
      mildStabilizeDexDipOk({ requireDexDip: false, dexPc5m: 4.91, dexMaxDipPct: -2 }),
    ).toBe(true);
  });
});
