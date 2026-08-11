import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveExitMarkFromRing } from '../../src/milddip/exit-mark.js';

describe('resolveExitMarkFromRing', () => {
  const now = 1_000_000;

  it('returns ring price without caring about Dex', () => {
    const r = resolveExitMarkFromRing({
      last: { priceUsd: 1.5, tsMs: now - 2_000, source: 'stream' },
      nowMs: now,
      maxAgeMs: 60_000,
    });
    expect(r.px).toBe(1.5);
    expect(r.source).toBe('stream');
    expect(r.volume5mUsd).toBeNull();
    expect(r.ageMs).toBe(2_000);
  });

  it('accepts entry-seeded dex prints while stream is quiet', () => {
    const r = resolveExitMarkFromRing({
      last: { priceUsd: 0.01, tsMs: now - 90_000, source: 'dex' },
      nowMs: now,
      maxAgeMs: 300_000,
    });
    expect(r.px).toBe(0.01);
    expect(r.source).toBe('dex');
  });

  it('null when older than maxAge', () => {
    const r = resolveExitMarkFromRing({
      last: { priceUsd: 1, tsMs: now - 400_000, source: 'stream' },
      nowMs: now,
      maxAgeMs: 300_000,
    });
    expect(r.px).toBeNull();
    expect(r.ageMs).toBe(400_000);
  });

  it('maxAge 0 keeps any last print', () => {
    const r = resolveExitMarkFromRing({
      last: { priceUsd: 2, tsMs: now - 3_600_000, source: 'stream' },
      nowMs: now,
      maxAgeMs: 0,
    });
    expect(r.px).toBe(2);
  });

  it('null when ring empty', () => {
    expect(
      resolveExitMarkFromRing({ last: null, nowMs: now, maxAgeMs: 60_000 }).px,
    ).toBeNull();
  });
});

describe('1.11.822 pre-entry sample is not a mark', () => {
  it('loop drops ring samples older than openedAtMs', () => {
    const src = readFileSync(resolve('src/milddip/loop.ts'), 'utf8');
    // 6tfuqq: filled at 0.00012981 while the ring still held 0.0001596 from 3s
    // before the buy -> phantom +22.95% armed the trail and banked out flat.
    expect(src).toContain('staleVsEntry');
    expect(src).toContain('last.tsMs < openedAtMs');
    expect(src).toContain('state.open[mint]?.openedAtMs');
  });
});
