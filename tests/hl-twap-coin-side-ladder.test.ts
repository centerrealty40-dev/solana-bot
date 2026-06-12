import { describe, expect, it } from 'vitest';

import {
  distributeExchangeNotional,
  groupAvgEntryPx,
  groupMaxTpLevels,
  groupOpensByCoinSide,
  primaryOpenInGroup,
} from '../src/hyperliquid/twap/live/coin-side-ladder.js';
import type { HlTwapLiveOpen } from '../src/hyperliquid/twap/live/types.js';

function leg(hash: string, initial: number, current: number, tp = 0): HlTwapLiveOpen {
  return {
    hash,
    coin: 'HYPE',
    displaySymbol: 'HYPE',
    side: 'sell',
    entryTs: hash === 'a' ? 1 : 2,
    entryAnchorPx: 100,
    avgEntryPx: 100,
    initialNotionalUsd: initial,
    currentNotionalUsd: current,
    marginUsd: initial / 7,
    entryLeverage: 7,
    impactPct: 5,
    whaleUser: '0x1',
    minutes: 30,
    liveOpenAtMs: 1,
    liveCloseAtMs: 2,
    twapStartMs: 1,
    tpLevelsTaken: tp,
    dcaLevelsTaken: 0,
    whaleNotionalUsd: 1e6,
    whaleSize: 1,
  };
}

describe('coin-side-ladder', () => {
  it('groups opens by coin+side', () => {
    const opens = new Map<string, HlTwapLiveOpen>([
      ['a', leg('a', 3500, 3500)],
      ['b', leg('b', 3500, 3500)],
      ['c', { ...leg('c', 1000, 1000), coin: 'SOL', displaySymbol: 'SOL' }],
    ]);
    const groups = groupOpensByCoinSide(opens);
    expect(groups.get('HYPE:sell')?.length).toBe(2);
    expect(groups.get('SOL:sell')?.length).toBe(1);
  });

  it('distributes exchange gross by initial share', () => {
    const group = [leg('a', 3500, 3500), leg('b', 3500, 3500)];
    distributeExchangeNotional(group, 6000);
    expect(group[0]!.currentNotionalUsd).toBe(3000);
    expect(group[1]!.currentNotionalUsd).toBe(3000);
  });

  it('uses max tp level across legs', () => {
    const group = [leg('a', 3500, 3500, 1), leg('b', 3500, 3500, 0)];
    expect(groupMaxTpLevels(group)).toBe(1);
  });

  it('primary is earliest entry', () => {
    const group = [leg('b', 3500, 3500), leg('a', 3500, 3500)];
    expect(primaryOpenInGroup(group).hash).toBe('a');
  });

  it('groupAvgEntryPx is notional-weighted', () => {
    const g1 = leg('a', 100, 100);
    g1.avgEntryPx = 100;
    const g2 = leg('b', 100, 100);
    g2.avgEntryPx = 200;
    expect(groupAvgEntryPx([g1, g2])).toBe(150);
  });
});
