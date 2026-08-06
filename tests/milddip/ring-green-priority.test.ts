import { describe, expect, it } from 'vitest';
import { priorityMintsFromPriceRingGreen } from '../../src/milddip/discover.js';
import { mildDipPriceRing } from '../../src/milddip/price-ring.js';
import type { GreenTapeGates } from '../../src/volgreen/green-tape-gates.js';

const greenTape: GreenTapeGates = {
  minLiquidityUsd: 12_000,
  minMarketCapUsd: 40_000,
  maxMarketCapUsd: 300_000_000,
  minPairAgeHours: 0.1,
  maxPairAgeHours: 72,
  allowedDexIds: ['pumpswap'],
  liquidMinPc5mPct: 5,
  liquidMaxPc5mPct: 20,
  liquidMinVolume5mUsd: 2_000,
  liquidMinBuySellRatio5m: 1,
  liquidMinTurnover5m: 0.09,
  earlyMinPc5mPct: 5,
  earlyMaxPc5mPct: 25,
  earlyMinVolume5mUsd: 400,
  earlyMinBuySellRatio5m: 2,
  earlyMinTurnover5m: 0.02,
  earlyMinMarketCapUsd: 35_000,
};

describe('priorityMintsFromPriceRingGreen', () => {
  it('ranks stronger trough→last rallies ahead of flat tape', () => {
    const now = Date.now();
    const a = 'RingGreA11111111111111111111111111111111111';
    const b = 'RingGreB22222222222222222222222222222222222';
    const flat = 'RingFlat33333333333333333333333333333333333';

    mildDipPriceRing.note(a, 1.0, { tsMs: now - 60_000, source: 'stream' });
    mildDipPriceRing.note(a, 1.1, { tsMs: now - 1_000, source: 'stream' }); // +10%
    mildDipPriceRing.note(b, 1.0, { tsMs: now - 60_000, source: 'stream' });
    mildDipPriceRing.note(b, 1.2, { tsMs: now - 1_000, source: 'stream' }); // +20%
    mildDipPriceRing.note(flat, 1.0, { tsMs: now - 60_000, source: 'stream' });
    mildDipPriceRing.note(flat, 1.01, { tsMs: now - 1_000, source: 'stream' }); // +1%

    const ordered = priorityMintsFromPriceRingGreen(
      { cooldownBounceLookbackMs: 300_000, greenTape },
      [flat, a, b],
      now,
      { max: 10 },
    );
    expect(ordered[0]).toBe(b);
    expect(ordered).toContain(a);
    expect(ordered).not.toContain(flat);
  });
});
