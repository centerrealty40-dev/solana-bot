import { describe, expect, it } from 'vitest';

import { createTwapWatchState, detectTwapChanges, passesTwapFilters } from '../src/hyperliquid/twap/detect.js';
import type { HypurrscanTwapRow, NormalizedTwapSignal } from '../src/hyperliquid/twap/types.js';

const row: HypurrscanTwapRow = {
  time: 1,
  user: '0xabc',
  block: 1,
  hash: '0ximpact',
  error: null,
  action: {
    type: 'twapOrder',
    twap: { a: 159, b: true, s: '100', r: false, m: 5, t: false },
  },
};

function norm(impactPct: number, notionalUsd: number): NormalizedTwapSignal {
  return {
    hash: row.hash,
    twapId: null,
    user: row.user,
    side: 'buy',
    coin: 'HYPE',
    displaySymbol: 'HYPE',
    isSpot: false,
    size: 5000,
    minutes: 5,
    randomize: false,
    reduceOnly: false,
    notionalUsd,
    midPx: 65,
    dayNtlVlmUsd: 2e9,
    volumeSharePct: impactPct,
    startedAtMs: 1,
    block: 1,
    ended: null,
  };
}

describe('hl-twap impact filter', () => {
  it('blocks when impact below 1%', () => {
    const state = createTwapWatchState();
    const r = detectTwapChanges([row], () => norm(0.5, 500_000), state, { minVolumeSharePct: 1 });
    expect(r.newSignals).toHaveLength(0);
  });

  it('passes at 1% impact', () => {
    const state = createTwapWatchState();
    const r = detectTwapChanges([row], () => norm(1.2, 10_000), state, { minVolumeSharePct: 1 });
    expect(r.newSignals).toHaveLength(1);
  });

  it('rejects sell even above impact threshold', () => {
    const sig = { ...norm(4.41, 1_970_000), side: 'sell' as const };
    expect(passesTwapFilters(sig, { minVolumeSharePct: 1 })).toBe(false);
    expect(passesTwapFilters(sig, { minVolumeSharePct: 1, buyOnly: false })).toBe(true);
  });
});
