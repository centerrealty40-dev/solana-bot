import { describe, expect, it } from 'vitest';
import {
  buildSnapshotStaleAlertBody,
  formatSnapshotFreshnessPulseLine,
  snapshotsAnyStale,
  worstSnapshotAgeSec,
  type DexSnapshotFreshness,
} from '../src/ingestion/pair-snapshot-freshness.js';

function row(source: string, ageSec: number | null, ok: boolean): DexSnapshotFreshness {
  return {
    source,
    table: `${source}_pair_snapshots`,
    latestTs: ageSec != null ? new Date(Date.now() - ageSec * 1000) : null,
    ageSec,
    ok,
  };
}

describe('pair-snapshot-freshness', () => {
  it('worstSnapshotAgeSec picks max', () => {
    const rows = [row('pumpswap', 120, true), row('raydium', 900, false)];
    expect(worstSnapshotAgeSec(rows)).toBe(900);
  });

  it('snapshotsAnyStale when any row not ok', () => {
    const rows = [row('pumpswap', 60, true), row('raydium', 200, false)];
    expect(snapshotsAnyStale(rows, 600)).toBe(true);
  });

  it('formatSnapshotFreshnessPulseLine includes worst', () => {
    const line = formatSnapshotFreshnessPulseLine([row('pumpswap', 180, true)]);
    expect(line).toContain('snap_worst_age_min=3');
    expect(line).toContain('pumpswap=3m');
  });

  it('buildSnapshotStaleAlertBody lists stale sources', () => {
    const body = buildSnapshotStaleAlertBody([row('pumpswap', 800, false)], 600);
    expect(body).toContain('STALE');
    expect(body).toContain('pumpswap');
  });
});
