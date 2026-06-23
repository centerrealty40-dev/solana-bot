/**
 * Freshness of minute bars in dex `*_pair_snapshots` tables — discovery + alert watchers depend on this.
 * sa-orca collector removed 2026-05-26 (runaway CPU); orca table is not monitored.
 */
import { db } from '../core/db/client.js';
import { sql as dsql } from 'drizzle-orm';

export const DEX_PAIR_SNAPSHOT_TABLES = [
  { source: 'pumpswap', table: 'pumpswap_pair_snapshots' },
  { source: 'raydium', table: 'raydium_pair_snapshots' },
  { source: 'meteora', table: 'meteora_pair_snapshots' },
  { source: 'moonshot', table: 'moonshot_pair_snapshots' },
] as const;

export function activeDexPairSnapshotTables(): ReadonlyArray<{
  source: string;
  table: string;
}> {
  return DEX_PAIR_SNAPSHOT_TABLES;
}

export type DexSnapshotFreshness = {
  source: string;
  table: string;
  latestTs: Date | null;
  ageSec: number | null;
  ok: boolean;
};

/** PG drivers may return `MAX(ts)` as string — normalize before alert formatting. */
export function normalizeSnapshotLatestTs(v: unknown): Date | null {
  if (v == null) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  const d = new Date(v as string | number);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function formatSnapshotLatestTs(v: unknown): string {
  const d = normalizeSnapshotLatestTs(v);
  return d ? d.toISOString() : 'null';
}

export function snapshotMaxAgeSecFromEnv(): number {
  const n = Number(process.env.SNAPSHOT_FRESHNESS_MAX_AGE_SEC?.trim());
  if (Number.isFinite(n) && n > 0) return Math.floor(n);
  return 600;
}

export async function fetchDexSnapshotFreshness(
  maxAgeSec = snapshotMaxAgeSecFromEnv(),
): Promise<DexSnapshotFreshness[]> {
  const out: DexSnapshotFreshness[] = [];
  for (const { source, table } of activeDexPairSnapshotTables()) {
    try {
      const r = await db.execute(dsql.raw(`
        SELECT MAX(ts) AS ts,
               EXTRACT(EPOCH FROM (now() - MAX(ts)))::int AS age_sec
        FROM ${table}
      `));
      const rows = r as unknown as Array<{ ts: Date | null; age_sec: number | null }>;
      const row = rows[0];
      const latestTs = normalizeSnapshotLatestTs(row?.ts);
      const ageSec =
        row?.age_sec != null && Number.isFinite(Number(row.age_sec)) ? Number(row.age_sec) : null;
      const ok =
        latestTs != null &&
        ageSec != null &&
        Number.isFinite(ageSec) &&
        ageSec >= 0 &&
        ageSec <= maxAgeSec;
      out.push({ source, table, latestTs, ageSec, ok });
    } catch {
      out.push({ source, table, latestTs: null, ageSec: null, ok: false });
    }
  }
  return out;
}

export function worstSnapshotAgeSec(rows: readonly DexSnapshotFreshness[]): number | null {
  let worst: number | null = null;
  for (const r of rows) {
    if (r.ageSec == null || !Number.isFinite(r.ageSec)) return null;
    if (worst == null || r.ageSec > worst) worst = r.ageSec;
  }
  return worst;
}

export function snapshotsAnyStale(
  rows: readonly DexSnapshotFreshness[],
  maxAgeSec = snapshotMaxAgeSecFromEnv(),
): boolean {
  return rows.some((r) => !r.ok || (r.ageSec != null && r.ageSec > maxAgeSec));
}

/** Compact line for HEALTH pulse. */
export function formatSnapshotFreshnessPulseLine(rows: readonly DexSnapshotFreshness[]): string {
  const worst = worstSnapshotAgeSec(rows);
  const parts = rows.map((r) => {
    const ageMin =
      r.ageSec != null && Number.isFinite(r.ageSec) ? Math.round(r.ageSec / 60) : '?';
    return `${r.source}=${ageMin}m`;
  });
  const worstMin =
    worst != null && Number.isFinite(worst) ? Math.round(worst / 60) : '?';
  return `snap_worst_age_min=${worstMin} ${parts.join(' ')}`;
}

export function buildSnapshotStaleAlertBody(
  rows: readonly DexSnapshotFreshness[],
  maxAgeSec: number,
): string {
  const maxMin = Math.round(maxAgeSec / 60);
  const lines = [
    `🚨 PG snapshots STALE (порог ${maxMin} мин) — discovery и TG-алерты слепы.`,
    'Проверьте: pm2 logs sa-pumpswap / sa-raydium; pm2 restart sa-pumpswap sa-raydium sa-meteora sa-moonshot',
  ];
  for (const r of rows) {
    const ageMin =
      r.ageSec != null && Number.isFinite(r.ageSec) ? Math.round(r.ageSec / 60) : '?';
    const flag = r.ok ? 'OK' : 'STALE';
    lines.push(`• ${r.source}: ${flag} age=${ageMin}m latest=${formatSnapshotLatestTs(r.latestTs)}`);
  }
  return lines.join('\n');
}
