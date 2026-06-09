import { describe, expect, it } from 'vitest';
import { parseFollowSlMode, stopLossAllowed } from '../../src/pumpswap-combo-follow/exit-policy.js';
import {
  defaultSimParams,
  simulateFollowExits,
  type FollowSimEvent,
} from '../../src/pumpswap-combo-follow/follow-exit-sim.js';

describe('parseFollowSlMode', () => {
  it('defaults to while_leader_holds_off', () => {
    expect(parseFollowSlMode(undefined)).toBe('while_leader_holds_off');
  });

  it('maps legacy alias to fixed', () => {
    expect(parseFollowSlMode('fixed')).toBe('fixed');
    expect(parseFollowSlMode('legacy')).toBe('fixed');
  });
});

describe('stopLossAllowed', () => {
  it('blocks SL while leader holds in while_leader_holds_off mode', () => {
    expect(
      stopLossAllowed({
        slMode: 'while_leader_holds_off',
        leaderHolds: true,
        leaderSoldSinceOpen: false,
      }),
    ).toBe(false);
    expect(
      stopLossAllowed({
        slMode: 'while_leader_holds_off',
        leaderHolds: false,
        leaderSoldSinceOpen: false,
      }),
    ).toBe(true);
  });

  it('always allows SL in fixed mode', () => {
    expect(
      stopLossAllowed({
        slMode: 'fixed',
        leaderHolds: true,
        leaderSoldSinceOpen: false,
      }),
    ).toBe(true);
  });

  it('requires leader sell + flat for after_leader_sell', () => {
    expect(
      stopLossAllowed({
        slMode: 'after_leader_sell',
        leaderHolds: true,
        leaderSoldSinceOpen: true,
      }),
    ).toBe(false);
    expect(
      stopLossAllowed({
        slMode: 'after_leader_sell',
        leaderHolds: false,
        leaderSoldSinceOpen: true,
      }),
    ).toBe(true);
    expect(
      stopLossAllowed({
        slMode: 'after_leader_sell',
        leaderHolds: false,
        leaderSoldSinceOpen: false,
      }),
    ).toBe(false);
  });
});

describe('simulateFollowExits', () => {
  const snapshots = new Map([
    [
      'MintA',
      {
        tsMs: [1000, 2000, 3000, 4000, 5000],
        px: [100, 90, 80, 115, 120],
      },
    ],
  ]);

  const events: FollowSimEvent[] = [
    { kind: 'leader_buy', ts: 1000, mint: 'MintA', priceUsd: 100, amountUsd: 50, baseRaw: 1000n },
    { kind: 'leader_buy', ts: 2500, mint: 'MintA', priceUsd: 85, amountUsd: 40, baseRaw: 1000n },
    { kind: 'leader_sell', ts: 4500, mint: 'MintA', priceUsd: 115, baseRaw: 2000n },
  ];

  it('fixed SL exits underwater before leader sells', () => {
    const dipSnapshots = new Map([
      [
        'MintA',
        {
          tsMs: [1000, 2000, 3000, 4000, 5000],
          px: [100, 70, 65, 115, 120],
        },
      ],
    ]);
    const r = simulateFollowExits({
      events,
      snapshotsByMint: dipSnapshots,
      params: defaultSimParams({
        slMode: 'fixed',
        maxBuyLegs: 2,
        slSingleLegPct: 15,
        slMultiLegPct: 15,
        slPreDcaPct: 15,
      }),
    });
    expect(r.stopLossCount).toBeGreaterThan(0);
  });

  it('while_leader_holds_off avoids SL during leader DCA', () => {
    const r = simulateFollowExits({
      events,
      snapshotsByMint: snapshots,
      params: defaultSimParams({ slMode: 'while_leader_holds_off', slSingleLegPct: 15, slMultiLegPct: 15 }),
    });
    expect(r.stopLossCount).toBe(0);
    expect(r.sumPnlUsd).toBeGreaterThan(-1);
  });
});
