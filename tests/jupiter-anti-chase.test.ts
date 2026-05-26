/** 1.11.234 — unit tests для anti-chase guard helpers (tokensPerInLamportFromQuote + isBuyQuoteChasingAnchor). */
import { describe, expect, it } from 'vitest';
import {
  isBuyQuoteChasingAnchor,
  tokensPerInLamportFromQuote,
} from '../src/live/jupiter.js';

describe('tokensPerInLamportFromQuote', () => {
  it('returns null on missing input', () => {
    expect(tokensPerInLamportFromQuote(null)).toBeNull();
    expect(tokensPerInLamportFromQuote(undefined)).toBeNull();
    expect(tokensPerInLamportFromQuote({})).toBeNull();
  });

  it('parses string inAmount/outAmount', () => {
    // 1 SOL (1e9 lamports) → 1000 tokens (raw 1000 * 1e6 = 1e9 if decimals=6, но это relative ratio)
    // outAmount=1_000_000_000, inAmount=1_000_000_000 → ratio = 1.0
    const r = tokensPerInLamportFromQuote({
      inAmount: '1000000000',
      outAmount: '1000000000',
    });
    expect(r).toBe(1);
  });

  it('parses numeric inAmount/outAmount', () => {
    const r = tokensPerInLamportFromQuote({ inAmount: 500_000_000, outAmount: 1_000_000_000 });
    expect(r).toBe(2);
  });

  it('returns null for non-numeric/negative values', () => {
    expect(tokensPerInLamportFromQuote({ inAmount: 'abc', outAmount: '100' })).toBeNull();
    expect(tokensPerInLamportFromQuote({ inAmount: '-1', outAmount: '100' })).toBeNull();
    expect(tokensPerInLamportFromQuote({ inAmount: '0', outAmount: '100' })).toBeNull();
  });
});

describe('isBuyQuoteChasingAnchor', () => {
  it('returns chased=false when maxChasePct <= 0 (off)', () => {
    const r = isBuyQuoteChasingAnchor({
      anchorTokensPerLamport: 100,
      currentTokensPerLamport: 50,
      maxChasePct: 0,
    });
    expect(r.chased).toBe(false);
  });

  it('returns chased=false on null inputs', () => {
    const r = isBuyQuoteChasingAnchor({
      anchorTokensPerLamport: null,
      currentTokensPerLamport: 50,
      maxChasePct: 3,
    });
    expect(r.chased).toBe(false);
  });

  it('detects chase when tokensPerLamport drops (price went up)', () => {
    // anchor=1000 tokens/lamport, current=950 tokens/lamport
    // chasePct = (1000/950 - 1) * 100 ≈ +5.26%
    const r = isBuyQuoteChasingAnchor({
      anchorTokensPerLamport: 1000,
      currentTokensPerLamport: 950,
      maxChasePct: 3,
    });
    expect(r.chased).toBe(true);
    expect(r.chasePct).toBeCloseTo(5.263, 1);
  });

  it('does NOT trigger when chase is below limit', () => {
    // anchor=1000, current=985 → ~+1.5% (below 3% limit)
    const r = isBuyQuoteChasingAnchor({
      anchorTokensPerLamport: 1000,
      currentTokensPerLamport: 985,
      maxChasePct: 3,
    });
    expect(r.chased).toBe(false);
    expect(r.chasePct).toBeCloseTo(1.523, 1);
  });

  it('does NOT trigger when price moves DOWN (better for us)', () => {
    // anchor=1000, current=1050 → tokensPerLamport went UP = price DOWN
    // chasePct = (1000/1050 - 1) * 100 ≈ -4.76% (negative, never chased)
    const r = isBuyQuoteChasingAnchor({
      anchorTokensPerLamport: 1000,
      currentTokensPerLamport: 1050,
      maxChasePct: 3,
    });
    expect(r.chased).toBe(false);
    expect(r.chasePct).toBeLessThan(0);
  });

  it('boundary: chase just below limit → NOT chased', () => {
    // Construct so chasePct ≈ 2.99% (just below limit=3)
    const anchor = 1029.9;
    const current = 1000;
    const expectedPct = (anchor / current - 1) * 100;
    expect(expectedPct).toBeLessThan(3);
    expect(expectedPct).toBeGreaterThan(2.9);
    const r = isBuyQuoteChasingAnchor({
      anchorTokensPerLamport: anchor,
      currentTokensPerLamport: current,
      maxChasePct: 3,
    });
    expect(r.chased).toBe(false);
  });

  it('boundary: chase just above limit → chased', () => {
    // Construct so chasePct ≈ 3.01% (just above limit=3)
    const anchor = 1030.1;
    const current = 1000;
    const expectedPct = (anchor / current - 1) * 100;
    expect(expectedPct).toBeGreaterThan(3);
    const r = isBuyQuoteChasingAnchor({
      anchorTokensPerLamport: anchor,
      currentTokensPerLamport: current,
      maxChasePct: 3,
    });
    expect(r.chased).toBe(true);
  });

  it('integration: VIRL-like inter-retry chase scenario', () => {
    // VIRL 2026-05-20 incident: between retries quote drifted +5% (price up).
    // Anchor quote: outAmount=140e9, inAmount=1e9 → tpL=140
    // Retry quote (after ~3s): outAmount=133e9, inAmount=1e9 → tpL=133
    // chasePct ≈ (140/133 - 1)*100 ≈ +5.26% → chased@3%=true
    const anchor = tokensPerInLamportFromQuote({ outAmount: '140000000000', inAmount: '1000000000' });
    const current = tokensPerInLamportFromQuote({ outAmount: '133000000000', inAmount: '1000000000' });
    const r = isBuyQuoteChasingAnchor({
      anchorTokensPerLamport: anchor,
      currentTokensPerLamport: current,
      maxChasePct: 3,
    });
    expect(r.chased).toBe(true);
    expect(r.chasePct).toBeGreaterThan(3);
  });
});
