import { describe, expect, it } from 'vitest';
import { rejectStalePgSnapshotForMtm } from '../src/live/pg-snapshot-mtm.js';

describe('rejectStalePgSnapshotForMtm', () => {
  const now = Date.UTC(2026, 6, 16, 10, 0, 0);

  it('rejects PG price when snapshot is older than maxAgeMs', () => {
    const snapTsMs = now - 15 * 24 * 60 * 60_000;
    const r = rejectStalePgSnapshotForMtm({
      snapPx: 0.0004642,
      snapTsMs,
      nowMs: now,
      maxAgeMs: 120_000,
    });
    expect(r.rejected).toBe(true);
    expect(r.snapPx).toBe(0);
    expect(r.ageMs).toBeGreaterThan(120_000);
  });

  it('keeps fresh PG price', () => {
    const snapTsMs = now - 30_000;
    const r = rejectStalePgSnapshotForMtm({
      snapPx: 0.000153,
      snapTsMs,
      nowMs: now,
      maxAgeMs: 120_000,
    });
    expect(r.rejected).toBe(false);
    expect(r.snapPx).toBe(0.000153);
  });

  it('rejects when snapshot timestamp is missing', () => {
    const r = rejectStalePgSnapshotForMtm({
      snapPx: 0.0004642,
      snapTsMs: null,
      nowMs: now,
      maxAgeMs: 120_000,
    });
    expect(r.rejected).toBe(true);
    expect(r.snapPx).toBe(0);
  });
});
