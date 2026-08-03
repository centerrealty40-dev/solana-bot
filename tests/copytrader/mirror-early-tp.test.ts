import { describe, expect, it } from 'vitest';
import { decideMirrorEarlyTp } from '../../src/copytrader/mirror-early-tp.js';

const cfg = {
  mirrorEarlyTpGainPct: 20,
  mirrorEarlyTpSellFraction: 0.5,
  sellRetryWindowMs: 7_200_000,
};

describe('decideMirrorEarlyTp', () => {
  it('sells 50% at +20%', () => {
    const d = decideMirrorEarlyTp(cfg, {
      entryPriceUsd: 1,
      priceUsd: 1.21,
      hasPendingSell: false,
    });
    expect(d.action).toBe('sell');
    if (d.action === 'sell') {
      expect(d.gainPct).toBeCloseTo(21, 5);
      expect(d.sellFraction).toBe(0.5);
    }
  });

  it('holds below gain', () => {
    const d = decideMirrorEarlyTp(cfg, {
      entryPriceUsd: 1,
      priceUsd: 1.19,
      hasPendingSell: false,
    });
    expect(d).toEqual({ action: 'hold', reason: 'below_gain' });
  });

  it('holds after leader sold', () => {
    const d = decideMirrorEarlyTp(cfg, {
      entryPriceUsd: 1,
      priceUsd: 1.5,
      leaderSoldSinceEntry: true,
      hasPendingSell: false,
    });
    expect(d).toEqual({ action: 'hold', reason: 'leader_sold' });
  });

  it('holds once already taken', () => {
    const d = decideMirrorEarlyTp(cfg, {
      entryPriceUsd: 1,
      priceUsd: 1.5,
      mirrorEarlyTpTaken: true,
      hasPendingSell: false,
    });
    expect(d).toEqual({ action: 'hold', reason: 'already_taken' });
  });

  it('disabled when gain pct is 0', () => {
    const d = decideMirrorEarlyTp(
      { ...cfg, mirrorEarlyTpGainPct: 0 },
      { entryPriceUsd: 1, priceUsd: 2, hasPendingSell: false },
    );
    expect(d).toEqual({ action: 'hold', reason: 'disabled' });
  });
});
