import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { inDipBand } from '../../src/milddip/fast-path.js';

describe('1.11.858 the entry band runs from -25 to flat', () => {
  const MIN = -25;
  const MAX = 0;

  it('the whole red side qualifies, down to flat', () => {
    // Of 1288 leader buys with our own metrics nearby, a -3 ceiling blocked
    // 41.5%. Two of the three trades the operator flagged were entered at
    // -0.14% and +1.26%, i.e. flat rather than green.
    expect(inDipBand(-7.9, MIN, MAX)).toBe(true);
    expect(inDipBand(-3, MIN, MAX)).toBe(true);
    expect(inDipBand(-0.14, MIN, MAX)).toBe(true);
  });

  it('green stays out', () => {
    expect(inDipBand(1.26, MIN, MAX)).toBe(false);
    expect(inDipBand(32.75, MIN, MAX)).toBe(false);
  });

  it('the deeper bands still qualify', () => {
    expect(inDipBand(-8, MIN, MAX)).toBe(true);
    expect(inDipBand(-12, MIN, MAX)).toBe(true);
    expect(inDipBand(-24.9, MIN, MAX)).toBe(true);
  });

  it('live env carries the flat ceiling', () => {
    const eco = readFileSync(resolve('ecosystem.config.cjs'), 'utf8');
    expect(eco).toContain("MILD_DIP_MAX_DIP_PCT: '0'");
    expect(eco).toContain("MILD_DIP_MIN_DIP_PCT: '-25'");
  });

  it('nothing reaches past the band floor any more (1.11.891)', () => {
    // The knife branch bought collapses of 30%+ and was the worst entry we had:
    // 263 positions at −0.191 USD each, five times the loss per position of
    // anything else, and the source of a −96% bag entered at pc5m −66.62%.
    const eco = readFileSync(resolve('ecosystem.config.cjs'), 'utf8');
    expect(eco).toContain("MILD_DIP_TURN_DUMP_KNIFE_BRANCH: '0'");
    // Threshold kept, so the branch can be measured again if it is reopened.
    expect(eco).toContain("MILD_DIP_TURN_DUMP_KNIFE_MIN_DUMP_PCT: '30'");
  });
});
