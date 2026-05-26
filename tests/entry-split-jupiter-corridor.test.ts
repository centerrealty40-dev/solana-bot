import { describe, expect, it } from 'vitest';
import {
  entrySplitBandOk,
  pctFromAnchor,
} from '../src/papertrader/executor/live-staged-entry-gates.js';

/** MANIFEST 2026-05-21: PG snapshot blocked leg2; Jupiter tradable was in band. */
describe('entry split jupiter corridor', () => {
  const anchor = 0.01897362;
  const snapPx = 0.0198;
  const jupiterPx = 0.019169414;
  const maxUp = 3;
  const maxDown = 10;

  it('PG MTM fails +3% corridor', () => {
    const ch = pctFromAnchor(anchor, snapPx)!;
    expect(ch).toBeGreaterThan(3);
    expect(entrySplitBandOk(ch, maxUp, maxDown)).toBe(false);
  });

  it('Jupiter tradable passes +3% corridor', () => {
    const ch = pctFromAnchor(anchor, jupiterPx)!;
    expect(ch).toBeGreaterThan(0);
    expect(ch).toBeLessThan(3);
    expect(entrySplitBandOk(ch, maxUp, maxDown)).toBe(true);
  });
});
