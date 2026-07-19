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
  /** Set when PG query failed — must not be treated as data stale. */
  queryError?: string | null;
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

export function snapshotAlertHostLabelFromEnv(): string | undefined {
  const raw =
    process.env.SNAPSHOT_FRESHNESS_ALERT_HOST?.trim() ||
    process.env.COLLECTOR_HEALTH_PRODUCT_LABEL?.trim();
  return raw || undefined;
}

/** True only when age exceeds threshold; PG blip (queryError or missing age) is not stale. */
export function isSnapshotRowDataStale(
  row: DexSnapshotFreshness,
  maxAgeSec: number,
): boolean {
  if (row.queryError) return false;
  if (row.ageSec == null || !Number.isFinite(row.ageSec)) return false;
  return row.ageSec > maxAgeSec;
}

export function snapshotRowAlertFlag(row: DexSnapshotFreshness, maxAgeSec: number): 'OK' | 'STALE' | 'PG_ERR' {
  if (row.queryError) return 'PG_ERR';
  if (row.ageSec == null || !Number.isFinite(row.ageSec)) return 'PG_ERR';
  if (row.ageSec > maxAgeSec) return 'STALE';
  return 'OK';
}

/** Sources excluded from pg_stale entry blocks (orca off; moonshot low-volume lane). */
export function snapshotFreshnessSkipSourcesFromEnv(): ReadonlySet<string> {
  return new Set(
    String(process.env.SNAPSHOT_FRESHNESS_SKIP_SOURCES ?? 'orca')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function filterFreshnessForPgStaleBlocking(
  rows: readonly DexSnapshotFreshness[],
): DexSnapshotFreshness[] {
  const skip = snapshotFreshnessSkipSourcesFromEnv();
  return rows.filter((r) => !skip.has(r.source.toLowerCase()));
}

/** True when a mint's lane source (or any blocking source if unknown) exceeds max age. */
export function isMintLaneSnapshotStale(
  source: string | undefined,
  rows: readonly DexSnapshotFreshness[],
  maxAgeSec = snapshotMaxAgeSecFromEnv(),
): { stale: boolean; ageSec: number | null; blockingSource: string | null } {
  const lane = source?.trim().toLowerCase() ?? '';
  const blocking = filterFreshnessForPgStaleBlocking(rows);
  if (lane) {
    const row = rows.find((r) => r.source.toLowerCase() === lane);
    if (row && !snapshotFreshnessSkipSourcesFromEnv().has(lane)) {
      const stale = isSnapshotRowDataStale(row, maxAgeSec);
      return { stale, ageSec: row.ageSec, blockingSource: row.source };
    }
  }
  const stale = blocking.some((r) => isSnapshotRowDataStale(r, maxAgeSec));
  const ageSec = worstSnapshotAgeSec(blocking);
  const worst =
    blocking.reduce<DexSnapshotFreshness | null>((acc, r) => {
      if (r.ageSec == null) return acc;
      if (acc == null || acc.ageSec == null || r.ageSec > acc.ageSec) return r;
      return acc;
    }, null) ?? null;
  return { stale, ageSec, blockingSource: worst?.source ?? null };
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
    } catch (e) {
      const queryError = e instanceof Error ? e.message : String(e);
      out.push({ source, table, latestTs: null, ageSec: null, ok: false, queryError });
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
  return filterFreshnessForPgStaleBlocking(rows).some((r) => isSnapshotRowDataStale(r, maxAgeSec));
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
  hostLabel = snapshotAlertHostLabelFromEnv(),
): string {
  const maxMin = Math.round(maxAgeSec / 60);
  const lines = [
    ...(hostLabel ? [`host=${hostLabel}`] : []),
    `🚨 PG snapshots STALE (порог ${maxMin} мин) — discovery и TG-алерты слепы.`,
    'Проверьте: pm2 logs sa-pumpswap / sa-raydium; pm2 restart sa-pumpswap sa-raydium sa-meteora sa-moonshot',
  ];
  for (const r of rows) {
    const ageMin =
      r.ageSec != null && Number.isFinite(r.ageSec) ? Math.round(r.ageSec / 60) : '?';
    const flag = snapshotRowAlertFlag(r, maxAgeSec);
    lines.push(`• ${r.source}: ${flag} age=${ageMin}m latest=${formatSnapshotLatestTs(r.latestTs)}`);
  }
  return lines.join('\n');
}
