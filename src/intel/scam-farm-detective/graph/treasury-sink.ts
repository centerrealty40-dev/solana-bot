import { sql } from 'drizzle-orm';
import type { DB } from '../../../core/db/client.js';
import type { ScamFarmGraphConfig } from './config.js';

export type SinkHit = {
  targetWallet: string;
  nSources: number;
  totalSol: number;
};

function excludeFragment(exclude: string[]) {
  if (exclude.length === 0) return sql``;
  return sql`AND mf.target_wallet NOT IN (${sql.join(
    exclude.map((e) => sql`${e}`),
    sql`, `,
  )})`;
}

/** Узкий режим: только исходящие потоки от seed-кошельков. */
export async function querySinksFromSeeds(
  db: DB,
  cfg: ScamFarmGraphConfig,
  seeds: string[],
  exclude: string[],
): Promise<SinkHit[]> {
  if (seeds.length < 1) return [];

  const hours = cfg.sinkLookbackHours;
  const asset = cfg.sinkAsset;
  const minSources = cfg.sinkMinSources;
  const minTotal = cfg.sinkMinTotalSol;
  const lim = cfg.sinkMaxTargetsPerRun;
  const ex = [...new Set([...exclude, ...seeds])];

  const rows = (await db.execute(sql`
    SELECT mf.target_wallet AS target_wallet,
           COUNT(DISTINCT mf.source_wallet)::int AS n_sources,
           COALESCE(SUM(mf.amount), 0)::float8 AS total_sol
    FROM money_flows mf
    WHERE mf.asset = ${asset}
      AND mf.tx_time > now() - (${hours}::text || ' hours')::interval
      AND mf.source_wallet <> mf.target_wallet
      AND mf.source_wallet IN (${sql.join(
        seeds.map((w) => sql`${w}`),
        sql`, `,
      )})
      ${excludeFragment(ex)}
      AND mf.target_wallet NOT IN (${sql.join(
        ex.map((w) => sql`${w}`),
        sql`, `,
      )})
    GROUP BY mf.target_wallet
    HAVING COUNT(DISTINCT mf.source_wallet) >= ${minSources}
       AND COALESCE(SUM(mf.amount), 0) >= ${minTotal}
    ORDER BY n_sources DESC, total_sol DESC
    LIMIT ${lim}
  `)) as unknown as Array<{ target_wallet: string; n_sources: number; total_sol: number }>;

  return rows.map((r) => ({
    targetWallet: r.target_wallet,
    nSources: r.n_sources,
    totalSol: Number(r.total_sol),
  }));
}

/** Широкий режим: топ получателей по числу уникальных отправителей (дороже). */
export async function querySinksWide(db: DB, cfg: ScamFarmGraphConfig, exclude: string[]): Promise<SinkHit[]> {
  const hours = cfg.sinkLookbackHours;
  const asset = cfg.sinkAsset;
  const minSources = cfg.sinkWideMinSources;
  const minTotal = cfg.sinkMinTotalSol;
  const lim = cfg.sinkMaxTargetsPerRun;

  const rows = (await db.execute(sql`
    SELECT mf.target_wallet AS target_wallet,
           COUNT(DISTINCT mf.source_wallet)::int AS n_sources,
           COALESCE(SUM(mf.amount), 0)::float8 AS total_sol
    FROM money_flows mf
    WHERE mf.asset = ${asset}
      AND mf.tx_time > now() - (${hours}::text || ' hours')::interval
      AND mf.source_wallet <> mf.target_wallet
      ${excludeFragment(exclude)}
    GROUP BY mf.target_wallet
    HAVING COUNT(DISTINCT mf.source_wallet) >= ${minSources}
       AND COALESCE(SUM(mf.amount), 0) >= ${minTotal}
    ORDER BY n_sources DESC, total_sol DESC
    LIMIT ${lim}
  `)) as unknown as Array<{ target_wallet: string; n_sources: number; total_sol: number }>;

  return rows.map((r) => ({
    targetWallet: r.target_wallet,
    nSources: r.n_sources,
    totalSol: Number(r.total_sol),
  }));
}

/** Склеить узкий и широкий списки по target (берём максимум n_sources). */
export function mergeSinkHits(a: SinkHit[], b: SinkHit[]): SinkHit[] {
  const m = new Map<string, SinkHit>();
  for (const x of [...a, ...b]) {
    const cur = m.get(x.targetWallet);
    if (!cur || x.nSources > cur.nSources || (x.nSources === cur.nSources && x.totalSol > cur.totalSol)) {
      m.set(x.targetWallet, x);
    }
  }
  return [...m.values()].sort((u, v) => v.nSources - u.nSources || v.totalSol - u.totalSol);
}

/** Рёбра seed→sink для построения мета-компонент (ограничение строк на прогон). */
export async function querySeedToSinkEdges(
  db: DB,
  cfg: ScamFarmGraphConfig,
  seeds: string[],
  sinkTargets: string[],
): Promise<Array<{ source: string; target: string }>> {
  if (seeds.length < 1 || sinkTargets.length < 1) return [];

  const hours = cfg.sinkLookbackHours;
  const asset = cfg.sinkAsset;
  const pairCap = 250_000;

  const rows = (await db.execute(sql`
    SELECT mf.source_wallet AS source_wallet,
           mf.target_wallet AS target_wallet
    FROM money_flows mf
    WHERE mf.asset = ${asset}
      AND mf.tx_time > now() - (${hours}::text || ' hours')::interval
      AND mf.source_wallet <> mf.target_wallet
      AND mf.source_wallet IN (${sql.join(
        seeds.map((w) => sql`${w}`),
        sql`, `,
      )})
      AND mf.target_wallet IN (${sql.join(
        sinkTargets.map((w) => sql`${w}`),
        sql`, `,
      )})
    LIMIT ${pairCap}
  `)) as unknown as Array<{ source_wallet: string; target_wallet: string }>;

  return rows.map((r) => ({ source: r.source_wallet, target: r.target_wallet }));
}

