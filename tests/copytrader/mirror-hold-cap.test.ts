import { describe, expect, it } from 'vitest';
import { isLeaderFollowOnlyMarket } from '../../src/copytrader/leader-follow-only.js';
import {
  decideMirrorHoldCap,
  volumeSupportsHoldExtension,
} from '../../src/copytrader/mirror-hold-cap.js';

const cfg = {
  mirrorHoldCapMs: 1_800_000,
  mirrorHoldCapVolOkMs: 0,
  volFadeMinVolume5mUsd: 8_000,
  volFadeDropPct: 40,
  volFadeSampleWindow: 1,
  volFadeMinWeakSamples: 1,
  volFadeCheckIntervalMs: 0,
  sellRetryWindowMs: 7_200_000,
  leaderFollowOnlyMinMcapUsd: 0,
  leaderFollowOnlyMinVolume1hUsd: 0,
};

const stretchCfg = {
  ...cfg,
  mirrorHoldCapVolOkMs: 3_600_000,
  leaderFollowOnlyMinMcapUsd: 1_000_000,
  leaderFollowOnlyMinVolume1hUsd: 50_000,
};

describe('decideMirrorHoldCap', () => {
  it('sells when held ≥ 30m (no stretch)', () => {
    const d = decideMirrorHoldCap(cfg, {
      entryTs: 1_000_000,
      nowMs: 1_000_000 + 1_800_000,
    });
    expect(d.action).toBe('sell');
    if (d.action === 'sell') {
      expect(d.heldMs).toBe(1_800_000);
      expect(d.reason).toBe('base_cap');
    }
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

  it('extends to 60m when volume is healthy', () => {
    const at45m = decideMirrorHoldCap(stretchCfg, {
      entryTs: 1_000_000,
      nowMs: 1_000_000 + 2_700_000,
      volumeHealthy: true,
    });
    expect(at45m).toEqual({ action: 'hold', reason: 'vol_extended' });

    const at60m = decideMirrorHoldCap(stretchCfg, {
      entryTs: 1_000_000,
      nowMs: 1_000_000 + 3_600_000,
      volumeHealthy: true,
    });
    expect(at60m.action).toBe('sell');
    if (at60m.action === 'sell') expect(at60m.reason).toBe('vol_ok_cap');
  });

  it('sells at 30m when volume is weak or unknown', () => {
    const weak = decideMirrorHoldCap(stretchCfg, {
      entryTs: 1_000_000,
      nowMs: 1_000_000 + 1_800_000,
      volumeHealthy: false,
    });
    expect(weak.action).toBe('sell');
    if (weak.action === 'sell') expect(weak.reason).toBe('volume_weak');

    const unknown = decideMirrorHoldCap(stretchCfg, {
      entryTs: 1_000_000,
      nowMs: 1_000_000 + 1_800_000,
      volumeHealthy: null,
    });
    expect(unknown.action).toBe('sell');
    if (unknown.action === 'sell') expect(unknown.reason).toBe('volume_weak');
  });

  it('skips timeout on large liquid names (mcap+$1M, vol1h $50k)', () => {
    const d = decideMirrorHoldCap(stretchCfg, {
      entryTs: 1_000_000,
      nowMs: 1_000_000 + 3_600_000,
      volumeHealthy: false,
      marketCapUsd: 1_500_000,
      volume1hUsd: 80_000,
    });
    expect(d).toEqual({ action: 'hold', reason: 'leader_follow_only' });
  });
});

describe('isLeaderFollowOnlyMarket', () => {
  const floors = {
    leaderFollowOnlyMinMcapUsd: 1_000_000,
    leaderFollowOnlyMinVolume1hUsd: 50_000,
  };

  it('requires both floors', () => {
    expect(isLeaderFollowOnlyMarket(floors, { marketCapUsd: 2e6, volume1hUsd: 80_000 })).toBe(true);
    expect(isLeaderFollowOnlyMarket(floors, { marketCapUsd: 900_000, volume1hUsd: 80_000 })).toBe(false);
    expect(isLeaderFollowOnlyMarket(floors, { marketCapUsd: 2e6, volume1hUsd: 40_000 })).toBe(false);
    expect(isLeaderFollowOnlyMarket(floors, { marketCapUsd: null, volume1hUsd: 80_000 })).toBe(false);
  });
});

describe('volumeSupportsHoldExtension', () => {
  const volCfg = {
    volFadeMinVolume5mUsd: 8_000,
    volFadeDropPct: 40,
    volFadeSampleWindow: 1,
    volFadeMinWeakSamples: 1,
  };

  it('ok when above floor and not dropped vs entry', () => {
    expect(
      volumeSupportsHoldExtension(volCfg, {
        entryVolume5mUsd: 20_000,
        volume5mUsd: 15_000,
      }),
    ).toBe(true);
  });

  it('rejects below floor or dropped 40%+', () => {
    expect(
      volumeSupportsHoldExtension(volCfg, {
        entryVolume5mUsd: 20_000,
        volume5mUsd: 7_000,
      }),
    ).toBe(false);
    expect(
      volumeSupportsHoldExtension(volCfg, {
        entryVolume5mUsd: 20_000,
        volume5mUsd: 11_000,
      }),
    ).toBe(false);
  });

  it('multi-window: one weak sample does not kill extension while warming with prior ok', () => {
    const multi = {
      volFadeMinVolume5mUsd: 8_000,
      volFadeDropPct: 40,
      volFadeSampleWindow: 3,
      volFadeMinWeakSamples: 2,
    };
    expect(
      volumeSupportsHoldExtension(multi, {
        entryVolume5mUsd: 15_437,
        samples: [15_437, 8_663],
      }),
    ).toBe(false); // warming + already 1 weak → provisional extend only if weakCount===0
    expect(
      volumeSupportsHoldExtension(multi, {
        entryVolume5mUsd: 15_437,
        samples: [15_437, 14_000],
      }),
    ).toBe(true);
  });
});
