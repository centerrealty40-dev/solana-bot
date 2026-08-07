import { describe, expect, it } from 'vitest';
import {
  evaluateKnifeStabilizePreBuy,
  evaluateKnifeStabilizeReady,
  isKnifeDipPct,
  upsertKnifeWatch,
  type KnifeStabilizeGates,
} from '../../src/milddip/knife-stabilize.js';

const gates: KnifeStabilizeGates = {
  enabled: true,
  minDipPct: -50,
  maxDipPct: -20,
  waitMs: 120_000,
  maxWatchMs: 600_000,
  quietMs: 45_000,
  stabilizeBandPct: 2.5,
  minBouncePct: 1.5,
  maxBouncePct: 10,
};

describe('isKnifeDipPct', () => {
  it('accepts −20…−50 knife band', () => {
    expect(isKnifeDipPct(-20, gates)).toBe(true);
    expect(isKnifeDipPct(-35, gates)).toBe(true);
    expect(isKnifeDipPct(-49.9, gates)).toBe(true);
  });

  it('rejects mild dips and rugs', () => {
    expect(isKnifeDipPct(-19.9, gates)).toBe(false);
    expect(isKnifeDipPct(-4, gates)).toBe(false);
    expect(isKnifeDipPct(-50, gates)).toBe(false);
    expect(isKnifeDipPct(-60, gates)).toBe(false);
  });
});

describe('upsertKnifeWatch', () => {
  it('deepens trough while keeping detectedAt', () => {
    const t0 = 1_000_000;
    const w0 = upsertKnifeWatch(undefined, {
      nowMs: t0,
      priceUsd: 1.0,
      dipPct: -25,
      peakPriceUsd: 1.4,
    });
    expect(w0.detectedAtMs).toBe(t0);
    expect(w0.troughPriceUsd).toBe(1.0);

    const w1 = upsertKnifeWatch(w0, {
      nowMs: t0 + 30_000,
      priceUsd: 0.9,
      dipPct: -35,
      peakPriceUsd: 1.4,
    });
    expect(w1.detectedAtMs).toBe(t0);
    expect(w1.troughPriceUsd).toBe(0.9);
    expect(w1.knifeDipPct).toBe(-35);
    expect(w1.troughAtMs).toBe(t0 + 30_000);
  });
});

describe('evaluateKnifeStabilizeReady', () => {
  const baseWatch = upsertKnifeWatch(undefined, {
    nowMs: 1_000_000,
    priceUsd: 1.0,
    dipPct: -30,
    peakPriceUsd: 1.45,
  });

  it('waits for the 2m timer', () => {
    const v = evaluateKnifeStabilizeReady(baseWatch, gates, 1_000_000 + 60_000, 1.0);
    expect(v.ready).toBe(false);
    expect(v.expire).toBe(false);
    expect(v.reasons.some((r) => r.startsWith('knife_wait='))).toBe(true);
  });

  it('buys controlled bounce after wait', () => {
    const v = evaluateKnifeStabilizeReady(
      baseWatch,
      gates,
      1_000_000 + 120_000,
      1.03, // +3% off trough
    );
    expect(v.ready).toBe(true);
    expect(v.mode).toBe('bounce');
    expect(v.expire).toBe(false);
  });

  it('buys stabilize after wait + quiet hold', () => {
    const quiet = {
      ...baseWatch,
      troughAtMs: 1_000_000, // no new low
      lastPriceUsd: 1.01,
      lastAtMs: 1_000_000 + 130_000,
    };
    const v = evaluateKnifeStabilizeReady(quiet, gates, 1_000_000 + 130_000, 1.01);
    expect(v.ready).toBe(true);
    expect(v.mode).toBe('stabilize');
  });

  it('does not stabilize while still printing lows', () => {
    const falling = {
      ...baseWatch,
      troughPriceUsd: 0.95,
      troughAtMs: 1_000_000 + 125_000, // fresh low
      lastPriceUsd: 0.95,
      lastAtMs: 1_000_000 + 125_000,
      knifeDipPct: -34,
    };
    const v = evaluateKnifeStabilizeReady(falling, gates, 1_000_000 + 130_000, 0.95);
    expect(v.ready).toBe(false);
    expect(v.reasons.some((r) => r.includes('knife_still_falling'))).toBe(true);
  });

  it('expires on chase beyond max bounce', () => {
    const v = evaluateKnifeStabilizeReady(
      baseWatch,
      gates,
      1_000_000 + 120_000,
      1.15, // +15%
    );
    expect(v.ready).toBe(false);
    expect(v.expire).toBe(true);
    expect(v.reasons.some((r) => r.startsWith('knife_chase='))).toBe(true);
  });
});

describe('evaluateKnifeStabilizePreBuy', () => {
  it('passes a fresh mark near signal / trough', () => {
    const v = evaluateKnifeStabilizePreBuy({
      signalPriceUsd: 1.02,
      freshPriceUsd: 1.03,
      troughPriceUsd: 1.0,
      maxChasePct: 4,
      maxBouncePct: 10,
    });
    expect(v.pass).toBe(true);
  });

  it('rejects chase vs signal', () => {
    const v = evaluateKnifeStabilizePreBuy({
      signalPriceUsd: 1.0,
      freshPriceUsd: 1.06,
      troughPriceUsd: 0.95,
      maxChasePct: 4,
      maxBouncePct: 10,
    });
    expect(v.pass).toBe(false);
    expect(v.reasons.some((r) => r.startsWith('knife_prebuy_chase='))).toBe(true);
  });
});
