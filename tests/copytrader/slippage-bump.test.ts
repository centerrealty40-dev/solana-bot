import { describe, expect, it } from 'vitest';
import { bumpSlippageBps, multiplySlippageBps } from '../../src/copytrader/slippage-bump.js';

describe('bumpSlippageBps', () => {
  it('climbs Oscar envelope 10 → 100 by +10', () => {
    let bps = 10;
    for (let i = 0; i < 9; i++) {
      bps = bumpSlippageBps({ currentBps: bps, bumpBps: 10, maxBps: 100 });
    }
    expect(bps).toBe(100);
    expect(bumpSlippageBps({ currentBps: 100, bumpBps: 10, maxBps: 100 })).toBe(100);
  });

  it('does not clamp a wide control lane down to maxBps', () => {
    expect(bumpSlippageBps({ currentBps: 300, bumpBps: 10, maxBps: 100 })).toBe(300);
  });

  it('no-ops when bump is 0', () => {
    expect(bumpSlippageBps({ currentBps: 10, bumpBps: 0, maxBps: 100 })).toBe(10);
  });
});

describe('multiplySlippageBps', () => {
  it('escalates mirror retries multiplicatively and respects the hard cap', () => {
    let bps = 200;
    bps = multiplySlippageBps({ currentBps: bps, multiplier: 2, maxBps: 800 });
    expect(bps).toBe(400);
    bps = multiplySlippageBps({ currentBps: bps, multiplier: 2, maxBps: 800 });
    expect(bps).toBe(800);
  });

  it('provides the retry sequence used after Jupiter 6001 slippage failures', () => {
    let bps = 200;
    const retryBps: number[] = [];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      bps = multiplySlippageBps({ currentBps: bps, multiplier: 2, maxBps: 800 });
      retryBps.push(bps);
    }
    expect(retryBps).toEqual([400, 800]);
  });
});
