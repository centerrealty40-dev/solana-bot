import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { inDipBand } from '../../src/milddip/fast-path.js';

describe('1.11.854 the shallow band is back in the main entry', () => {
  const MIN = -25;
  const MAX = -3;

  it('−8…−3 qualifies again', () => {
    // 1.11.825 closed it on an MFE study taken from a mark tape later found
    // poisoned (1.11.847, 1.11.848). 13.7% of leader buys sit in this band.
    expect(inDipBand(-7.9, MIN, MAX)).toBe(true);
    expect(inDipBand(-3, MIN, MAX)).toBe(true);
  });

  it('the near-flat band stays out', () => {
    expect(inDipBand(-2.5, MIN, MAX)).toBe(false);
    expect(inDipBand(0, MIN, MAX)).toBe(false);
  });

  it('the deeper bands still qualify', () => {
    expect(inDipBand(-8, MIN, MAX)).toBe(true);
    expect(inDipBand(-12, MIN, MAX)).toBe(true);
    expect(inDipBand(-24.9, MIN, MAX)).toBe(true);
  });

  it('live env carries the reopened ceiling', () => {
    const eco = readFileSync(resolve('ecosystem.config.cjs'), 'utf8');
    expect(eco).toContain("MILD_DIP_MAX_DIP_PCT: '-3'");
    expect(eco).toContain("MILD_DIP_MIN_DIP_PCT: '-25'");
  });

  it('knife OR still reaches deeper than the band floor', () => {
    // pc5m ≤ −25 was the best bucket (median MFE 54%); it enters via knife OR.
    const eco = readFileSync(resolve('ecosystem.config.cjs'), 'utf8');
    expect(eco).toContain("MILD_DIP_TURN_DUMP_KNIFE_BRANCH: '1'");
    expect(eco).toContain("MILD_DIP_TURN_DUMP_KNIFE_MIN_DUMP_PCT: '30'");
  });
});
