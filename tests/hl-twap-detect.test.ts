import { describe, expect, it } from 'vitest';

import {
  createTwapWatchState,
  crossingImpactDecision,
  detectTwapChanges,
  markTwapOpenedNotified,
  seedTwapWatchState,
  whaleCoinKey,
} from '../src/hyperliquid/twap/detect.js';
import type { HypurrscanTwapRow, NormalizedTwapSignal } from '../src/hyperliquid/twap/types.js';

const baseRow: HypurrscanTwapRow = {
  time: 1000,
  user: '0xabc',
  block: 1,
  hash: '0x1',
  error: null,
  action: {
    type: 'twapOrder',
    twap: { a: 159, b: true, s: '100', r: false, m: 5, t: false },
  },
};

function norm(row: HypurrscanTwapRow, impactPct: number, side: 'buy' | 'sell' = 'buy'): NormalizedTwapSignal {
  return {
    hash: row.hash,
    twapId: null,
    user: baseRow.user,
    side,
    coin: 'HYPE',
    displaySymbol: 'HYPE',
    isSpot: false,
    size: 100,
    minutes: 5,
    randomize: false,
    reduceOnly: false,
    notionalUsd: 5_000,
    midPx: 65,
    dayNtlVlmUsd: 2e9,
    volumeSharePct: impactPct,
    startedAtMs: row.time,
    block: row.block,
    ended: row.ended ?? null,
  };
}

describe('hl-twap detect', () => {
  it('allows sell TWAP with impact ≥ 1% without prior buy', () => {
    const state = createTwapWatchState();
    const sellRow = { ...baseRow, hash: '0xsell' };
    const r = detectTwapChanges([sellRow], (row) => norm(row, 2, 'sell'), state, {
      minVolumeSharePct: 1,
      buyOnly: false,
    });
    expect(r.newSignals).toHaveLength(1);
    expect(r.newSignals[0]!.side).toBe('sell');
  });

  it('blocks weaker side when crossing TWAPs differ by ≤ 1%', () => {
    const state = createTwapWatchState();
    detectTwapChanges([baseRow], (r) => norm(r, 3), state, { minVolumeSharePct: 1 });
    const sellRow = { ...baseRow, hash: '0x2' };
    const r = detectTwapChanges([baseRow, sellRow], (row) => norm(row, 2, row.hash === '0x2' ? 'sell' : 'buy'), state, {
      minVolumeSharePct: 1,
    });
    expect(r.newSignals).toHaveLength(0);
  });

  it('allows dominant sell when crossing diff > 1%', () => {
    const state = createTwapWatchState();
    detectTwapChanges([baseRow], (r) => norm(r, 2), state, { minVolumeSharePct: 1 });
    const sellRow = { ...baseRow, hash: '0x2' };
    const r = detectTwapChanges(
      [baseRow, sellRow],
      (row) => norm(row, row.hash === '0x2' ? 4 : 2, row.hash === '0x2' ? 'sell' : 'buy'),
      state,
      { minVolumeSharePct: 1 },
    );
    expect(r.newSignals).toHaveLength(1);
    expect(r.newSignals[0]!.side).toBe('sell');
  });

  it('crossingImpactDecision requires both sides ≥ min and diff > min', () => {
    expect(crossingImpactDecision(3, 2, 1)).toEqual({ allow: false, dominant: null, diffPct: 1 });
    expect(crossingImpactDecision(4, 2, 1)).toEqual({ allow: true, dominant: 'buy', diffPct: 2 });
    expect(crossingImpactDecision(2, 4.5, 1)).toEqual({ allow: true, dominant: 'sell', diffPct: 2.5 });
  });

  it('legacy buyOnly blocks sell without buy OPEN', () => {
    const state = createTwapWatchState();
    const sellRow = { ...baseRow, hash: '0xsell' };
    const r = detectTwapChanges([sellRow], (row) => norm(row, 2, 'sell'), state, {
      minVolumeSharePct: 1,
      buyOnly: true,
    });
    expect(r.newSignals).toHaveLength(0);
  });

  it('legacy buyOnly allows sell after buy notified', () => {
    const state = createTwapWatchState();
    const buy = norm(baseRow, 2);
    detectTwapChanges([baseRow], () => buy, state, { minVolumeSharePct: 1, buyOnly: true });
    markTwapOpenedNotified(state, buy);

    const sellRow = { ...baseRow, hash: '0x2' };
    const r = detectTwapChanges([sellRow], (row) => norm(row, 2, 'sell'), state, {
      minVolumeSharePct: 1,
      buyOnly: true,
    });
    expect(r.newSignals).toHaveLength(1);
    expect(state.buyNotifiedByWhaleCoin.has(whaleCoinKey(buy))).toBe(true);
  });

  it('filters by price impact on buy TWAP', () => {
    const state = createTwapWatchState();
    const r1 = detectTwapChanges([baseRow], (r) => norm(r, 0.5), state, { minVolumeSharePct: 1 });
    expect(r1.newSignals).toHaveLength(0);

    const state2 = createTwapWatchState();
    const r2 = detectTwapChanges([baseRow], (r) => norm(r, 1.5), state2, { minVolumeSharePct: 1 });
    expect(r2.newSignals).toHaveLength(1);
  });

  it('emits end once after open was notified', () => {
    const state = createTwapWatchState();
    detectTwapChanges([baseRow], (r) => norm(r, 2), state, { minVolumeSharePct: 1 });
    markTwapOpenedNotified(state, norm(baseRow, 2));
    const endedRow = { ...baseRow, ended: 'finished' };
    const r1 = detectTwapChanges([endedRow], (r) => norm(r, 2), state, { minVolumeSharePct: 1 });
    expect(r1.endedSignals).toHaveLength(1);
    const r2 = detectTwapChanges([endedRow], (r) => norm(r, 2), state, { minVolumeSharePct: 1 });
    expect(r2.endedSignals).toHaveLength(0);
  });

  it('skips end when open was never notified (e.g. seed only)', () => {
    const state = createTwapWatchState();
    seedTwapWatchState([baseRow], (r) => norm(r, 2), state, { minVolumeSharePct: 1 });
    const endedRow = { ...baseRow, ended: 'error' };
    const r = detectTwapChanges([endedRow], (r) => norm(r, 2), state, { minVolumeSharePct: 1 });
    expect(r.endedSignals).toHaveLength(0);
  });
});
