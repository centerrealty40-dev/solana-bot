import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { inDipBand } from '../../src/milddip/fast-path.js';

describe('1.11.825 shallow band is out of the main entry', () => {
  const MIN = -25;
  const MAX = -8;

  it('the dead band (−8, 0] no longer qualifies', () => {
    // Median MFE there was 3.66% with winrate 0.36 — nothing to exit into.
    expect(inDipBand(-2.5, MIN, MAX)).toBe(false);
    expect(inDipBand(-7.9, MIN, MAX)).toBe(false);
  });

  it('the bands that pay still qualify', () => {
    expect(inDipBand(-8, MIN, MAX)).toBe(true);
    expect(inDipBand(-12, MIN, MAX)).toBe(true);
    expect(inDipBand(-24.9, MIN, MAX)).toBe(true);
  });

  it('live env carries the tightened ceiling', () => {
    const eco = readFileSync(resolve('ecosystem.config.cjs'), 'utf8');
    expect(eco).toContain("MILD_DIP_MAX_DIP_PCT: '-8'");
    expect(eco).toContain("MILD_DIP_MIN_DIP_PCT: '-25'");
  });

  it('knife OR still reaches deeper than the band floor', () => {
    // pc5m ≤ −25 was the best bucket (median MFE 54%); it enters via knife OR.
    const eco = readFileSync(resolve('ecosystem.config.cjs'), 'utf8');
    expect(eco).toContain("MILD_DIP_TURN_DUMP_KNIFE_BRANCH: '1'");
    expect(eco).toContain("MILD_DIP_TURN_DUMP_KNIFE_MIN_DUMP_PCT: '30'");
  });
});
