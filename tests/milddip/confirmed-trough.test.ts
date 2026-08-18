import { describe, expect, it } from 'vitest';
import {
  confirmedTroughGatePasses,
  evaluateConfirmedTrough,
} from '../../src/milddip/confirmed-trough.js';
import { MildDipPriceRing } from '../../src/milddip/price-ring.js';

describe('evaluateConfirmedTrough', () => {
  it('returns trough age, bounce, and drop from the window high', () => {
    const ring = new MildDipPriceRing();
    const mint = 'ConfirmedTroughMetricsMintxxxxxxxxxxxxxx1';
    const t0 = 1_000_000;
    ring.note(mint, 1, { tsMs: t0, source: 'dex' });
    ring.note(mint, 0.8, { tsMs: t0 + 10_000, source: 'stream' });

    const metrics = evaluateConfirmedTrough({
      ring,
      mint,
      nowMs: t0 + 200_000,
      windowMs: 900_000,
      freshPriceUsd: 0.84,
    });
    expect(metrics.troughAgeMs).toBe(190_000);
    expect(metrics.bounceFromTroughPct).toBeCloseTo(5, 8);
    expect(metrics.dropFromWindowHighPct).toBeCloseTo(-20, 8);
  });

  it('does not pass a fresh trough or a bounce above the cap', () => {
    const ring = new MildDipPriceRing();
    const mint = 'ConfirmedTroughGateBoundariesMintxxxxx1';
    const t0 = 2_000_000;
    ring.note(mint, 1, { tsMs: t0, source: 'stream' });
    ring.note(mint, 0.8, { tsMs: t0 + 10_000, source: 'stream' });

    const fresh = evaluateConfirmedTrough({
      ring,
      mint,
      nowMs: t0 + 40_000,
      windowMs: 900_000,
      freshPriceUsd: 0.84,
    });
    expect(
      confirmedTroughGatePasses({
        metrics: fresh,
        minTroughAgeMs: 180_000,
        maxBouncePct: 8,
      }),
    ).toBe(false);

    const bounced = evaluateConfirmedTrough({
      ring,
      mint,
      nowMs: t0 + 200_000,
      windowMs: 900_000,
      freshPriceUsd: 0.9,
    });
    expect(
      confirmedTroughGatePasses({
        metrics: bounced,
        minTroughAgeMs: 180_000,
        maxBouncePct: 8,
      }),
    ).toBe(false);
  });
});
