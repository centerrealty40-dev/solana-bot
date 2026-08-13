import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { inDipBand } from '../../src/milddip/fast-path.js';

/**
 * 1.11.885 — the band runs from −20% to −4%.
 *
 * Measured over 186 closed positions in an 11h window, once the exit bases were
 * honest enough to trust the numbers. By entry depth: every band from −20% to
 * −4% earned, at a 65–81% win rate; the two ends did not. (−4,−2] returned
 * −2.39 USD at 59% and (−2,0] −2.50 USD at 52% — fifty positions and −4.89 USD
 * against a whole-window result of +7.01. Below −20%: −2.97 USD at 50%.
 *
 * The ceiling was −8 once and reopened to flat in 1.11.854, on data the basis
 * bugs had corrupted. Measured clean the line sits at −4: (−8,−4] earns,
 * (−4,0] does not.
 */
describe('1.11.885 the entry band runs from -20 to -4', () => {
  const MIN = -20;
  const MAX = -4;

  it('keeps the bands that earn', () => {
    expect(inDipBand(-4.1, MIN, MAX)).toBe(true);
    expect(inDipBand(-7.9, MIN, MAX)).toBe(true);
    expect(inDipBand(-12, MIN, MAX)).toBe(true);
    expect(inDipBand(-19.9, MIN, MAX)).toBe(true);
  });

  it('drops the shallow end, which lost on both of its buckets', () => {
    expect(inDipBand(-3, MIN, MAX)).toBe(false);
    expect(inDipBand(-0.14, MIN, MAX)).toBe(false);
  });

  it('drops the deep end, where half the entries lost', () => {
    expect(inDipBand(-24.9, MIN, MAX)).toBe(false);
    expect(inDipBand(-40, MIN, MAX)).toBe(false);
  });

  it('green stays out', () => {
    expect(inDipBand(1.26, MIN, MAX)).toBe(false);
    expect(inDipBand(32.75, MIN, MAX)).toBe(false);
  });

  it('live env carries both edges', () => {
    const eco = readFileSync(resolve('ecosystem.config.cjs'), 'utf8');
    expect(eco).toContain("MILD_DIP_MAX_DIP_PCT: '-4'");
    expect(eco).toContain("MILD_DIP_MIN_DIP_PCT: '-20'");
  });

  it('knife OR still reaches deeper than the band floor', () => {
    // A genuine collapse enters through its own branch, not by widening the
    // band: pc5m ≤ −30 with the turn-dump shape, which is a different trade.
    const eco = readFileSync(resolve('ecosystem.config.cjs'), 'utf8');
    expect(eco).toContain("MILD_DIP_TURN_DUMP_KNIFE_BRANCH: '1'");
    expect(eco).toContain("MILD_DIP_TURN_DUMP_KNIFE_MIN_DUMP_PCT: '30'");
  });
});
