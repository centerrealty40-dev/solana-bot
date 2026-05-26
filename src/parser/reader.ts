import { and, asc, eq, gt, gte, sql } from 'drizzle-orm';
import { db, schema } from '../core/db/client.js';

export type StreamEventRef = {
  id: bigint;
  signature: string;
  slot: number;
};

export async function readStreamBatch(
  programId: string,
  afterId: bigint,
  lookbackHours: number,
  limit: number,
): Promise<StreamEventRef[]> {
  const hours = Math.max(1, Math.floor(lookbackHours));
  const since = sql.raw(`now() - interval '${hours} hours'`);

  const rows = await db
    .select({
      id: schema.streamEvents.id,
      signature: schema.streamEvents.signature,
      slot: schema.streamEvents.slot,
    })
    .from(schema.streamEvents)
    .where(and(eq(schema.streamEvents.programId, programId), gt(schema.streamEvents.id, afterId), gte(schema.streamEvents.receivedAt, since)))
    .orderBy(asc(schema.streamEvents.id))
    .limit(limit);

  return rows.map((r) => ({
    id: typeof r.id === 'bigint' ? r.id : BigInt(r.id as unknown as string),
    signature: r.signature,
    slot: r.slot,
  }));
}
