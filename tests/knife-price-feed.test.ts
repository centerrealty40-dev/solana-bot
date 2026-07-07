import { describe, expect, it, beforeEach } from 'vitest';
import {
  __resetKnifePriceFeedForTests,
  adoptKnifeJupiterPrice,
  crossSourceDivPct,
  getKnifeTrustedPrice,
  isKnifeExitPriceSane,
  priceMovePct,
  tryAdoptKnifeSwapPrice,
} from '../src/scripts/knife-price-feed.js';

const MINT = '9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump';

describe('knife-price-feed', () => {
  beforeEach(() => {
    __resetKnifePriceFeedForTests();
  });

  it('adopts Jupiter as trusted anchor', () => {
    const ts = 1_000_000;
    expect(adoptKnifeJupiterPrice(MINT, 0.35, ts)).toBe(true);
    const tick = getKnifeTrustedPrice(MINT, ts);
    expect(tick?.priceUsd).toBe(0.35);
    expect(tick?.source).toBe('jupiter');
  });

  it('rejects swap without Jupiter anchor', () => {
    const r = tryAdoptKnifeSwapPrice(MINT, 0.34, 1_000_000, 25, 25);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('no_jupiter_anchor');
  });

  it('rejects swap that diverges from Jupiter', () => {
    adoptKnifeJupiterPrice(MINT, 1.0, 1_000_000);
    const r = tryAdoptKnifeSwapPrice(MINT, 0.5, 1_000_100, 25, 25);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('cross_source_divergence');
  });

  it('rejects swap tick jump vs last trusted', () => {
    adoptKnifeJupiterPrice(MINT, 1.0, 1_000_000);
    const r = tryAdoptKnifeSwapPrice(MINT, 0.88, 1_000_100, 25, 10);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('tick_jump');
  });

  it('adopts swap when Jupiter agrees and move is sane', () => {
    adoptKnifeJupiterPrice(MINT, 1.0, 1_000_000);
    const r = tryAdoptKnifeSwapPrice(MINT, 0.95, 1_000_100, 25, 25);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.tick.source).toBe('swap_validated');
      expect(r.tick.priceUsd).toBe(0.95);
    }
  });

  it('blocks insane exit vs avg entry', () => {
    expect(isKnifeExitPriceSane(10, 0.35, 50)).toBe(false);
    expect(isKnifeExitPriceSane(0.4, 0.35, 50)).toBe(true);
  });

  it('computes cross-source and move pct', () => {
    expect(crossSourceDivPct(1.1, 1.0)).toBeCloseTo(10);
    expect(priceMovePct(1.0, 1.2)).toBeCloseTo(20);
  });
});
