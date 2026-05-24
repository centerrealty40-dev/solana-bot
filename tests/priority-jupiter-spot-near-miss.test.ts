import { describe, expect, it } from 'vitest';

process.env.SPIKE_ALERT_SKIP_MAIN = '1';
process.env.SPIKE_ALERT_TIERED_BY_MCAP = '1';
process.env.SPIKE_ALERT_DUMP_TIER1_MCAP_USD = '1500000';
process.env.SPIKE_ALERT_DUMP_TIER1_MIN_PCT = '14';
process.env.SPIKE_ALERT_DUMP_TIER1_MIN_PCT_ROLLING = '15';

import {
  nearMissFromConsecutiveBars,
  nearMissFromRollingBars,
} from '../src/scripts/priority-jupiter-spot-near-miss.js';

describe('priority-jupiter-spot-near-miss', () => {
  it('nearMissFromConsecutiveBars true within gap below tier threshold', () => {
    const refMcap = 2_000_000;
    const bars = [
      { tsMs: 0, priceUsd: 100, refMcap },
      { tsMs: 60_000, priceUsd: 88, refMcap },
    ];
    expect(nearMissFromConsecutiveBars(bars, 3)).toBe(true);
    expect(nearMissFromConsecutiveBars(bars, 0.5)).toBe(false);
  });

  it('nearMissFromRollingBars detects dump near-miss in rolling window', () => {
    const refMcap = 2_000_000;
    const bars = [
      { tsMs: 0, priceUsd: 100, refMcap },
      { tsMs: 180_000, priceUsd: 100, refMcap },
      { tsMs: 240_000, priceUsd: 87, refMcap },
    ];
    expect(nearMissFromRollingBars(bars, 3, 3, 5)).toBe(true);
  });
});
