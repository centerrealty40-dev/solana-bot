import { sql } from 'drizzle-orm';
import { db } from '../core/db/client.js';
import { atlasMetrics } from './metrics.js';
import { atlasCursorName } from './cursor.js';

export type AtlasHealth = {
  gauges: typeof atlasMetrics;
  ew_total: number;
  ew_m5: number;
  atlas_tags_total: number;
  atlas_tags_m5: number;
  atlas_flows_m5: number;
  cursor_id: string | null;
  lag_swaps: number;
};

export async function getAtlasHealthSnapshot(): Promise<AtlasHealth> {
  const cursorName = atlasCursorName();

  const rows = (await db.execute(sql`
    SELECT
      (SELECT count(*)::text FROM entity_wallets) AS ew_total,
      (SELECT count(*)::text FROM entity_wallets WHERE profile_updated_at > now() - interval '5 minutes') AS ew_m5,
      (SELECT count(*)::text FROM wallet_tags WHERE source = 'sa-atlas') AS atlas_tags_total,
      (SELECT count(*)::text FROM wallet_tags WHERE source = 'sa-atlas' AND added_at > now() - interval '5 minutes') AS atlas_tags_m5,
      (SELECT count(*)::text FROM money_flows WHERE observed_at > now() - interval '5 minutes' AND target_wallet LIKE 'pump:%') AS atlas_flows_m5,
      (SELECT last_swap_id::text FROM atlas_cursor WHERE name = ${cursorName}) AS cursor_id,
      (SELECT count(*)::text FROM swaps WHERE id > coalesce((SELECT last_swap_id FROM atlas_cursor WHERE name = ${cursorName}), 0)) AS lag_swaps
  `)) as unknown as Array<{
    ew_total: string | null;
    ew_m5: string | null;
    atlas_tags_total: string | null;
    atlas_tags_m5: string | null;
    atlas_flows_m5: string | null;
    cursor_id: string | null;
    lag_swaps: string | null;
  }>;

  const row = rows[0];
  const num = (v: string | null | undefined) => Number(v ?? 0);

  return {
    gauges: { ...atlasMetrics },
    ew_total: num(row?.ew_total),
    ew_m5: num(row?.ew_m5),
    atlas_tags_total: num(row?.atlas_tags_total),
    atlas_tags_m5: num(row?.atlas_tags_m5),
    atlas_flows_m5: num(row?.atlas_flows_m5),
    cursor_id: row?.cursor_id ?? null,
    lag_swaps: num(row?.lag_swaps),
  };
}
