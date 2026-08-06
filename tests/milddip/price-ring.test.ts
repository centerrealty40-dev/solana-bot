import { describe, expect, it } from 'vitest';
import { MildDipPriceRing } from '../../src/milddip/price-ring.js';
import { evaluateCooldownBounce } from '../../src/milddip/gates.js';
import {
  priorityMintsFromCooldown,
  priorityMintsFromPriceRingDip,
} from '../../src/milddip/discover.js';

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

describe('priorityMintsFromPriceRingDip', () => {
  it('prioritizes active ring dips in entry band', () => {
    const ring = new MildDipPriceRing();
    const now = 10_000_000;
    const inBandDeep = 'RingDipDeep111111111111111111111111111pump';
    const inBandShallow = 'RingDipShallow111111111111111111111111pump';
    const tooDeep = 'RingDipKnife111111111111111111111111111pump';
    const flat = 'RingDipFlat1111111111111111111111111111pump';

    ring.note(inBandDeep, 1, { tsMs: now - 20_000, source: 'stream' });
    ring.note(inBandDeep, 0.88, { tsMs: now - 5_000, source: 'stream' });
    ring.note(inBandShallow, 1, { tsMs: now - 20_000, source: 'stream' });
    ring.note(inBandShallow, 0.94, { tsMs: now - 5_000, source: 'stream' });
    ring.note(tooDeep, 1, { tsMs: now - 20_000, source: 'stream' });
    ring.note(tooDeep, 0.7, { tsMs: now - 5_000, source: 'stream' });
    ring.note(flat, 1, { tsMs: now - 20_000, source: 'stream' });
    ring.note(flat, 0.995, { tsMs: now - 5_000, source: 'stream' });

    const cfg = {
      cooldownBounceLookbackMs: 60_000,
      entry: { minDipPct: -25, maxDipPct: -5 },
    } as Parameters<typeof priorityMintsFromPriceRingDip>[0];

    const out = priorityMintsFromPriceRingDip(
      cfg,
      [flat, tooDeep, inBandShallow, inBandDeep],
      now,
      { ring },
    );

    expect(out).toEqual([inBandDeep, inBandShallow]);
  });
});
