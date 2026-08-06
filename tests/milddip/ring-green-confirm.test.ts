import { describe, expect, it } from 'vitest';
import { mildDipPriceRing } from '../../src/milddip/price-ring.js';

describe('MildDipPriceRing.changeFromOldestPct', () => {
  it('returns negative when last is below oldest (dump / red tape)', () => {
    const now = Date.now();
    const mint = 'RingRedConfirm111111111111111111111111111';
    mildDipPriceRing.note(mint, 1.0, { tsMs: now - 240_000, source: 'dex' });
    mildDipPriceRing.note(mint, 0.7, { tsMs: now - 60_000, source: 'dex' });
    mildDipPriceRing.note(mint, 0.75, { tsMs: now - 1_000, source: 'dex' }); // bounce, still red vs oldest
    const pc = mildDipPriceRing.changeFromOldestPct(mint, 300_000, now);
    expect(pc).not.toBeNull();
    expect(pc!).toBeLessThan(0);
  });

  it('returns positive when last is above oldest (true green tape)', () => {
    const now = Date.now();
    const mint = 'RingGrnConfirm222222222222222222222222222';
    mildDipPriceRing.note(mint, 1.0, { tsMs: now - 240_000, source: 'stream' });
    mildDipPriceRing.note(mint, 1.08, { tsMs: now - 1_000, source: 'dex' });
    const pc = mildDipPriceRing.changeFromOldestPct(mint, 300_000, now);
    expect(pc).toBeGreaterThan(5);
  });
});
