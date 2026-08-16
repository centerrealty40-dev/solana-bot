import { describe, expect, it } from 'vitest';
import { MildDipPriceRing } from '../../src/milddip/price-ring.js';
import { evaluateCooldownBounce, evaluateRebuyBelowExit } from '../../src/milddip/gates.js';
import { priorityMintsFromCooldown } from '../../src/milddip/discover.js';

describe('MildDipPriceRing', () => {
  it('tracks trough and bounce from lookback window', () => {
    const ring = new MildDipPriceRing();
    const mint = '7pQYyWKPtxMCzdWDPZKJ7xTnCzFB25SPxp8cM4xJpump';
    const t0 = 1_000_000;
    ring.note(mint, 0.00021, { tsMs: t0, source: 'dex' });
    ring.note(mint, 0.000206, { tsMs: t0 + 30_000, source: 'stream' });
    ring.note(mint, 0.00021, { tsMs: t0 + 90_000, source: 'dex' });

    const trough = ring.minPrice(mint, 300_000, t0 + 100_000);
    expect(trough?.priceUsd).toBe(0.000206);

    const bounce = ring.bounceFromTroughPct(mint, 0.00021, 300_000, t0 + 100_000);
    expect(bounce).toBeGreaterThan(1.9);
    expect(bounce).toBeLessThan(2.1);
  });

  it('drawdownFromPeakPct is negative on dump', () => {
    const ring = new MildDipPriceRing();
    const mint = '7pQYyWKPtxMCzdWDPZKJ7xTnCzFB25SPxp8cM4xJpump';
    const t0 = 2_000_000;
    ring.note(mint, 0.0002, { tsMs: t0, source: 'stream' });
    ring.note(mint, 0.00018, { tsMs: t0 + 20_000, source: 'stream' });
    const dd = ring.drawdownFromPeakPct(mint, 60_000, t0 + 20_000);
    expect(dd).toBeCloseTo(-10, 5);
  });

  it('dumpExtent uses trough AFTER peak, not pre-pump base', () => {
    const ring = new MildDipPriceRing({ maxSamplesPerMint: 60, ttlMs: 3_600_000 });
    const mint = 'EjD5Y9DummyMintForPumpWickDumpExtentTestxxx1';
    const t0 = 3_000_000;
    // Pump: 1.0 → 1.4 peak, then −2.7% wick to 1.362.
    ring.note(mint, 1.0, { tsMs: t0, source: 'stream' });
    ring.note(mint, 1.2, { tsMs: t0 + 60_000, source: 'stream' });
    ring.note(mint, 1.4, { tsMs: t0 + 120_000, source: 'stream' });
    ring.note(mint, 1.362, { tsMs: t0 + 130_000, source: 'stream' });
    const now = t0 + 130_000;
    const extent = ring.dumpExtentFromPeakPct(mint, 600_000, now);
    const current = ring.drawdownFromPeakPct(mint, 600_000, now);
    const rally = ring.rallyIntoPeakPct(mint, 600_000, now);
    // Window-min is 1.0 — old code would see −28.6% "dump". Real dump is wick only.
    expect(extent).toBeCloseTo((1.362 / 1.4 - 1) * 100, 5);
    expect(current).toBeCloseTo((1.362 / 1.4 - 1) * 100, 5);
    expect(rally).toBeCloseTo(40, 5);
    const bouncePost = ring.bounceFromPostPeakTroughPct(mint, 1.362, 600_000, now);
    expect(bouncePost).toBeCloseTo(0, 5);
    // Window-min bounce from 1.0 looks huge (false "far from trough").
    const bounceWin = ring.bounceFromTroughPct(mint, 1.362, 600_000, now);
    expect(bounceWin).toBeGreaterThan(30);
  });

  it('dumpExtent is 0 while still making highs', () => {
    const ring = new MildDipPriceRing();
    const mint = 'StillPumpingMintxxxxxxxxxxxxxxxxxxxxxxxxxx1';
    const t0 = 4_000_000;
    ring.note(mint, 1.0, { tsMs: t0, source: 'stream' });
    ring.note(mint, 1.1, { tsMs: t0 + 10_000, source: 'stream' });
    ring.note(mint, 1.2, { tsMs: t0 + 20_000, source: 'stream' });
    expect(ring.dumpExtentFromPeakPct(mint, 60_000, t0 + 20_000)).toBeCloseTo(0, 5);
  });

  it('lastPriceBySource finds stream under a newer dex tick', () => {
    const ring = new MildDipPriceRing();
    const mint = '7pQYyWKPtxMCzdWDPZKJ7xTnCzFB25SPxp8cM4xJpump';
    const t0 = 5_000_000;
    ring.note(mint, 0.00012, { tsMs: t0, source: 'stream' });
    ring.note(mint, 0.00011, { tsMs: t0 + 5_000, source: 'dex' });
    expect(ring.lastPrice(mint, t0 + 5_000)?.source).toBe('dex');
    const stream = ring.lastPriceBySource(mint, 'stream', t0 + 5_000, 120_000);
    expect(stream?.priceUsd).toBe(0.00012);
    expect(ring.lastPriceBySource(mint, 'stream', t0 + 200_000, 120_000)).toBeNull();
  });

  it('isPlausiblePrice rejects 1000× decode outliers', () => {
    const ring = new MildDipPriceRing();
    const mint = 'EeqYr8QfLNEWfUEFEw71noCA85k73qtxGEaLsC9ipump';
    const t0 = 6_000_000;
    ring.note(mint, 7.22e-5, { tsMs: t0, source: 'dex' });
    expect(ring.isPlausiblePrice(mint, 7.5e-5, { nowMs: t0 + 1_000 })).toBe(true);
    expect(ring.isPlausiblePrice(mint, 0.1829, { nowMs: t0 + 1_000 })).toBe(false);
  });
});

describe('evaluateCooldownBounce', () => {
  it('skips when bounce from trough exceeds max', () => {
    const v = evaluateCooldownBounce({
      freshPriceUsd: 0.00021,
      troughPriceUsd: 0.000206,
      maxBouncePct: 1.5,
    });
    expect(v.pass).toBe(false);
    expect(v.reasons[0]).toContain('cooldown_bounce');
  });

  it('passes when still near trough', () => {
    const v = evaluateCooldownBounce({
      freshPriceUsd: 0.000207,
      troughPriceUsd: 0.000206,
      maxBouncePct: 6,
    });
    expect(v.pass).toBe(true);
  });

  it('passes without trough when not required', () => {
    const v = evaluateCooldownBounce({
      freshPriceUsd: 0.00021,
      troughPriceUsd: null,
      maxBouncePct: 6,
      requireTrough: false,
    });
    expect(v.pass).toBe(true);
  });
});

describe('evaluateRebuyBelowExit', () => {
  const now = 1_000_000;
  it('blocks rebuy at same/higher price than last exit', () => {
    const v = evaluateRebuyBelowExit({
      freshPriceUsd: 0.00009,
      lastExitPriceUsd: 0.00009,
      lastExitAtMs: now - 60_000,
      nowMs: now,
      minBelowExitPct: 5,
      maxAgeMs: 900_000,
    });
    expect(v.pass).toBe(false);
    expect(v.reasons[0]).toContain('rebuy_below_exit');
  });

  it('allows rebuy when mark is 6% below exit with a 5% floor', () => {
    const v = evaluateRebuyBelowExit({
      freshPriceUsd: 0.0000846,
      lastExitPriceUsd: 0.00009,
      lastExitAtMs: now - 60_000,
      nowMs: now,
      minBelowExitPct: 5,
      maxAgeMs: 900_000,
    });
    expect(v.pass).toBe(true);
  });

  it('blocks rebuy at a price above the last exit within the age window', () => {
    const v = evaluateRebuyBelowExit({
      freshPriceUsd: 0.000091,
      lastExitPriceUsd: 0.00009,
      lastExitAtMs: now - 60_000,
      nowMs: now,
      minBelowExitPct: 5,
      maxAgeMs: 900_000,
    });
    expect(v.pass).toBe(false);
    expect(v.reasons.join(' ')).toContain('rebuy_below_exit');
  });

  it('ignores stale exits past maxAge', () => {
    const v = evaluateRebuyBelowExit({
      freshPriceUsd: 0.00009,
      lastExitPriceUsd: 0.00009,
      lastExitAtMs: now - 1_000_000,
      nowMs: now,
      minBelowExitPct: 20,
      maxAgeMs: 900_000,
    });
    expect(v.pass).toBe(true);
  });
});

describe('priorityMintsFromCooldown', () => {
  it('includes cooling and just-expired mints', () => {
    const now = 1_000_000;
    const list = priorityMintsFromCooldown(
      {
        cooling: now + 60_000,
        ready: now - 30_000,
        old: now - 600_000,
      },
      now,
      { postCooldownMs: 120_000 },
    );
    expect(list).toContain('cooling');
    expect(list).toContain('ready');
    expect(list).not.toContain('old');
  });
});
