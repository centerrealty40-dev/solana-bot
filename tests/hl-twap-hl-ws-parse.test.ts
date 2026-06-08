import { describe, expect, it } from 'vitest';

import {
  detectLagMs,
  isActiveTwapStatus,
  parseTwapStatesMessage,
  parseUserTwapHistoryMessage,
  syntheticTwapId,
  twapSideFromHl,
} from '../src/hyperliquid/twap/hl-ws-parse.js';

describe('hl-ws-parse', () => {
  it('twapSideFromHl maps B/A', () => {
    expect(twapSideFromHl('B')).toBe('buy');
    expect(twapSideFromHl('A')).toBe('sell');
  });

  it('syntheticTwapId prefers twapId', () => {
    const state = {
      coin: 'BTC',
      user: '0xabc',
      side: 'B',
      sz: 1,
      executedSz: 0,
      executedNtl: 0,
      minutes: 30,
      reduceOnly: false,
      randomize: false,
      timestamp: 1_700_000_000_000,
    };
    expect(syntheticTwapId('0xAbC', 42, state)).toBe('0xabc:twap:42');
  });

  it('parseUserTwapHistoryMessage extracts activated twap', () => {
    const events = parseUserTwapHistoryMessage(
      {
        user: '0xUser',
        history: [
          {
            time: 1_700_000_000_000,
            state: {
              coin: 'ETH',
              user: '0xUser',
              side: 'B',
              sz: 10,
              executedSz: 0,
              executedNtl: 0,
              minutes: 60,
              reduceOnly: false,
              randomize: true,
              timestamp: 1_700_000_000_000,
            },
            status: { status: 'activated' },
          },
        ],
      },
      1_700_000_005_000,
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.coin).toBe('ETH');
    expect(events[0]?.side).toBe('buy');
    expect(detectLagMs(events[0]!.receivedAtMs, events[0]!.startedAtMs)).toBe(5000);
  });

  it('parseTwapStatesMessage maps active states', () => {
    const events = parseTwapStatesMessage(
      {
        user: '0xWhale',
        states: [[99, {
          coin: 'SOL',
          user: '0xWhale',
          side: 'A',
          sz: 5,
          executedSz: 1,
          executedNtl: 100,
          minutes: 30,
          reduceOnly: false,
          randomize: false,
          timestamp: 1_800_000_000_000,
        }]],
      },
      1_800_000_001_000,
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.twapId).toBe(99);
    expect(events[0]?.status).toBe('activated');
    expect(isActiveTwapStatus('activated')).toBe(true);
    expect(isActiveTwapStatus('finished')).toBe(false);
  });
});
