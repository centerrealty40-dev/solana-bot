import { describe, expect, it } from 'vitest';
import { decideMirrorHoldCap } from '../../src/copytrader/mirror-hold-cap.js';

const cfg = { mirrorHoldCapMs: 1_800_000, sellRetryWindowMs: 7_200_000 };

describe('decideMirrorHoldCap', () => {
  it('sells when held ≥ 30m', () => {
    const d = decideMirrorHoldCap(cfg, {
      entryTs: 1_000_000,
      nowMs: 1_000_000 + 1_800_000,
    });
    expect(d.action).toBe('sell');
    if (d.action === 'sell') expect(d.heldMs).toBe(1_800_000);
  });

  it('holds under cap', () => {
    const d = decideMirrorHoldCap(cfg, {
      entryTs: 1_000_000,
      nowMs: 1_000_000 + 1_799_000,
    });
    expect(d).toEqual({ action: 'hold', reason: 'under_cap' });
  });

  it('disabled when cap is 0', () => {
    const d = decideMirrorHoldCap({ ...cfg, mirrorHoldCapMs: 0 }, { entryTs: 1, nowMs: 9e15 });
    expect(d).toEqual({ action: 'hold', reason: 'disabled' });
  });
});
