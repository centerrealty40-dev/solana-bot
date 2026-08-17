import { describe, expect, it } from 'vitest';
import { MildDipPriceRing } from '../../src/milddip/price-ring.js';
import { evaluateCooldownBounce, evaluateRebuyBelowExit } from '../../src/milddip/gates.js';
import { priorityMintsFromCooldown } from '../../src/milddip/discover.js';

describe('MildDipPriceRing', () => {
  it('reports the full observed tape span separately from a lookback window', () => {
    const ring = new MildDipPriceRing();
    const mint = 'ObservedSpanMintxxxxxxxxxxxxxxxxxxxxxxxxxxxx1';
    const t0 = 900_000;
    ring.note(mint, 1, { tsMs: t0, source: 'stream' });
    ring.note(mint, 1.1, { tsMs: t0 + 70_000, source: 'dex' });
    expect(ring.observedSpanMs(mint, t0 + 70_000)).toBe(70_000);
    expect(ring.windowStats(mint, 40_000, t0 + 70_000).spanMs).toBe(0);
  });

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

  it('calculates current and prior minute returns from stream samples only', () => {
    const ring = new MildDipPriceRing();
    const mint = 'TapeMinuteMetricsMintxxxxxxxxxxxxxxxxxxxxxxx1';
    const now = 1_000_000;
    ring.note(mint, 100, { tsMs: now - 360_000, source: 'stream' });
    ring.note(mint, 110, { tsMs: now - 60_000, source: 'stream' });
    ring.note(mint, 121, { tsMs: now, source: 'stream' });
    ring.note(mint, 1, { tsMs: now - 30_000, source: 'dex' });
    const metrics = ring.tapeMinuteMetrics(mint, now);
    expect(metrics.tapeRet1mPct).toBeCloseTo(10, 6);
    expect(metrics.tapePrior5mPct).toBeCloseTo(10, 6);
    expect(metrics.sampleCount).toBe(3);
    expect(metrics.coverageMs).toBe(360_000);
  });

  it('keeps GREEN Jupiter samples out of legacy last-price consumers', () => {
    const ring = new MildDipPriceRing();
    const mint = 'GreenJupiterSourceIsolationMintxxxxxxxxxxxx1';
    ring.note(mint, 100, { tsMs: 1_000, source: 'stream' });
    ring.note(mint, 120, { tsMs: 2_000, source: 'green_jupiter' });
    expect(ring.lastPrice(mint, 2_000)?.source).toBe('stream');
    expect(ring.lastPriceBySource(mint, 'green_jupiter', 2_000)?.priceUsd).toBe(120);
  });

  it('isolates GREEN Jupiter from generic dip helpers while tape metrics include it', () => {
    const ring = new MildDipPriceRing();
    const mint = 'GreenJupiterDipIsolationMintxxxxxxxxxxxxxx1';
    const now = 1_000_000;
    ring.note(mint, 100, { tsMs: now - 120_000, source: 'stream' });
    ring.note(mint, 120, { tsMs: now - 90_000, source: 'stream' });
    ring.note(mint, 110, { tsMs: now - 60_000, source: 'stream' });
    ring.note(mint, 115, { tsMs: now - 30_000, source: 'stream' });
    ring.note(mint, 118, { tsMs: now, source: 'stream' });
    const before = {
      max: ring.maxPrice(mint, 180_000, now)?.priceUsd,
      trough: ring.troughAfterPeak(mint, 180_000, now),
      rally: ring.rallyIntoPeakPct(mint, 180_000, now),
      bounce: ring.bounceFromPostPeakTroughPct(mint, 118, 180_000, now),
    };
    ring.note(mint, 10_000, { tsMs: now - 45_000, source: 'green_jupiter' });
    expect(ring.maxPrice(mint, 180_000, now)?.priceUsd).toBe(before.max);
    expect(ring.troughAfterPeak(mint, 180_000, now)).toEqual(before.trough);
    expect(ring.rallyIntoPeakPct(mint, 180_000, now)).toBe(before.rally);
    expect(ring.bounceFromPostPeakTroughPct(mint, 118, 180_000, now)).toBe(
      before.bounce,
    );

    const tape = new MildDipPriceRing();
    tape.note(mint, 100, { tsMs: now - 300_000, source: 'dex' });
    tape.note(mint, 110, { tsMs: now - 60_000, source: 'stream' });
    tape.note(mint, 111, { tsMs: now - 50_000, source: 'green_jupiter' });
    tape.note(mint, 112, { tsMs: now - 30_000, source: 'stream' });
    tape.note(mint, 115, { tsMs: now - 10_000, source: 'green_jupiter' });
    const metrics = tape.tapeMinuteMetrics(mint, now, 60_000, 360_000, 180_000, {
      strictFreshness: true,
    });
    expect(metrics.tapeRet1mPct).toBeCloseTo((115 / 110 - 1) * 100, 6);
  });

  it('keeps a mint alive on fresh GREEN Jupiter prints but evicts stale mints', () => {
    const ring = new MildDipPriceRing({ ttlMs: 600_000 });
    const now = 2_000_000;
    const greenOnly = 'GreenOnlyFreshMintxxxxxxxxxxxxxxxxxxxxxxxxx1';
    const stale = 'AllSourcesStaleMintxxxxxxxxxxxxxxxxxxxxxxxx1';
    ring.note(greenOnly, 100, {
      tsMs: now - 1_000,
      source: 'green_jupiter',
    });
    ring.note(stale, 100, {
      tsMs: now - 120_000,
      source: 'stream',
    });
    ring.note(stale, 101, {
      tsMs: now - 90_000,
      source: 'dex',
    });

    expect(ring.evictIdle(now, 60_000)).toBe(1);
    expect(ring.watchedMints(now)).toContain(greenOnly);
    expect(ring.watchedMints(now)).not.toContain(stale);
  });

  it('returns null tape returns when stream coverage is insufficient', () => {
    const ring = new MildDipPriceRing();
    const mint = 'TapeMinuteCoverageMintxxxxxxxxxxxxxxxxxxxxxx1';
    const now = 1_000_000;
    ring.note(mint, 100, { tsMs: now - 120_000, source: 'stream' });
    ring.note(mint, 121, { tsMs: now, source: 'stream' });
    const metrics = ring.tapeMinuteMetrics(mint, now);
    expect(metrics.tapeRet1mPct).toBeNull();
    expect(metrics.tapePrior5mPct).toBeNull();
    expect(metrics.sampleCount).toBe(2);
    expect(metrics.coverageMs).toBe(120_000);
  });

  it('forms a strict minute from stream and GREEN Jupiter samples', () => {
    const ring = new MildDipPriceRing();
    const mint = 'StrictTapeMinuteMintxxxxxxxxxxxxxxxxxxxxxxx1';
    const now = 2_000_000;
    ring.note(mint, 100, { tsMs: now - 300_000, source: 'stream' });
    ring.note(mint, 110, { tsMs: now - 60_000, source: 'green_jupiter' });
    ring.note(mint, 111, { tsMs: now - 50_000, source: 'stream' });
    ring.note(mint, 112, { tsMs: now - 30_000, source: 'green_jupiter' });
    ring.note(mint, 115, { tsMs: now - 10_000, source: 'stream' });
    const metrics = ring.tapeMinuteMetrics(mint, now, 60_000, 360_000, 180_000, {
      strictFreshness: true,
    });
    expect(metrics.tapeRet1mPct).toBeCloseTo((115 / 110 - 1) * 100, 6);
    expect(metrics.tapePrior5mPct).toBeCloseTo(10, 6);
    expect(metrics.failureReason).toBeNull();
  });

  it('uses a DEX anchor for strict prior5m without requiring 180s tape coverage', () => {
    const ring = new MildDipPriceRing();
    const mint = 'StrictTapeDexAnchorMintxxxxxxxxxxxxxxxxxxxx1';
    const now = 2_500_000;
    ring.note(mint, 100, { tsMs: now - 300_000, source: 'dex' });
    ring.note(mint, 110, { tsMs: now - 60_000, source: 'green_jupiter' });
    ring.note(mint, 111, { tsMs: now - 50_000, source: 'stream' });
    ring.note(mint, 112, { tsMs: now - 30_000, source: 'green_jupiter' });
    ring.note(mint, 115, { tsMs: now - 10_000, source: 'stream' });
    const metrics = ring.tapeMinuteMetrics(mint, now, 60_000, 360_000, 180_000, {
      strictFreshness: true,
    });
    expect(metrics.tapePrior5mPct).toBeCloseTo(10, 6);
    expect(metrics.failureReason).toBeNull();
  });

  it('prefers the 4.5–6.5 minute anchor over an older arbitrary sample', () => {
    const ring = new MildDipPriceRing();
    const mint = 'StrictTapeAnchorWindowMintxxxxxxxxxxxxxxxxx1';
    const now = 2_600_000;
    ring.note(mint, 1, { tsMs: now - 630_000, source: 'dex' });
    ring.note(mint, 100, { tsMs: now - 300_000, source: 'dex' });
    ring.note(mint, 110, { tsMs: now - 60_000, source: 'stream' });
    ring.note(mint, 111, { tsMs: now - 50_000, source: 'stream' });
    ring.note(mint, 112, { tsMs: now - 30_000, source: 'stream' });
    ring.note(mint, 115, { tsMs: now - 10_000, source: 'stream' });
    const metrics = ring.tapeMinuteMetrics(mint, now, 60_000, 360_000, 180_000, {
      strictFreshness: true,
    });
    expect(metrics.tapePrior5mPct).toBeCloseTo(10, 6);
  });

  it.each([
    ['boundary', 'tape_minute_boundary_missing'],
    ['latest', 'tape_minute_latest_stale'],
    ['recent samples', 'tape_minute_samples_insufficient'],
    ['prior anchor', 'tape_minute_prior_anchor_missing'],
  ] as const)('fails closed when the strict %s requirement is missing', (missing, reason) => {
    const ring = new MildDipPriceRing();
    const mint = `StrictTape${missing}xxxxxxxxxxxxxxxxxxxxxxxx1`;
    const now = 3_000_000;
    if (missing !== 'prior anchor') {
      ring.note(mint, 100, { tsMs: now - 300_000, source: 'stream' });
    }
    if (missing !== 'boundary') {
      ring.note(mint, 110, { tsMs: now - 60_000, source: 'stream' });
    }
    const recentAges =
      missing === 'boundary'
        ? [30_000, 20_000, 10_000]
        : missing === 'recent samples'
          ? [30_000, 20_000]
          : missing === 'latest'
            ? [50_000, 30_000, 20_000]
            : [50_000, 30_000, 10_000];
    recentAges.forEach((age, index) => {
      ring.note(mint, 111 + index, { tsMs: now - age, source: 'stream' });
    });
    const metrics = ring.tapeMinuteMetrics(mint, now, 60_000, 360_000, 180_000, {
      strictFreshness: true,
    });
    expect(metrics.tapeRet1mPct).toBeNull();
    expect(metrics.tapePrior5mPct).toBeNull();
    expect(metrics.failureReason).toBe(reason);
  });

  it('does not use an arbitrary stale sample as the prior anchor', () => {
    const ring = new MildDipPriceRing();
    const mint = 'StrictTapeStaleAnchorxxxxxxxxxxxxxxxxxxxxxx1';
    const now = 4_000_000;
    ring.note(mint, 100, { tsMs: now - 600_000, source: 'stream' });
    ring.note(mint, 110, { tsMs: now - 60_000, source: 'stream' });
    ring.note(mint, 111, { tsMs: now - 50_000, source: 'stream' });
    ring.note(mint, 112, { tsMs: now - 30_000, source: 'stream' });
    ring.note(mint, 115, { tsMs: now - 10_000, source: 'stream' });
    const metrics = ring.tapeMinuteMetrics(mint, now, 60_000, 360_000, 180_000, {
      strictFreshness: true,
    });
    expect(metrics.tapeRet1mPct).toBeNull();
    expect(metrics.tapePrior5mPct).toBeNull();
    expect(metrics.failureReason).toBe('tape_minute_prior_anchor_missing');
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
