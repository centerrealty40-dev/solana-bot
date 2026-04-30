import { count, gte, sql } from 'drizzle-orm';
import { db, schema } from '../core/db/client.js';
import { streamMetrics } from './writer.js';

export type StreamHealthSnapshot = {
  gauges: typeof streamMetrics;
  recent5m: number;
  total: number;
  m1: number;
  m5: number;
  last_event_at_db: Date | null;
  distinct_programs: number;
};

export async function getHealthSnapshot(): Promise<StreamHealthSnapshot> {
  const fiveAgo = new Date(Date.now() - 5 * 60_000);
  const oneAgo = new Date(Date.now() - 1 * 60_000);

  const [{ total }] = await db.select({ total: count() }).from(schema.streamEvents);
  const [{ m1 }] = await db
    .select({ m1: count() })
    .from(schema.streamEvents)
    .where(gte(schema.streamEvents.receivedAt, oneAgo));
  const [{ m5 }] = await db
    .select({ m5: count() })
    .from(schema.streamEvents)
    .where(gte(schema.streamEvents.receivedAt, fiveAgo));

  const [mxRow] = await db
    .select({
      last_event_at_db: sql<Date | null>`max(${schema.streamEvents.receivedAt})`,
    })
    .from(schema.streamEvents);

  const [dpRow] = await db
    .select({
      dp: sql<number>`count(distinct ${schema.streamEvents.programId})::int`.mapWith(Number),
    })
    .from(schema.streamEvents);

  return {
    gauges: { ...streamMetrics },
    recent5m: Number(m5),
    total: Number(total),
    m1: Number(m1),
    m5: Number(m5),
    last_event_at_db: mxRow?.last_event_at_db ?? null,
    distinct_programs: Number(dpRow?.dp ?? 0),
  };
}
