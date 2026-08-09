import { describe, expect, it } from 'vitest';
import {
  evaluateWaitDipPreBuy,
  evaluateWaitDipReady,
  isRebuyBelowExitWindow,
  shouldParkWaitDip,
  upsertWaitDipWatch,
  waitDipAppliesToSource,
  waitDipMaxPriceUsd,
  waitDipTargetPriceUsd,
  type WaitDipGates,
} from '../../src/milddip/wait-dip.js';
import type { MildDipCandidateMetrics } from '../../src/milddip/gates.js';

const metrics: MildDipCandidateMetrics = {
  priceChange5mPct: -12,
  volume5mUsd: 5_000,
  liquidityUsd: 40_000,
  marketCapUsd: 200_000,
  pairAgeHours: 2,
  dexId: 'pumpswap',
  buys5m: 10,
  sells5m: 20,
  volume1hUsd: 50_000,
  priceChange1hPct: -15,
};

const gates: WaitDipGates = {
  enabled: true,
  waitDipPct: -7,
  maxWatchMs: 1_200_000,
};

describe('waitDipAppliesToSource', () => {
  it('parks main/stabilize branches; skips h1_red_shallow and wait_dip', () => {
    expect(waitDipAppliesToSource('dex')).toBe(true);
    expect(waitDipAppliesToSource('dex+stream')).toBe(true);
    expect(waitDipAppliesToSource('stream')).toBe(true);
    expect(waitDipAppliesToSource('h1_red_shallow')).toBe(false);
    expect(waitDipAppliesToSource('flat_micro_dip')).toBe(true);
    expect(waitDipAppliesToSource('knife_stabilize')).toBe(true);
    expect(waitDipAppliesToSource('mild_stabilize')).toBe(true);
    expect(waitDipAppliesToSource('wait_dip')).toBe(false);
    expect(waitDipAppliesToSource(null)).toBe(false);
  });
});

describe('shouldParkWaitDip / rebuy window', () => {
  const nowMs = 1_000_000;
  const base = {
    nowMs,
    rebuyBelowExitPct: 10,
    rebuyBelowExitMaxAgeMs: 900_000,
  };

  it('isRebuyBelowExitWindow only inside max age with pct>0', () => {
    expect(
      isRebuyBelowExitWindow({
        ...base,
        lastExitAtMs: nowMs - 60_000,
      }),
    ).toBe(true);
    expect(
      isRebuyBelowExitWindow({
        ...base,
        lastExitAtMs: nowMs - 901_000,
      }),
    ).toBe(false);
    expect(
      isRebuyBelowExitWindow({
        ...base,
        rebuyBelowExitPct: 0,
        lastExitAtMs: nowMs - 60_000,
      }),
    ).toBe(false);
    expect(
      isRebuyBelowExitWindow({
        ...base,
        lastExitAtMs: null,
      }),
    ).toBe(false);
  });

  it('does not park h1_red_shallow even outside rebuy', () => {
    expect(
      shouldParkWaitDip({
        ...base,
        dipSource: 'h1_red_shallow',
        lastExitAtMs: null,
      }),
    ).toBe(false);
  });

  it('does not park any branch inside rebuy-below-exit window', () => {
    for (const src of [
      'dex',
      'dex+stream',
      'stream',
      'flat_micro_dip',
      'knife_stabilize',
      'mild_stabilize',
    ] as const) {
      expect(
        shouldParkWaitDip({
          ...base,
          dipSource: src,
          lastExitAtMs: nowMs - 120_000,
        }),
      ).toBe(false);
    }
  });

  it('still parks main branch outside rebuy window', () => {
    expect(
      shouldParkWaitDip({
        ...base,
        dipSource: 'dex',
        lastExitAtMs: null,
      }),
    ).toBe(true);
    expect(
      shouldParkWaitDip({
        ...base,
        dipSource: 'dex',
        lastExitAtMs: nowMs - 901_000,
      }),
    ).toBe(true);
  });
});

describe('waitDipTargetPriceUsd', () => {
  it('computes −7% target', () => {
    expect(waitDipTargetPriceUsd(100, -7)).toBeCloseTo(93, 8);
  });
});

describe('upsertWaitDipWatch / evaluateWaitDipReady', () => {
  it('anchors signal price and fires only after extra −7%', () => {
    const t0 = 1_000_000;
    const w0 = upsertWaitDipWatch(undefined, {
      nowMs: t0,
      priceUsd: 100,
      signalPriceUsd: 100,
      waitDipPct: -7,
      symbol: 'TEST',
      originalDipSource: 'dex',
      metrics,
    });
    expect(w0.signalPriceUsd).toBe(100);

    // Deeper mark must not walk the signal anchor.
    const w1 = upsertWaitDipWatch(w0, {
      nowMs: t0 + 5_000,
      priceUsd: 96,
      signalPriceUsd: 96,
      waitDipPct: -7,
      symbol: 'TEST',
      originalDipSource: 'dex',
      metrics,
    });
    expect(w1.signalPriceUsd).toBe(100);
    expect(w1.troughPriceUsd).toBe(96);

    const notReady = evaluateWaitDipReady(w1, gates, t0 + 5_000, 96);
    expect(notReady.ready).toBe(false);
    expect(notReady.expire).toBe(false);

    const ready = evaluateWaitDipReady(w1, gates, t0 + 10_000, 93);
    expect(ready.ready).toBe(true);
    expect(ready.dumpFromSignalPct).toBeCloseTo(-7, 5);
  });

  it('expires after maxWatchMs', () => {
    const t0 = 1_000_000;
    const w = upsertWaitDipWatch(undefined, {
      nowMs: t0,
      priceUsd: 100,
      signalPriceUsd: 100,
      waitDipPct: -7,
      symbol: 'TEST',
      originalDipSource: 'stream',
      metrics,
    });
    const v = evaluateWaitDipReady(w, gates, t0 + 1_200_001, 99);
    expect(v.expire).toBe(true);
    expect(v.ready).toBe(false);
  });
});

describe('waitDipMaxPriceUsd / evaluateWaitDipPreBuy', () => {
  it('ceiling is waitDipPct + overshoot vs signal', () => {
    // −7% + 2pp → max dump −5% → 95
    expect(waitDipMaxPriceUsd(100, -7, 2)).toBeCloseTo(95, 8);
  });

  it('passes at ready mark (−8.9%) and rejects reclaim to −3.5%', () => {
    const signal = 0.0000664;
    const ready = 0.00006051; // ≈ −8.87%
    const fillLike = 0.00006405; // ≈ −3.53% (2q6hhmf)

    const ok = evaluateWaitDipPreBuy({
      signalPriceUsd: signal,
      readyMarkPriceUsd: ready,
      freshPriceUsd: ready,
      waitDipPct: -7,
      maxOvershootPct: 2,
      maxChaseFromReadyPct: 3,
    });
    expect(ok.pass).toBe(true);
    expect(ok.maxPriceUsd).toBeCloseTo(signal * 0.95, 10);

    const bad = evaluateWaitDipPreBuy({
      signalPriceUsd: signal,
      readyMarkPriceUsd: ready,
      freshPriceUsd: fillLike,
      waitDipPct: -7,
      maxOvershootPct: 2,
      maxChaseFromReadyPct: 3,
    });
    expect(bad.pass).toBe(false);
    expect(bad.reasons.some((r) => r.startsWith('wait_dip_ceiling='))).toBe(true);
  });

  it('rejects chase above ready mark even if still under ceiling', () => {
    const signal = 100;
    const ready = 90; // −10%
    const fresh = 93.5; // still ≤ 95 ceiling (−5%), but +3.89% vs ready
    const bad = evaluateWaitDipPreBuy({
      signalPriceUsd: signal,
      readyMarkPriceUsd: ready,
      freshPriceUsd: fresh,
      waitDipPct: -7,
      maxOvershootPct: 2,
      maxChaseFromReadyPct: 3,
    });
    expect(bad.pass).toBe(false);
    expect(bad.reasons.some((r) => r.startsWith('wait_dip_chase_ready='))).toBe(true);
  });
});
