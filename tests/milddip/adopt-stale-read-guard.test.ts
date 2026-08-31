import { describe, expect, it } from 'vitest';
import { adoptReadReplaysClosedBag } from '../../src/milddip/sell-empty-guard.js';

describe('adoptReadReplaysClosedBag', () => {
  const base = {
    onchainRaw: 22878791411n,
    lastExitAtMs: 1_000_000,
    lastExitPreExitTokenRaw: '22878791411' as string | null,
    nowMs: 1_005_000,
  };

  it('flags the just-sold bag read back inside the window', () => {
    expect(adoptReadReplaysClosedBag(base)).toBe(true);
  });

  it('lets a different balance through', () => {
    expect(adoptReadReplaysClosedBag({ ...base, onchainRaw: 12345678901n })).toBe(false);
  });

  it('lets an identical balance through once the window passed', () => {
    expect(adoptReadReplaysClosedBag({ ...base, nowMs: base.lastExitAtMs + 130_000 })).toBe(false);
  });

  it('is off without a remembered pre-exit balance', () => {
    expect(adoptReadReplaysClosedBag({ ...base, lastExitPreExitTokenRaw: null })).toBe(false);
  });

  it('ignores a non-numeric remembered balance', () => {
    expect(adoptReadReplaysClosedBag({ ...base, lastExitPreExitTokenRaw: 'abc' })).toBe(false);
  });
});
