import { describe, expect, it } from 'vitest';
import {
  evaluateMildStabilizeFromRing,
  mildStabilizeLaneAllowed,
  mildStabilizeScaleInOk,
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

  it('BJWHLm deep post-entry knife + reclaim passes scale-in dump floor −50', () => {
    // Live yEfT5N…: peak→trough ≈ −36%, bounce ≈ +4%. Fresh floor −25 rejected;
    // scale-in floor −50 must accept (user: second clip on stabilize after knife).
    const liveMint = 'BJWHLmtbabbby7LstVRvo4Q39oER9C1TrzR3gpTHpump';
    const entry = 0.00041570487962850624;
    const buyTs = 1_786_134_405_311;
    const r = new MildDipPriceRing({ maxSamplesPerMint: 60, ttlMs: 3_600_000 });
    r.note(liveMint, 0.0004155, { tsMs: buyTs + 15_000, source: 'dex' }); // post-entry peak
    r.note(liveMint, 0.0002635, { tsMs: buyTs + 522_000, source: 'dex' }); // trough −36.6%
    r.note(liveMint, 0.0002743, { tsMs: buyTs + 551_000, source: 'dex' }); // +4.1% reclaim
    const nowMs = buyTs + 580_000;
    const fresh = evaluateMildStabilizeFromRing(r, liveMint, nowMs, gates);
    expect(fresh.pass).toBe(false);
    expect(fresh.reasons.some((x) => x.startsWith('mild_stabilize_dump='))).toBe(true);
    const scaleGates = { ...gates, minDumpPct: -50 };
    const v = evaluateMildStabilizeFromRing(r, liveMint, nowMs, scaleGates);
    expect(v.pass).toBe(true);
    expect(
      mildStabilizeScaleInOk({
        entryPriceUsd: entry,
        troughPriceUsd: v.troughPriceUsd,
        troughAtMs: v.troughAtMs,
        openedAtMs: buyTs,
        markPriceUsd: 0.0002743,
        minDumpBelowEntryPct: 3,
      }).pass,
    ).toBe(true);
  });

  it('9nXkTP / 5vuKy3b mark path qualifies for second clip', () => {
    // Live marks after fast buy: dump to −17.75% then reclaim ~5% off trough.
    // Scale-in never fired because open mint was not scanned — gates themselves pass.
    const liveMint = '9nXkTPZETP9hrntNYgxQSeDzwbhrExhFqKJPb5Z6pump';
    const entry = 0.0002448626201785715;
    const buyTs = 1_786_128_740_862;
    const r = new MildDipPriceRing({ maxSamplesPerMint: 60, ttlMs: 3_600_000 });
    r.note(liveMint, 0.0002479, { tsMs: buyTs + 13_000, source: 'dex' });
    r.note(liveMint, 0.0002484, { tsMs: buyTs + 78_000, source: 'dex' }); // local peak
    r.note(liveMint, 0.0002145, { tsMs: buyTs + 121_000, source: 'dex' });
    r.note(liveMint, 0.0002068, { tsMs: buyTs + 305_000, source: 'dex' });
    r.note(liveMint, 0.0002014, { tsMs: buyTs + 339_000, source: 'dex' }); // trough
    r.note(liveMint, 0.0002044, { tsMs: buyTs + 378_000, source: 'dex' });
    r.note(liveMint, 0.0002113, { tsMs: buyTs + 422_000, source: 'dex' }); // bounce ~4.9%
    const nowMs = buyTs + 422_000;
    const v = evaluateMildStabilizeFromRing(r, liveMint, nowMs, gates);
    expect(v.pass).toBe(true);
    expect(
      mildStabilizeScaleInOk({
        entryPriceUsd: entry,
        troughPriceUsd: v.troughPriceUsd,
        troughAtMs: v.troughAtMs,
        openedAtMs: buyTs,
        markPriceUsd: 0.0002113,
        minDumpBelowEntryPct: 3,
      }).pass,
    ).toBe(true);
  });
});

describe('mildStabilizeLaneAllowed', () => {
  it('live default: scale-in only (no fresh green-candle seats)', () => {
    expect(
      mildStabilizeLaneAllowed({
        enabled: true,
        freshEntryEnabled: false,
        mildStabilizeOnly: false,
        hasOtherDipSource: false,
      }),
    ).toBe(false);
    expect(
      mildStabilizeLaneAllowed({
        enabled: true,
        freshEntryEnabled: false,
        mildStabilizeOnly: true,
        hasOtherDipSource: false,
      }),
    ).toBe(true);
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

  it('rejects HuZ2yj same-price second clip (trough before entry / mark at entry)', () => {
    // 5HaLZz first clip @ 0.0004848; 29s later 4CCSBX scale-in @ ~same print.
    // Ring dump was the *first* buy's dump — trough before openedAt; mark ~entry.
    const entry = 0.00048476520390222953;
    const openedAtMs = 1_786_130_025_595;
    const trough = 0.0004635; // ~4.4% below entry — old trough-only guard would pass
    const troughAtMs = openedAtMs - 5_000;
    const markAtEntry = 0.00048421047229726917;
    expect(
      mildStabilizeScaleInOk({
        entryPriceUsd: entry,
        troughPriceUsd: trough,
        troughAtMs,
        openedAtMs,
        markPriceUsd: markAtEntry,
        minDumpBelowEntryPct: 3,
      }).pass,
    ).toBe(false);
    expect(
      mildStabilizeScaleInOk({
        entryPriceUsd: entry,
        troughPriceUsd: trough,
        troughAtMs,
        openedAtMs,
        markPriceUsd: markAtEntry,
        minDumpBelowEntryPct: 3,
      }).reason,
    ).toMatch(/trough_before_entry/);

    // Even with a post-entry trough, reclaim-to-entry mark must fail avg-down.
    expect(
      mildStabilizeScaleInOk({
        entryPriceUsd: entry,
        troughPriceUsd: trough,
        troughAtMs: openedAtMs + 20_000,
        openedAtMs,
        markPriceUsd: markAtEntry,
        minDumpBelowEntryPct: 3,
      }).reason,
    ).toMatch(/scale_in_mark=/);

    // Real avg-down: post-entry trough + mark still ≥3% below entry.
    expect(
      mildStabilizeScaleInOk({
        entryPriceUsd: entry,
        troughPriceUsd: trough,
        troughAtMs: openedAtMs + 20_000,
        openedAtMs,
        markPriceUsd: entry * 0.96,
        minDumpBelowEntryPct: 3,
      }).pass,
    ).toBe(true);
  });
});
