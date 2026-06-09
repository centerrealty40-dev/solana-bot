import { describe, expect, it } from 'vitest';
import { parseDcaLevels } from '../../src/papertrader/config.js';

describe('follow oscar DCA sizing', () => {
  it('parses live Oscar −10/−20 fractions', () => {
    const levels = parseDcaLevels('-10:0.333333,-20:0.333333');
    expect(levels).toHaveLength(2);
    expect(levels[0]!.triggerPct).toBeCloseTo(-0.1, 6);
    expect(levels[1]!.triggerPct).toBeCloseTo(-0.2, 6);
    const positionUsd = 600;
    expect(positionUsd * levels[0]!.addFraction).toBeCloseTo(200, 0);
    expect(positionUsd * levels[1]!.addFraction).toBeCloseTo(200, 0);
  });
});
