import { describe, expect, it } from 'vitest';

import {
  createTwapWatchState,
  detectTwapChanges,
  markTwapOpenedNotified,
  seedTwapWatchState,
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

function norm(row: HypurrscanTwapRow, impactPct: number): NormalizedTwapSignal {
  return {
    hash: row.hash,
    twapId: null,
    user: baseRow.user,
    side: 'buy',
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
  it('only filters by price impact', () => {
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
    markTwapOpenedNotified(state, baseRow.hash);
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
