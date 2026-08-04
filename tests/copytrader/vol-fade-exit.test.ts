import { describe, expect, it } from 'vitest';
import {
  decideVolFadeExit,
  processVolFadeExits,
  type VolFadeConfig,
} from '../../src/copytrader/vol-fade-exit.js';
import type { CopyTraderState } from '../../src/copytrader/state.js';
import { COPY_LEADER_POSITION_SOURCE } from '../../src/copytrader/state.js';

const legacyCfg: VolFadeConfig = {
  volFadeCheckIntervalMs: 300_000,
  volFadeMinVolume5mUsd: 8_000,
  volFadeDropPct: 40,
  volFadeSampleWindow: 1,
  volFadeMinWeakSamples: 1,
  sellRetryWindowMs: 3_600_000,
  leaderFollowOnlyMinMcapUsd: 0,
  leaderFollowOnlyMinVolume1hUsd: 0,
};

const multiCfg: VolFadeConfig = {
  ...legacyCfg,
  volFadeSampleWindow: 3,
  volFadeMinWeakSamples: 2,
};

function emptyState(): CopyTraderState {
  return {
    seenSignatures: {},
    pendingBuys: [],
    pendingSells: [],
    positions: {},
    leaderLedger: {},
    leaderHistory: {},
  };
}

describe('decideVolFadeExit', () => {
  it('holds when disabled', () => {
    expect(
      decideVolFadeExit(
        { ...legacyCfg, volFadeCheckIntervalMs: 0 },
        { entryVolume5mUsd: 20_000, volume5mUsd: 100 },
      ).action,
    ).toBe('hold');
  });

  it('sells when under absolute floor (legacy single tick)', () => {
    const res = decideVolFadeExit(legacyCfg, { entryVolume5mUsd: 20_000, volume5mUsd: 5_000 });
    expect(res).toMatchObject({ action: 'sell', reason: 'below_floor' });
  });

  it('sells when dropped vs entry (legacy single tick)', () => {
    const res = decideVolFadeExit(legacyCfg, { entryVolume5mUsd: 20_000, volume5mUsd: 11_000 });
    expect(res).toMatchObject({ action: 'sell', reason: 'dropped_vs_entry', volume5mUsd: 11_000 });
  });

  it('holds when volume is still healthy', () => {
    expect(
      decideVolFadeExit(legacyCfg, { entryVolume5mUsd: 20_000, volume5mUsd: 15_000 }).action,
    ).toBe('hold');
  });

  it('holds when feed is missing', () => {
    expect(
      decideVolFadeExit(legacyCfg, { entryVolume5mUsd: 20_000, volume5mUsd: null }).reason,
    ).toBe('volume_unknown');
  });

  it('holds on leader-follow-only markets even if 5m faded', () => {
    const res = decideVolFadeExit(
      {
        ...legacyCfg,
        leaderFollowOnlyMinMcapUsd: 1_000_000,
        leaderFollowOnlyMinVolume1hUsd: 50_000,
      },
      {
        entryVolume5mUsd: 20_000,
        volume5mUsd: 5_000,
        marketCapUsd: 2_000_000,
        volume1hUsd: 80_000,
      },
    );
    expect(res).toEqual({ action: 'hold', reason: 'leader_follow_only' });
  });

  it('multi-window: one weak tick is warming, not a sell', () => {
    const res = decideVolFadeExit(multiCfg, {
      entryVolume5mUsd: 15_437,
      volume5mUsd: 8_663,
      samples: [15_437, 8_663],
    });
    expect(res).toEqual({ action: 'hold', reason: 'warming' });
  });

  it('multi-window: 2/3 weak → sell', () => {
    const res = decideVolFadeExit(multiCfg, {
      entryVolume5mUsd: 15_437,
      volume5mUsd: 7_500,
      samples: [15_437, 14_000, 8_663, 7_500],
    });
    expect(res.action).toBe('sell');
    if (res.action === 'sell') {
      expect(res.weakCount).toBe(2);
      expect(res.sampleCount).toBe(3);
    }
  });
});

describe('processVolFadeExits', () => {
  it('schedules a full sell after the interval when volume faded (legacy)', async () => {
    const state = emptyState();
    const now = 1_000_000;
    state.positions.MintA = {
      mint: 'MintA',
      symbol: 'AAA',
      positionSource: COPY_LEADER_POSITION_SOURCE,
      entryTs: now - 400_000,
      entryPriceUsd: 1,
      sizeUsd: 100,
      addCount: 0,
      leaderWallet: 'L',
      leaderEntrySig: 'sig',
      entryVolume5mUsd: 20_000,
      lastVolFadeCheckTs: now - 400_000,
    };

    const out = await processVolFadeExits(
      legacyCfg,
      state,
      { fetchVolume5mUsd: async () => 4_000 },
      now,
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.reason).toBe('below_floor');
    expect(state.pendingSells).toHaveLength(1);
    expect(state.pendingSells[0]?.fraction).toBe(1);
    expect(state.pendingSells[0]?.dueTs).toBe(now);
    expect(state.positions.MintA?.lastVolFadeCheckTs).toBe(now);
    expect(state.positions.MintA?.volume5mSamples).toEqual([4_000]);
  });

  it('multi-window: accumulates samples and waits for majority', async () => {
    const state = emptyState();
    const t0 = 1_000_000;
    state.positions.MintA = {
      mint: 'MintA',
      symbol: 'AAA',
      positionSource: COPY_LEADER_POSITION_SOURCE,
      entryTs: t0,
      entryPriceUsd: 1,
      sizeUsd: 100,
      addCount: 0,
      leaderWallet: 'L',
      leaderEntrySig: 'sig',
      entryVolume5mUsd: 20_000,
      volume5mSamples: [20_000],
      lastVolFadeCheckTs: t0,
    };

    const first = await processVolFadeExits(
      multiCfg,
      state,
      { fetchVolume5mUsd: async () => 8_500 },
      t0 + 300_000,
    );
    expect(first).toHaveLength(0);
    expect(state.positions.MintA?.volume5mSamples).toEqual([20_000, 8_500]);

    const second = await processVolFadeExits(
      multiCfg,
      state,
      { fetchVolume5mUsd: async () => 7_000 },
      t0 + 600_000,
    );
    // window still size 3 not full (samples=3) — 8500 weak drop, 7000 below floor; 2 weak but warming until window full...
    // samples [20000, 8500, 7000] length===3 → full window, weakCount=2 → sell
    expect(second).toHaveLength(1);
    expect(second[0]?.weakCount).toBe(2);
  });

  it('does not check before the interval elapses', async () => {
    const state = emptyState();
    const now = 1_000_000;
    state.positions.MintA = {
      mint: 'MintA',
      symbol: 'AAA',
      positionSource: COPY_LEADER_POSITION_SOURCE,
      entryTs: now - 60_000,
      entryPriceUsd: 1,
      sizeUsd: 100,
      addCount: 0,
      leaderWallet: 'L',
      leaderEntrySig: 'sig',
      entryVolume5mUsd: 20_000,
      lastVolFadeCheckTs: now - 60_000,
    };
    const out = await processVolFadeExits(
      legacyCfg,
      state,
      { fetchVolume5mUsd: async () => 100 },
      now,
    );
    expect(out).toHaveLength(0);
  });
});
