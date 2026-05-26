import { sql } from 'drizzle-orm';
import { db } from '../core/db/client.js';
import { parserMetrics } from './metrics.js';

export type ParserHealth = {
  gauges: typeof parserMetrics;
  swaps_total: number;
  m1: number;
  m5: number;
  last_block_time: Date | null;
  last_inserted_at: Date | null;
  cursor_id: string | null;
  lag_events: number;
};

/** Snapshot for periodic logs — mirrors dashboard SQL shape loosely. */
export async function getParserHealthSnapshot(programId: string): Promise<ParserHealth> {
  const rows = (await db.execute(sql`
    SELECT
      (SELECT count(*)::text FROM swaps) AS swaps_total,
      (SELECT count(*)::text FROM swaps WHERE created_at > now() - interval '1 minute') AS m1,
      (SELECT count(*)::text FROM swaps WHERE created_at > now() - interval '5 minutes') AS m5,
      (SELECT max(block_time) FROM swaps) AS last_block_time,
      (SELECT max(created_at) FROM swaps) AS last_inserted_at,
      (SELECT last_event_id::text FROM parser_cursor WHERE program_id = ${programId}) AS cursor_id,
      (SELECT count(*)::text FROM stream_events
         WHERE program_id = ${programId}
           AND id > coalesce((SELECT last_event_id FROM parser_cursor WHERE program_id = ${programId}), 0)) AS lag_events
  `)) as unknown as Array<{
    swaps_total: string | null;
    m1: string | null;
    m5: string | null;
    last_block_time: Date | null;
    last_inserted_at: Date | null;
    cursor_id: string | null;
    lag_events: string | null;
  }>;

  const row = rows[0];

  const num = (v: string | null | undefined) => Number(v ?? 0);

  return {
    gauges: { ...parserMetrics },
    swaps_total: num(row?.swaps_total),
    m1: num(row?.m1),
    m5: num(row?.m5),
    last_block_time: row?.last_block_time ?? null,
    last_inserted_at: row?.last_inserted_at ?? null,
    cursor_id: row?.cursor_id ?? null,
    lag_events: num(row?.lag_events),
  };
}
