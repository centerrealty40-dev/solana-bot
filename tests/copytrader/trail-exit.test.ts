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

/** Legacy full-exit trail (no ladder). */
const cfg: TrailExitConfig = {
  trailArmPct: 8,
  trailGivebackPct: 6,
  trailTakeProfitPct: 0,
  trailTpStepPct: 0,
  trailTpSellFraction: 0.5,
  trailTrailSellFraction: 1,
  trailKillPct: 0,
  trailTimeCapMs: 2_700_000,
};

/** Oscar half8_runner shape. */
const oscar: TrailExitConfig = {
  trailArmPct: 8,
  trailGivebackPct: 8,
  trailTakeProfitPct: 0,
  trailTpStepPct: 8,
  trailTpSellFraction: 0.5,
  trailTrailSellFraction: 0.2,
  trailKillPct: 50,
  trailTimeCapMs: 0,
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

  it('exits fully after giving back when trail sell fraction is 1', () => {
    const d = decideTrailExit(cfg, {
      entryPriceUsd: ENTRY,
      currentPriceUsd: ENTRY * 1.3,
      peakPriceUsd: ENTRY * 1.5,
      entryTs: T0,
      trailArmedAt: T0 + 10_000,
      nowMs: T0 + 120_000,
    });
    expect(d.action).toBe('sell');
    expect(d.reason).toBe('trail_giveback');
    expect(d.fraction).toBe(1);
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

  it('legacy hard take-profit only when the ladder is off', () => {
    const d = decideTrailExit({ ...cfg, trailTakeProfitPct: 25 }, {
      entryPriceUsd: ENTRY,
      currentPriceUsd: ENTRY * 1.26,
      entryTs: T0,
      nowMs: T0 + 60_000,
    });
    expect(d.action).toBe('sell');
    expect(d.reason).toBe('take_profit');
    expect(d.fraction).toBe(1);
  });

  it('protects an +18% spike once the trail is armed at +8%', () => {
    const d = decideTrailExit({ ...cfg, trailGivebackPct: 8 }, {
      entryPriceUsd: ENTRY,
      currentPriceUsd: ENTRY * 1.05,
      peakPriceUsd: ENTRY * 1.18,
      entryTs: T0,
      trailArmedAt: T0 + 10_000,
      nowMs: T0 + 120_000,
    });
    expect(d.action).toBe('sell');
    expect(d.reason).toBe('trail_giveback');
  });

  it('exits an unarmed position at the time cap', () => {
    const d = decideTrailExit(cfg, {
      entryPriceUsd: ENTRY,
      currentPriceUsd: ENTRY * 0.95,
      entryTs: T0,
      nowMs: T0 + 2_700_001,
    });
    expect(d.action).toBe('sell');
    expect(d.reason).toBe('time_cap');
  });

  it('skips the time cap once a TP rung has already peeled', () => {
    const d = decideTrailExit(
      { ...oscar, trailTimeCapMs: 1_800_000 },
      {
        entryPriceUsd: ENTRY,
        currentPriceUsd: ENTRY * 1.05,
        tpRungsTaken: 1,
        trailArmedAt: T0 + 10_000,
        sizeUsd: 50,
        entryTs: T0,
        nowMs: T0 + 1_800_001,
      },
    );
    expect(d.action).toBe('hold');
    expect(d.reason).toBeUndefined();
  });

  it('skips the time cap once a trail giveback has peeled', () => {
    const d = decideTrailExit(
      { ...oscar, trailTimeCapMs: 1_800_000 },
      {
        entryPriceUsd: ENTRY,
        currentPriceUsd: ENTRY * 1.12,
        peakPriceUsd: ENTRY * 1.2,
        tpRungsTaken: 1,
        trailGivebackStepsTaken: 1,
        trailArmedAt: T0 + 10_000,
        sizeUsd: 50,
        entryTs: T0,
        nowMs: T0 + 1_800_001,
      },
    );
    expect(d.action).toBe('hold');
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

describe('oscar half8-style ladder', () => {
  it('peels 50% at +8% instead of banking the whole bag', () => {
    const d = decideTrailExit(oscar, {
      entryPriceUsd: ENTRY,
      currentPriceUsd: ENTRY * 1.09,
      sizeUsd: 100,
      entryTs: T0,
      nowMs: T0 + 60_000,
    });
    expect(d.action).toBe('sell');
    expect(d.reason).toBe('tp_rung');
    expect(d.fraction).toBe(0.5);
    expect(d.tpRungsTaken).toBe(1);
  });

  it('peels another 50% of remainder at +16%', () => {
    const d = decideTrailExit(oscar, {
      entryPriceUsd: ENTRY,
      currentPriceUsd: ENTRY * 1.17,
      tpRungsTaken: 1,
      sizeUsd: 100,
      entryTs: T0,
      trailArmedAt: T0,
      nowMs: T0 + 60_000,
    });
    expect(d.action).toBe('sell');
    expect(d.reason).toBe('tp_rung');
    expect(d.fraction).toBe(0.5);
    expect(d.tpRungsTaken).toBe(2);
  });

  it('does not hard-cap a +200% runner — only peels the next rung', () => {
    const d = decideTrailExit(oscar, {
      entryPriceUsd: ENTRY,
      currentPriceUsd: ENTRY * 3.0,
      tpRungsTaken: 0,
      sizeUsd: 100,
      entryTs: T0,
      nowMs: T0 + 60_000,
    });
    expect(d.action).toBe('sell');
    expect(d.reason).toBe('tp_rung');
    expect(d.fraction).toBe(0.5);
    expect(d.gainPct).toBeCloseTo(200, 8);
  });

  it('on giveback sells 20% of remainder, not the whole runner', () => {
    const d = decideTrailExit(oscar, {
      entryPriceUsd: ENTRY,
      currentPriceUsd: ENTRY * 1.1,
      peakPriceUsd: ENTRY * 1.3,
      tpRungsTaken: 1,
      sizeUsd: 100,
      entryTs: T0,
      trailArmedAt: T0,
      nowMs: T0 + 120_000,
    });
    expect(d.action).toBe('sell');
    expect(d.reason).toBe('trail_giveback');
    expect(d.fraction).toBe(0.2);
    expect(d.trailGivebackStepsTaken).toBe(1);
  });

  it('kills at −50%', () => {
    const d = decideTrailExit(oscar, {
      entryPriceUsd: ENTRY,
      currentPriceUsd: ENTRY * 0.49,
      sizeUsd: 100,
      entryTs: T0,
      nowMs: T0 + 60_000,
    });
    expect(d.action).toBe('sell');
    expect(d.reason).toBe('kill');
    expect(d.fraction).toBe(1);
  });

  it('ignores the legacy hard TP when the ladder is on', () => {
    const d = decideTrailExit({ ...oscar, trailTakeProfitPct: 25 }, {
      entryPriceUsd: ENTRY,
      currentPriceUsd: ENTRY * 1.3,
      tpRungsTaken: 1,
      sizeUsd: 100,
      entryTs: T0,
      trailArmedAt: T0,
      nowMs: T0 + 60_000,
    });
    expect(d.reason).toBe('tp_rung');
    expect(d.fraction).toBe(0.5);
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

function runnerCfg(over: Partial<TrailExitConfig> = {}): CopyTraderConfig {
  return { ...cfg, ...over } as CopyTraderConfig;
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
    expect(events[0]?.fraction).toBe(1);
    expect(state.positions.Mint111?.peakPriceUsd).toBeCloseTo(ENTRY, 12);
  });

  it('does not time-cap a position that already took a TP rung', async () => {
    const state = emptyCopyTraderState();
    state.positions.Mint111 = position({ trailTpRungsTaken: 1, trailArmedAt: T0 + 10_000 });
    const events: TrailExitEvent[] = [];

    const n = await processTrailingExits(
      runnerCfg({ ...oscar, trailTimeCapMs: 1_800_000 }),
      state,
      {
        resolvePriceUsd: async () => ENTRY * 1.04,
        scheduleExit: (e) => events.push(e),
      },
      T0 + 1_800_001,
    );

    expect(n).toBe(0);
    expect(events).toHaveLength(0);
  });
});
