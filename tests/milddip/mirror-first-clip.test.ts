import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  mirrorFirstClipLegSize,
  mirrorFirstClipWindowBaseMs,
} from '../../src/milddip/entry-attempt.js';

describe('mirror first clip legs', () => {
  it('divides the configured clip into equal legs', () => {
    expect(mirrorFirstClipLegSize(50, 2)).toBe(25);
    expect(mirrorFirstClipLegSize(60, 2)).toBe(30);
  });

  it('preserves the existing single-leg behavior by default', () => {
    expect(mirrorFirstClipLegSize(50, 1)).toBe(50);
    expect(mirrorFirstClipLegSize(50, 0)).toBe(50);
  });

  it('uses our fill time, not the leader buy time, for the window', () => {
    expect(mirrorFirstClipWindowBaseMs(2_000, 3_000)).toBe(3_000);
    expect(mirrorFirstClipWindowBaseMs(2_000)).toBe(2_000);
  });

  it('journals exactly one cash buy fill for each second-leg result', () => {
    const source = readFileSync(
      new URL('../../src/milddip/entry-attempt.ts', import.meta.url),
      'utf8',
    );
    const start = source.indexOf('export async function attemptMirrorFirstClipLeg');
    const body = source.slice(start);
    expect(body.match(/writeUsBuyFill\(\{/g)).toHaveLength(1);
    expect(body).toContain('ok: buy.ok');
    expect(body).toContain("dipSource: 'mirror_first_clip_leg'");
    expect(body).toContain("lane: 'leader_mirror'");
    expect(body).toContain('sizeUsdIntent: Math.min(legUsd, sized.sizeUsd)');
    expect(body).toContain('fillPriceUsd: fillPx');
  });
});
