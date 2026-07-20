import { describe, it, expect } from 'vitest';
import {
  resolveLiveOpenPositionMark,
  type ResolveLiveOpenPositionMarkArgs,
} from '../src/live/live-open-position-mark.js';

const base: ResolveLiveOpenPositionMarkArgs = {
  executableUsd: null,
  referenceUsd: null,
  referenceSource: null,
  referenceAgeMs: null,
  referenceMaxStaleMs: 60_000,
  pgMaxAgeMs: 120_000,
  lastObservedUsd: 0.006,
  anchorUsd: 0.0066,
};

describe('resolveLiveOpenPositionMark', () => {
  it('executable wins and is peak-eligible', () => {
    const m = resolveLiveOpenPositionMark({
      ...base,
      executableUsd: 0.0082,
      referenceUsd: 0.0066,
      referenceSource: 'pg_snapshot',
      referenceAgeMs: 5_000,
    });
    expect(m.source).toBe('executable');
    expect(m.markUsd).toBeCloseTo(0.0082);
    expect(m.peakEligible).toBe(true);
  });

  it('Ge87 RCA: fresh aggregator (+24%) is used and peak-eligible even when PG is stale', () => {
    // Real market at 0.008197 (+24% vs 0.006626 avgEntry); PG stale ~24 min.
    const m = resolveLiveOpenPositionMark({
      ...base,
      referenceUsd: 0.008197,
      referenceSource: 'birdeye',
      referenceAgeMs: 8_000,
    });
    expect(m.source).toBe('reference_aggregator');
    expect(m.markUsd).toBeCloseTo(0.008197);
    expect(m.peakEligible).toBe(true);
  });

  it('dexscreener fresh aggregator is peak-eligible', () => {
    const m = resolveLiveOpenPositionMark({
      ...base,
      referenceUsd: 0.0079,
      referenceSource: 'dexscreener',
      referenceAgeMs: 3_000,
    });
    expect(m.source).toBe('reference_aggregator');
    expect(m.peakEligible).toBe(true);
  });

  it('stale aggregator quote is dropped → hold, not peak-eligible', () => {
    const m = resolveLiveOpenPositionMark({
      ...base,
      referenceUsd: 0.0079,
      referenceSource: 'birdeye',
      referenceAgeMs: 120_000, // > referenceMaxStaleMs 60s
    });
    expect(m.source).toBe('hold');
    expect(m.markUsd).toBeCloseTo(0.006); // lastObserved
    expect(m.peakEligible).toBe(false);
    expect(m.reason).toBe('reference_stale_hold');
  });

  it('fresh PG drives the mark but is NOT peak-eligible (no phantom TP from pool-mid wick)', () => {
    const m = resolveLiveOpenPositionMark({
      ...base,
      referenceUsd: 0.0067,
      referenceSource: 'pg_snapshot',
      referenceAgeMs: 30_000,
    });
    expect(m.source).toBe('pg_fresh');
    expect(m.markUsd).toBeCloseTo(0.0067);
    expect(m.peakEligible).toBe(false);
  });

  it('fresh PG downside still flows as the mark (kill can evaluate)', () => {
    const m = resolveLiveOpenPositionMark({
      ...base,
      referenceUsd: 0.004, // -40% vs anchor
      referenceSource: 'pg_snapshot',
      referenceAgeMs: 20_000,
    });
    expect(m.source).toBe('pg_fresh');
    expect(m.markUsd).toBeCloseTo(0.004);
    expect(m.peakEligible).toBe(false);
  });

  it('stale PG is dropped → hold at last observed, never the stale price', () => {
    const m = resolveLiveOpenPositionMark({
      ...base,
      referenceUsd: 0.0066,
      referenceSource: 'pg_snapshot',
      referenceAgeMs: 1_440_000, // 24 min — Ge87 stale PG
    });
    expect(m.source).toBe('hold');
    expect(m.markUsd).toBeCloseTo(0.006);
    expect(m.peakEligible).toBe(false);
  });

  it('no reference and no last observed → falls to anchor, hold', () => {
    const m = resolveLiveOpenPositionMark({
      ...base,
      referenceUsd: null,
      referenceSource: null,
      referenceAgeMs: null,
      lastObservedUsd: null,
    });
    expect(m.source).toBe('hold');
    expect(m.markUsd).toBeCloseTo(0.0066); // anchor
    expect(m.reason).toBe('no_reference_hold');
  });

  it('null referenceAgeMs treats aggregator as fresh (age unknown, source trusted)', () => {
    const m = resolveLiveOpenPositionMark({
      ...base,
      referenceUsd: 0.0079,
      referenceSource: 'birdeye',
      referenceAgeMs: null,
    });
    expect(m.source).toBe('reference_aggregator');
    expect(m.peakEligible).toBe(true);
  });
});
