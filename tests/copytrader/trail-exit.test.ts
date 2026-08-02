import { describe, expect, it } from 'vitest';
import {
  decideTrailExit,
  isSaneTrailMark,
  processTrailingExits,
  type TrailExitConfig,
  type TrailExitEvent,
} from '../../src/copytrader/trail-exit.js';
import type { CopyTraderConfig } from '../../src/copytrader/config.js';
import { emptyCopyTraderState, type CopyPosition } from '../../src/copytrader/state.js';

const cfg: TrailExitConfig = {
  trailArmPct: 8,
  trailGivebackPct: 6,
  trailTimeCapMs: 2_700_000,
};

const ENTRY = 0.001;
const T0 = 1_000_000;

describe('trail exit decision', () => {
  it('holds an unarmed position that is only slightly up', () => {
    const d = decideTrailExit(cfg, {
      entryPriceUsd: ENTRY,
      currentPriceUsd: ENTRY * 1.03,
      entryTs: T0,
      nowMs: T0 + 60_000,
    });
    expect(d.action).toBe('hold');
    expect(d.armed).toBe(false);
  });

  it('does not stop out an unarmed position that is down', () => {
    const d = decideTrailExit(cfg, {
      entryPriceUsd: ENTRY,
      currentPriceUsd: ENTRY * 0.7,
      entryTs: T0,
      nowMs: T0 + 60_000,
    });
    expect(d.action).toBe('hold');
    expect(d.armed).toBe(false);
  });

  it('arms once the position clears the arm threshold', () => {
    const d = decideTrailExit(cfg, {
      entryPriceUsd: ENTRY,
      currentPriceUsd: ENTRY * 1.09,
      entryTs: T0,
      nowMs: T0 + 60_000,
    });
    expect(d.armed).toBe(true);
    expect(d.action).toBe('hold');
    expect(d.peakPriceUsd).toBeCloseTo(ENTRY * 1.09, 12);
  });

  it('exits after giving back the configured share of the peak', () => {
    const d = decideTrailExit(cfg, {
      entryPriceUsd: ENTRY,
      currentPriceUsd: ENTRY * 1.3,
      peakPriceUsd: ENTRY * 1.5,
      entryTs: T0,
      trailArmedAt: T0 + 10_000,
      nowMs: T0 + 120_000,
    });
    expect(d.action).toBe('exit');
    expect(d.reason).toBe('trail_giveback');
  });

  it('keeps riding while the pullback stays inside the giveback band', () => {
    const d = decideTrailExit(cfg, {
      entryPriceUsd: ENTRY,
      currentPriceUsd: ENTRY * 1.46,
      peakPriceUsd: ENTRY * 1.5,
      entryTs: T0,
      trailArmedAt: T0 + 10_000,
      nowMs: T0 + 120_000,
    });
    expect(d.action).toBe('hold');
    expect(d.peakPriceUsd).toBeCloseTo(ENTRY * 1.5, 12);
  });

  it('ratchets the peak upward and never down', () => {
    const d = decideTrailExit(cfg, {
      entryPriceUsd: ENTRY,
      currentPriceUsd: ENTRY * 2,
      peakPriceUsd: ENTRY * 1.5,
      entryTs: T0,
      trailArmedAt: T0,
      nowMs: T0 + 120_000,
    });
    expect(d.peakPriceUsd).toBeCloseTo(ENTRY * 2, 12);
  });

  it('exits an unarmed position at the time cap', () => {
    const d = decideTrailExit(cfg, {
      entryPriceUsd: ENTRY,
      currentPriceUsd: ENTRY * 0.95,
      entryTs: T0,
      nowMs: T0 + 2_700_001,
    });
    expect(d.action).toBe('exit');
    expect(d.reason).toBe('time_cap');
  });

  it('holds when the mark is missing rather than guessing', () => {
    const d = decideTrailExit(cfg, {
      entryPriceUsd: ENTRY,
      currentPriceUsd: 0,
      entryTs: T0,
      nowMs: T0 + 120_000,
    });
    expect(d.action).toBe('hold');
  });
});

describe('mark sanity band', () => {
  it('accepts a real run and rejects a wrong-pair quote', () => {
    expect(isSaneTrailMark(ENTRY, ENTRY * 10)).toBe(true);
    expect(isSaneTrailMark(ENTRY, ENTRY * 4500)).toBe(false);
    expect(isSaneTrailMark(ENTRY, ENTRY / 900)).toBe(false);
    expect(isSaneTrailMark(ENTRY, 0)).toBe(false);
  });
});

function position(over: Partial<CopyPosition> = {}): CopyPosition {
  return {
    mint: 'Mint111',
    symbol: 'MINT',
    entryTs: T0,
    entryPriceUsd: ENTRY,
    sizeUsd: 100,
    addCount: 0,
    leaderWallet: 'Leader111',
    leaderEntrySig: 'sig1',
    tokenRaw: '1000000',
    ...over,
  };
}

function runnerCfg(): CopyTraderConfig {
  return cfg as CopyTraderConfig;
}

describe('processTrailingExits', () => {
  it('schedules one exit and records the peak on the position', async () => {
    const state = emptyCopyTraderState();
    state.positions.Mint111 = position();
    const events: TrailExitEvent[] = [];

    const n = await processTrailingExits(
      runnerCfg(),
      state,
      {
        resolvePriceUsd: async () => ENTRY * 0.9,
        scheduleExit: (e) => events.push(e),
      },
      T0 + 2_700_001,
    );

    expect(n).toBe(1);
    expect(events[0]?.reason).toBe('time_cap');
    expect(state.positions.Mint111?.peakPriceUsd).toBeCloseTo(ENTRY, 12);
  });

  it('marks the trail armed so a later pullback can trip it', async () => {
    const state = emptyCopyTraderState();
    state.positions.Mint111 = position();
    const events: TrailExitEvent[] = [];
    const deps = {
      resolvePriceUsd: async () => ENTRY * 1.2,
      scheduleExit: (e: TrailExitEvent) => events.push(e),
    };

    await processTrailingExits(runnerCfg(), state, deps, T0 + 60_000);
    expect(state.positions.Mint111?.trailArmedAt).toBe(T0 + 60_000);
    expect(events).toHaveLength(0);

    await processTrailingExits(
      runnerCfg(),
      state,
      { ...deps, resolvePriceUsd: async () => ENTRY * 1.1 },
      T0 + 120_000,
    );
    expect(events[0]?.reason).toBe('trail_giveback');
  });

  it('leaves positions handed to oscar alone', async () => {
    const state = emptyCopyTraderState();
    state.positions.Mint111 = position({ oscarPromotedAt: T0 + 1 });
    const events: TrailExitEvent[] = [];

    const n = await processTrailingExits(
      runnerCfg(),
      state,
      { resolvePriceUsd: async () => ENTRY * 0.5, scheduleExit: (e) => events.push(e) },
      T0 + 9_000_000,
    );
    expect(n).toBe(0);
  });

  it('defers to an already queued sell', async () => {
    const state = emptyCopyTraderState();
    state.positions.Mint111 = position();
    state.pendingSells.push({
      id: 'ps1',
      mint: 'Mint111',
      symbol: 'MINT',
      leaderSignature: 'sig2',
      leaderSellTs: T0,
      dueTs: T0,
      fraction: 1,
      retryUntilTs: T0 + 100,
    });

    const n = await processTrailingExits(
      runnerCfg(),
      state,
      { resolvePriceUsd: async () => ENTRY * 0.5, scheduleExit: () => undefined },
      T0 + 9_000_000,
    );
    expect(n).toBe(0);
  });

  it('still exits at the cap when the mark is unusable', async () => {
    const state = emptyCopyTraderState();
    state.positions.Mint111 = position();
    const events: TrailExitEvent[] = [];

    const n = await processTrailingExits(
      runnerCfg(),
      state,
      { resolvePriceUsd: async () => 0, scheduleExit: (e) => events.push(e) },
      T0 + 2_700_001,
    );
    expect(n).toBe(1);
    expect(events[0]?.reason).toBe('time_cap');
  });

  it('does not exit on an unusable mark before the cap', async () => {
    const state = emptyCopyTraderState();
    state.positions.Mint111 = position();

    const n = await processTrailingExits(
      runnerCfg(),
      state,
      { resolvePriceUsd: async () => 0, scheduleExit: () => undefined },
      T0 + 60_000,
    );
    expect(n).toBe(0);
  });
});
