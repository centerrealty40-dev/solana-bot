import { describe, expect, it } from 'vitest';
import {
  buildPricePrimaryEvent,
  resolvePrimaryPriceUsd,
} from '../src/papertrader/stream/price-primary.js';

const NOW = 1_000_000;

describe('resolvePrimaryPriceUsd — OFF path is a byte-identical PG passthrough', () => {
  it('returns the baseline price verbatim with source=pg when disabled (even with a fresh stream)', () => {
    const r = resolvePrimaryPriceUsd({
      enabled: false,
      pgPriceUsd: 0.0001234,
      streamPriceUsd: 0.0009999,
      streamTsMs: NOW - 100,
      nowMs: NOW,
      maxStaleMs: 5_000,
    });
    expect(r.source).toBe('pg');
    expect(r.priceUsd).toBe(0.0001234);
    expect(r.streamAgeMs).toBeNull();
  });

  it('preserves a null baseline when disabled', () => {
    const r = resolvePrimaryPriceUsd({
      enabled: false,
      pgPriceUsd: null,
      streamPriceUsd: 0.5,
      streamTsMs: NOW,
      nowMs: NOW,
      maxStaleMs: 5_000,
    });
    expect(r.source).toBe('pg');
    expect(r.priceUsd).toBeNull();
  });
});

describe('resolvePrimaryPriceUsd — ON path freshness gate + fallback', () => {
  it('picks a fresh, positive stream price as primary', () => {
    const r = resolvePrimaryPriceUsd({
      enabled: true,
      pgPriceUsd: 0.001,
      streamPriceUsd: 0.0011,
      streamTsMs: NOW - 2_000,
      nowMs: NOW,
      maxStaleMs: 5_000,
    });
    expect(r.source).toBe('stream');
    expect(r.priceUsd).toBe(0.0011);
    expect(r.streamAgeMs).toBe(2_000);
  });

  it('falls back to PG when the stream is older than the freshness gate', () => {
    const r = resolvePrimaryPriceUsd({
      enabled: true,
      pgPriceUsd: 0.001,
      streamPriceUsd: 0.0011,
      streamTsMs: NOW - 9_000,
      nowMs: NOW,
      maxStaleMs: 5_000,
    });
    expect(r.source).toBe('pg');
    expect(r.priceUsd).toBe(0.001);
    expect(r.streamAgeMs).toBeNull();
  });

  it('falls back to PG when the stream price is missing', () => {
    const r = resolvePrimaryPriceUsd({
      enabled: true,
      pgPriceUsd: 0.001,
      streamPriceUsd: null,
      streamTsMs: null,
      nowMs: NOW,
      maxStaleMs: 5_000,
    });
    expect(r.source).toBe('pg');
    expect(r.priceUsd).toBe(0.001);
  });

  it('falls back to PG when the stream price is non-positive', () => {
    for (const px of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const r = resolvePrimaryPriceUsd({
        enabled: true,
        pgPriceUsd: 0.001,
        streamPriceUsd: px,
        streamTsMs: NOW - 100,
        nowMs: NOW,
        maxStaleMs: 5_000,
      });
      expect(r.source).toBe('pg');
      expect(r.priceUsd).toBe(0.001);
    }
  });

  it('falls back to PG when the stream timestamp is in the future (clock skew)', () => {
    const r = resolvePrimaryPriceUsd({
      enabled: true,
      pgPriceUsd: 0.001,
      streamPriceUsd: 0.002,
      streamTsMs: NOW + 5_000,
      nowMs: NOW,
      maxStaleMs: 5_000,
    });
    expect(r.source).toBe('pg');
    expect(r.priceUsd).toBe(0.001);
  });

  it('falls back to PG when the freshness gate is non-positive (disabled gate)', () => {
    const r = resolvePrimaryPriceUsd({
      enabled: true,
      pgPriceUsd: 0.001,
      streamPriceUsd: 0.002,
      streamTsMs: NOW,
      nowMs: NOW,
      maxStaleMs: 0,
    });
    expect(r.source).toBe('pg');
    expect(r.priceUsd).toBe(0.001);
  });

  it('accepts a stream price exactly at the gate boundary', () => {
    const r = resolvePrimaryPriceUsd({
      enabled: true,
      pgPriceUsd: 0.001,
      streamPriceUsd: 0.002,
      streamTsMs: NOW - 5_000,
      nowMs: NOW,
      maxStaleMs: 5_000,
    });
    expect(r.source).toBe('stream');
    expect(r.priceUsd).toBe(0.002);
  });

  it('picks the stream even when PG is missing, as long as the stream is fresh', () => {
    const r = resolvePrimaryPriceUsd({
      enabled: true,
      pgPriceUsd: null,
      streamPriceUsd: 0.002,
      streamTsMs: NOW - 1_000,
      nowMs: NOW,
      maxStaleMs: 5_000,
    });
    expect(r.source).toBe('stream');
    expect(r.priceUsd).toBe(0.002);
  });
});

describe('buildPricePrimaryEvent', () => {
  it('records the chosen stream price, baseline, and signed % diff', () => {
    const ev = buildPricePrimaryEvent({
      mint: 'Mint11111111111111111111111111111111111111',
      lane: 'mtm',
      surface: 'mtm',
      baselinePriceUsd: 0.001,
      streamPriceUsd: 0.0011,
      streamTsMs: NOW - 1_000,
      streamAgeMs: 1_000,
      nowMs: NOW,
      streamSlot: 42,
    });
    expect(ev.kind).toBe('live_shyft_price_primary');
    expect(ev.source).toBe('stream');
    expect(ev.baselinePriceUsd).toBe(0.001);
    expect(ev.streamPriceUsd).toBe(0.0011);
    expect(ev.streamVsBaselinePct).toBeCloseTo(10, 6);
    expect(ev.streamSlot).toBe(42);
  });

  it('reports a null %diff when there is no positive baseline', () => {
    const ev = buildPricePrimaryEvent({
      mint: 'Mint11111111111111111111111111111111111111',
      lane: 'entry',
      surface: 'entry',
      baselinePriceUsd: null,
      streamPriceUsd: 0.0011,
      streamTsMs: NOW,
      streamAgeMs: 0,
      nowMs: NOW,
    });
    expect(ev.baselinePriceUsd).toBeNull();
    expect(ev.streamVsBaselinePct).toBeNull();
    expect('streamSlot' in ev).toBe(false);
  });
});
