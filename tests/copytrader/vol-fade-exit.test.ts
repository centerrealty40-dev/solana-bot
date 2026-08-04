import { describe, expect, it } from 'vitest';
import {
  decideVolFadeExit,
  processVolFadeExits,
  type VolFadeConfig,
} from '../../src/copytrader/vol-fade-exit.js';
import type { CopyTraderState } from '../../src/copytrader/state.js';
import { COPY_LEADER_POSITION_SOURCE } from '../../src/copytrader/state.js';

const cfg: VolFadeConfig = {
  volFadeCheckIntervalMs: 300_000,
  volFadeMinVolume5mUsd: 8_000,
  volFadeDropPct: 40,
  sellRetryWindowMs: 3_600_000,
  leaderFollowOnlyMinMcapUsd: 0,
  leaderFollowOnlyMinVolume1hUsd: 0,
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
        { ...cfg, volFadeCheckIntervalMs: 0 },
        { entryVolume5mUsd: 20_000, volume5mUsd: 100 },
      ).action,
    ).toBe('hold');
  });

  it('sells when under absolute floor', () => {
    const res = decideVolFadeExit(cfg, { entryVolume5mUsd: 20_000, volume5mUsd: 5_000 });
    expect(res).toMatchObject({ action: 'sell', reason: 'below_floor' });
  });

  it('sells when dropped vs entry', () => {
    const res = decideVolFadeExit(cfg, { entryVolume5mUsd: 20_000, volume5mUsd: 11_000 });
    expect(res).toMatchObject({ action: 'sell', reason: 'dropped_vs_entry', volume5mUsd: 11_000 });
  });

  it('holds when volume is still healthy', () => {
    expect(
      decideVolFadeExit(cfg, { entryVolume5mUsd: 20_000, volume5mUsd: 15_000 }).action,
    ).toBe('hold');
  });

  it('holds when feed is missing', () => {
    expect(
      decideVolFadeExit(cfg, { entryVolume5mUsd: 20_000, volume5mUsd: null }).reason,
    ).toBe('volume_unknown');
  });

  it('holds on leader-follow-only markets even if 5m faded', () => {
    const res = decideVolFadeExit(
      {
        ...cfg,
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
});

describe('processVolFadeExits', () => {
  it('schedules a full sell after the interval when volume faded', async () => {
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
      cfg,
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
      cfg,
      state,
      { fetchVolume5mUsd: async () => 100 },
      now,
    );
    expect(out).toHaveLength(0);
    expect(state.pendingSells).toHaveLength(0);
  });
});
