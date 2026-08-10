import { describe, expect, it } from 'vitest';
import { nextDexScreenerGrantAt } from '../../src/papertrader/pricing/dexscreener-quote-cache.js';

describe('nextDexScreenerGrantAt', () => {
  it('clamps runaway nextAllowedMs to now', () => {
    const now = 1_000_000;
    const r = nextDexScreenerGrantAt({
      nowMs: now,
      nextAllowedMs: now + 1_200_000, // 20m ahead
      minGapMs: 500,
      maxBacklogMs: 30_000,
    });
    expect(r.clamped).toBe(true);
    expect(r.grantAt).toBe(now);
    expect(r.waitMs).toBe(0);
    expect(r.nextAllowedMs).toBe(now + 500);
  });

  it('preserves normal short backlog', () => {
    const now = 1_000_000;
    const r = nextDexScreenerGrantAt({
      nowMs: now,
      nextAllowedMs: now + 5_000,
      minGapMs: 500,
      maxBacklogMs: 30_000,
    });
    expect(r.clamped).toBe(false);
    expect(r.grantAt).toBe(now + 5_000);
    expect(r.waitMs).toBe(5_000);
    expect(r.nextAllowedMs).toBe(now + 5_500);
  });
});
