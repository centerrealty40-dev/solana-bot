import { describe, expect, it } from 'vitest';
import { parseFollowDcaLevels } from '../../src/pumpswap-combo-follow/config.js';
import { parseDcaLevels } from '../../src/papertrader/config.js';

describe('follow flow8z front-run DCA', () => {
  it('parses anchor-specific thresholds', () => {
    const levels = parseFollowDcaLevels('-8:0.333333:first,-7:0.333333:avg');
    expect(levels).toHaveLength(2);
    expect(levels[0]!.triggerPct).toBeCloseTo(-0.08, 4);
    expect(levels[0]!.anchor).toBe('first');
    expect(levels[1]!.triggerPct).toBeCloseTo(-0.07, 4);
    expect(levels[1]!.anchor).toBe('avg');
  });
});

describe('follow oscar DCA sizing', () => {
  it('applies Oscar fractions on legUsd notional ($7 live → ~$2.33 per DCA leg)', () => {
    const levels = parseDcaLevels('-10:0.333333,-20:0.333333');
    expect(levels).toHaveLength(2);
    const legUsd = 7;
    expect(legUsd * levels[0]!.addFraction).toBeCloseTo(2.33, 1);
    expect(legUsd * levels[1]!.addFraction).toBeCloseTo(2.33, 1);
  });
});

describe('mirror add sizing', () => {
  it('defaults mirror add to first DCA fraction of legUsd', () => {
    const levels = parseFollowDcaLevels('-8:0.333333:first,-7:0.333333:avg');
    const legUsd = 7;
    expect(legUsd * levels[0]!.addFraction).toBeCloseTo(2.33, 1);
  });
});
