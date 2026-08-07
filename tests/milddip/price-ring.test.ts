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
      minBelowExitPct: 4,
      maxAgeMs: 900_000,
    });
    expect(v.pass).toBe(false);
    expect(v.reasons[0]).toContain('rebuy_below_exit');
  });

  it('allows rebuy when mark is ≥4% below exit', () => {
    const v = evaluateRebuyBelowExit({
      freshPriceUsd: 0.000086,
      lastExitPriceUsd: 0.00009,
      lastExitAtMs: now - 60_000,
      nowMs: now,
      minBelowExitPct: 4,
      maxAgeMs: 900_000,
    });
    expect(v.pass).toBe(true);
  });

  it('ignores stale exits past maxAge', () => {
    const v = evaluateRebuyBelowExit({
      freshPriceUsd: 0.00009,
      lastExitPriceUsd: 0.00009,
      lastExitAtMs: now - 1_000_000,
      nowMs: now,
      minBelowExitPct: 4,
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
