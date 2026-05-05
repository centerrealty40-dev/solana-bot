import { sql } from 'drizzle-orm';
import type { DB } from '../../../core/db/client.js';
import type { ScamFarmGraphConfig } from './config.js';

export type RelayHit = { hub: string; nIn: number; nOut: number };

export async function queryRelayHubs(db: DB, cfg: ScamFarmGraphConfig, hubCandidates: string[]): Promise<RelayHit[]> {
  if (!cfg.relayEnabled || hubCandidates.length < 1) return [];

  const hubs = hubCandidates.slice(0, cfg.relayHubCap);
  const hours = cfg.sinkLookbackHours;
  const asset = cfg.sinkAsset;
  const minIn = cfg.relayMinIn;
  const minOut = cfg.relayMinOut;

  const rows = (await db.execute(sql`
    WITH hub_list(hub) AS (
      VALUES ${sql.join(
        hubs.map((h) => sql`(${h})`),
        sql`, `,
      )}
    ),
    to_h AS (
      SELECT mf.target_wallet AS hub,
             COUNT(DISTINCT mf.source_wallet)::int AS n_in
      FROM money_flows mf
      INNER JOIN hub_list h ON h.hub = mf.target_wallet
      WHERE mf.asset = ${asset}
        AND mf.tx_time > now() - (${hours}::text || ' hours')::interval
        AND mf.source_wallet <> mf.target_wallet
      GROUP BY mf.target_wallet
    ),
    from_h AS (
      SELECT mf.source_wallet AS hub,
             COUNT(DISTINCT mf.target_wallet)::int AS n_out
      FROM money_flows mf
      INNER JOIN hub_list h ON h.hub = mf.source_wallet
      WHERE mf.asset = ${asset}
        AND mf.tx_time > now() - (${hours}::text || ' hours')::interval
      GROUP BY mf.source_wallet
    )
    SELECT to_h.hub AS hub,
           to_h.n_in AS n_in,
           from_h.n_out AS n_out
    FROM to_h
    INNER JOIN from_h ON from_h.hub = to_h.hub
    WHERE to_h.n_in >= ${minIn}
      AND from_h.n_out >= ${minOut}
  `)) as unknown as Array<{ hub: string; n_in: number; n_out: number }>;

  return rows.map((r) => ({ hub: r.hub, nIn: r.n_in, nOut: r.n_out }));
}
