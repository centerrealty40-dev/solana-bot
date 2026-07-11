import { afterEach, describe, expect, it, vi } from 'vitest';

// Mock the Jupiter quote to hang until released, and SOL price to be present.
let activeQuotes = 0;
let maxActiveQuotes = 0;
let quoteCalls = 0;
const releasers: Array<() => void> = [];

vi.mock('../src/papertrader/pricing.js', () => ({
  getSolUsd: () => 100,
  refreshSolPrice: async () => true,
}));

vi.mock('../src/papertrader/pricing/price-verify.js', () => ({
  jupiterQuoteBuyPriceUsd: async () => {
    quoteCalls += 1;
    activeQuotes += 1;
    maxActiveQuotes = Math.max(maxActiveQuotes, activeQuotes);
    await new Promise<void>((resolve) => {
      releasers.push(() => {
        activeQuotes -= 1;
        resolve();
      });
    });
    return { kind: 'ok', jupiterPriceUsd: 0.01, ts: Date.now() };
  },
}));

const { startKnifeJupiterPoll } = await import('../src/scripts/knife-price-feed.js');

afterEach(() => {
  activeQuotes = 0;
  maxActiveQuotes = 0;
  quoteCalls = 0;
  releasers.length = 0;
});

describe('startKnifeJupiterPoll — in-flight guard (anti gate-runaway / OOM)', () => {
  it('never runs overlapping cycles while a quote is slow', async () => {
    const handle = startKnifeJupiterPoll(
      { legUsd: 5, pollIntervalMs: 10, slippageBps: 300, timeoutMs: 8000, maxMintsPerTick: 1 },
      () => ['9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump'],
      () => {},
    );

    // Let the interval fire many times while the first quote hangs.
    await new Promise((r) => setTimeout(r, 120));

    // Guard: exactly one cycle → exactly one in-flight quote, no matter how many ticks fired.
    expect(quoteCalls).toBe(1);
    expect(maxActiveQuotes).toBe(1);

    // Release the hung quote; allow the next cycle to start, then confirm still no overlap.
    releasers.forEach((fn) => fn());
    await new Promise((r) => setTimeout(r, 40));
    expect(maxActiveQuotes).toBe(1);

    handle.stop();
    releasers.forEach((fn) => fn());
  });
});
