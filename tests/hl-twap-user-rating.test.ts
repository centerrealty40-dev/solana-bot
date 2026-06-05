import { describe, expect, it } from 'vitest';

import {
  computeUserTwapRating,
  formatUserRatingLineRu,
  isTwapEndedCancelled,
} from '../src/hyperliquid/twap/user-rating.js';
import type { HypurrscanTwapRow } from '../src/hyperliquid/twap/types.js';

function row(user: string, hash: string, ended?: string): HypurrscanTwapRow {
  return {
    time: 1,
    user,
    block: 1,
    hash,
    error: null,
    ended,
    action: {
      type: 'twapOrder',
      twap: { a: 1, b: true, s: '100', r: false, m: 5, t: false },
    },
  };
}

describe('hl-twap user rating', () => {
  it('classifies error as cancel', () => {
    expect(isTwapEndedCancelled('error')).toBe(true);
    expect(isTwapEndedCancelled('finished')).toBe(false);
  });

  it('computes cancel rate', () => {
    const u = '0xabc';
    const rows = [
      row(u, '0x1', 'finished'),
      row(u, '0x2', 'finished'),
      row(u, '0x3', 'error'),
      row(u, '0x4', 'terminated'),
    ];
    const r = computeUserTwapRating(rows, u);
    expect(r.endedTotal).toBe(4);
    expect(r.cancelCount).toBe(2);
    expect(r.cancelPct).toBe(50);
    expect(formatUserRatingLineRu(r)).toContain('50%');
    expect(formatUserRatingLineRu(r)).toContain('🔴');
  });

  it('shows low sample without pct', () => {
    const r = computeUserTwapRating([row('0xabc', '0x1', 'error')], '0xabc');
    expect(r.cancelPct).toBeNull();
    expect(formatUserRatingLineRu(r)).toContain('мало данных');
  });
});
