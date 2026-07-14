import { describe, expect, it } from 'vitest';
import { evaluateKnifeFlushLeg2 } from '../src/scripts/knife-flush-leg2.js';

type MintState = {
  mint: string;
  buf: Array<{ t: number; p: number }>;
  legs: number;
  leg1Price: number;
  qtyFilled: number;
  qty: number;
  avgEntry: number;
  investedUsd: number;
};

function state(partial: Partial<MintState> = {}): MintState {
  return {
    mint: '6NwarBvDkXhByqVp2Qkq5i9XbtA2B3Bwe8SWGu9vpump',
    buf: [],
    legs: 1,
    leg1Price: 0.00344,
    qtyFilled: 1451,
    qty: 1451,
    avgEntry: 0.00344,
    investedUsd: 5,
    ...partial,
  };
}

const now = 2_000_000;
const cfg = {
  flushLeg2Enabled: true,
  flushTriggerEnabled: true,
  flushWindowMs: 600_000,
  flushLeg2MinDumpPct: 15,
  maxDrawdownPct: 40,
  maxBounceFromDumpPct: 5,
  globalEntryGapMs: 0,
  legUsd: 25,
  positionUsd: 50,
};

describe('evaluateKnifeFlushLeg2', () => {
  it('adds leg2 when open leg1 sees a >=15% floor flush', () => {
    const s = state({
      buf: [
        { t: now - 500_000, p: 0.0040 },
        { t: now - 200_000, p: 0.0038 },
      ],
    });
    const res = evaluateKnifeFlushLeg2(cfg, s, 0.0033, now, 0);
    expect(res.fired).toBe(true);
    expect(s.legs).toBe(2);
    expect(s.investedUsd).toBe(30);
    expect(s.avgEntry).toBeLessThan(s.leg1Price);
  });

  it('skips leg2 when flush is shallower than 15%', () => {
    const s = state({
      buf: [{ t: now - 400_000, p: 0.0035 }],
    });
    const res = evaluateKnifeFlushLeg2(cfg, s, 0.0033, now, 0);
    expect(res.fired).toBe(false);
    expect(s.legs).toBe(1);
    expect(s.investedUsd).toBe(5);
  });
});
