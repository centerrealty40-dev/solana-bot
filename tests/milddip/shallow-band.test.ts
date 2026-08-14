import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { inDipBand } from '../../src/milddip/fast-path.js';

describe('1.11.893 the entry band runs from -25 to -4', () => {
  const MIN = -25;
  const MAX = -4;

  it('keeps the red side that earns', () => {
    expect(inDipBand(-7.9, MIN, MAX)).toBe(true);
    expect(inDipBand(-4.1, MIN, MAX)).toBe(true);
  });

  it('drops the wiggles, which lose in every window', () => {
    // (-4,0] is the only band negative across 12h, 24h and the whole journal,
    // over 754 positions. 77rUTY78 came in at -1.53% inside a +11% hour.
    expect(inDipBand(-3, MIN, MAX)).toBe(false);
    expect(inDipBand(-1.53, MIN, MAX)).toBe(false);
    expect(inDipBand(-0.14, MIN, MAX)).toBe(false);
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

  it('live env carries the -4 ceiling and keeps the -25 floor', () => {
    // The floor was cut to -20 once on 14 positions and reverted; only the
    // ceiling has evidence behind it.
    const eco = readFileSync(resolve('ecosystem.config.cjs'), 'utf8');
    expect(eco).toContain("MILD_DIP_MAX_DIP_PCT: '-4'");
    expect(eco).toContain("MILD_DIP_MIN_DIP_PCT: '-25'");
  });

  it('nothing reaches past the band floor any more (1.11.891)', () => {
    // The knife branch bought collapses of 30%+ and was the worst entry we had:
    // 263 positions at −0.191 USD each, five times the loss per position of
    // anything else, and the source of a −96% bag entered at pc5m −66.62%.
    const eco = readFileSync(resolve('ecosystem.config.cjs'), 'utf8');
    expect(eco).toContain("MILD_DIP_TURN_DUMP_KNIFE_BRANCH: '0'");
    // Threshold kept, so the branch can be measured again if it is reopened.
    expect(eco).toContain("MILD_DIP_TURN_DUMP_KNIFE_MIN_DUMP_PCT: '28'");
  });
});
