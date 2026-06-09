import { describe, expect, it } from 'vitest';
import { parseDcaLevels } from '../../src/papertrader/config.js';

describe('follow oscar DCA sizing', () => {
  it('applies Oscar fractions on legUsd notional ($3 test agent → ~$1 per DCA leg)', () => {
    const levels = parseDcaLevels('-10:0.333333,-20:0.333333');
    expect(levels).toHaveLength(2);
    const legUsd = 3;
    expect(legUsd * levels[0]!.addFraction).toBeCloseTo(1, 0);
    expect(legUsd * levels[1]!.addFraction).toBeCloseTo(1, 0);
  });
});
