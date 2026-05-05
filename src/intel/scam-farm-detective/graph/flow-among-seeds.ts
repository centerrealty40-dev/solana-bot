import { sql } from 'drizzle-orm';
import type { DB } from '../../../core/db/client.js';
import type { ScamFarmGraphConfig } from './config.js';

/** Прямые SOL-потоки между seed-кошельками (усиливают связность мета-слоя). */
export async function queryFlowsAmongSeeds(
  db: DB,
  cfg: ScamFarmGraphConfig,
  seeds: string[],
): Promise<Array<{ source: string; target: string }>> {
  if (!cfg.metaFlowEdges || seeds.length < 2) return [];
  const lim = cfg.metaFlowEdgesLimit;
  const hours = cfg.sinkLookbackHours;
  const asset = cfg.sinkAsset;

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
        seeds.map((w) => sql`${w}`),
        sql`, `,
      )})
    LIMIT ${lim}
  `)) as unknown as Array<{ source_wallet: string; target_wallet: string }>;

  return rows.map((r) => ({ source: r.source_wallet, target: r.target_wallet }));
}
