import { describe, it, expect } from 'vitest';
import {
  snapshotRowTsMs,
  snapshotPriceAgeMs,
  isEntryPriceStale,
} from '../src/papertrader/stale-price.js';

describe('stale-price observability helpers (Stage 0, 1.11.466)', () => {
  describe('snapshotRowTsMs', () => {
    it('parses Date and ISO string to epoch ms', () => {
      const d = new Date('2026-06-18T00:00:00.000Z');
      expect(snapshotRowTsMs(d)).toBe(d.getTime());
      expect(snapshotRowTsMs('2026-06-18T00:00:00.000Z')).toBe(d.getTime());
    });

    it('returns null for missing/unparseable ts', () => {
      expect(snapshotRowTsMs(null)).toBeNull();
      expect(snapshotRowTsMs(undefined)).toBeNull();
      expect(snapshotRowTsMs('not-a-date')).toBeNull();
      expect(snapshotRowTsMs(new Date('invalid'))).toBeNull();
    });
  });

  describe('snapshotPriceAgeMs', () => {
    it('computes positive age', () => {
      const now = 1_000_000;
      expect(snapshotPriceAgeMs(now - 30_000, now)).toBe(30_000);
    });

    it('clamps negative age (future ts / clock skew) to 0', () => {
      const now = 1_000_000;
      expect(snapshotPriceAgeMs(now + 5_000, now)).toBe(0);
    });

    it('returns null when ts unknown', () => {
      expect(snapshotPriceAgeMs(null, 1_000_000)).toBeNull();
      expect(snapshotPriceAgeMs(undefined, 1_000_000)).toBeNull();
      expect(snapshotPriceAgeMs(Number.NaN, 1_000_000)).toBeNull();
    });
  });

  describe('isEntryPriceStale', () => {
    const now = 1_000_000;
    const warnMs = 45_000;

    it('flags prices older than the warn threshold', () => {
      expect(isEntryPriceStale(now - 60_000, now, warnMs)).toBe(true);
    });

    it('does not flag fresh prices at/under the threshold', () => {
      expect(isEntryPriceStale(now - 45_000, now, warnMs)).toBe(false);
      expect(isEntryPriceStale(now - 10_000, now, warnMs)).toBe(false);
    });

    it('is disabled when warnMs <= 0 (env "0" path)', () => {
      expect(isEntryPriceStale(now - 600_000, now, 0)).toBe(false);
      expect(isEntryPriceStale(now - 600_000, now, -1)).toBe(false);
    });

    it('never flags when ts is unknown (observability is best-effort)', () => {
      expect(isEntryPriceStale(null, now, warnMs)).toBe(false);
      expect(isEntryPriceStale(undefined, now, warnMs)).toBe(false);
    });
  });
});
