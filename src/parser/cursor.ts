import { eq } from 'drizzle-orm';
import { db, schema } from '../core/db/client.js';

export async function getLastEventId(programId: string): Promise<bigint> {
  const rows = await db
    .select({ last: schema.parserCursor.lastEventId })
    .from(schema.parserCursor)
    .where(eq(schema.parserCursor.programId, programId))
    .limit(1);
  const v = rows[0]?.last;
  if (v === undefined || v === null) return 0n;
  return typeof v === 'bigint' ? v : BigInt(String(v));
}

export async function upsertCursor(
  programId: string,
  lastEventId: bigint,
  lastSignature: string | null,
  lastSlot: number | null,
  stats: Record<string, unknown>,
): Promise<void> {
  await db
    .insert(schema.parserCursor)
    .values({
      programId,
      lastEventId,
      lastSignature: lastSignature ?? null,
      lastSlot: lastSlot ?? null,
      lastProcessedAt: new Date(),
      stats,
    })
    .onConflictDoUpdate({
      target: schema.parserCursor.programId,
      set: {
        lastEventId,
        lastSignature: lastSignature ?? null,
        lastSlot: lastSlot ?? null,
        lastProcessedAt: new Date(),
        stats,
      },
    });
}
