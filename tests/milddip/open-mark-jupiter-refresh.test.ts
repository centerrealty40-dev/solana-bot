import { describe, expect, it, beforeEach } from 'vitest';
import { mildDipPriceRing } from '../../src/milddip/price-ring.js';
import {
  __resetOpenMarkJupiterRefreshForTests,
  openMarkNeedsJupiterTopUp,
  requestOpenMarkJupiterRefresh,
} from '../../src/milddip/open-mark-jupiter-refresh.js';

describe('open-mark-jupiter-refresh', () => {
  const mint = '4kZdVs11111111111111111111111111111111112';
  const now = 1_700_000_000_000;

  beforeEach(() => {
    __resetOpenMarkJupiterRefreshForTests();
    mildDipPriceRing.note(mint, 0.00003, { tsMs: now - 500, source: 'dex' });
  });

  it('requests refresh when stream has been quiet', () => {
    expect(openMarkNeedsJupiterTopUp(mint, now, 5_000)).toBe(true);
    const ok = requestOpenMarkJupiterRefresh({
      mint,
      nowMs: now,
      minGapMs: 2_000,
      maxInFlight: 2,
      probeUsd: 1,
      slippageBps: 150,
      snapshotPriceUsd: 0.00003,
    });
    expect(ok).toBe(true);
  });

  it('skips when a fresh stream print exists', () => {
    mildDipPriceRing.note(mint, 0.000035, { tsMs: now - 1_000, source: 'stream' });
    expect(openMarkNeedsJupiterTopUp(mint, now, 5_000)).toBe(false);
  });
});
