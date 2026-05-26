import { eq } from 'drizzle-orm';
import type { DB } from '../core/db/client.js';
import { schema } from '../core/db/client.js';

export type AtlasTx = Parameters<Parameters<DB['transaction']>[0]>[0];

const CURSOR_NAME = 'swap-enrich';

export function atlasCursorName(): string {
  return CURSOR_NAME;
}

export async function getLastSwapId(dbh: DB | AtlasTx): Promise<bigint> {
  const rows = await dbh
    .select({ last: schema.atlasCursor.lastSwapId })
    .from(schema.atlasCursor)
    .where(eq(schema.atlasCursor.name, CURSOR_NAME))
    .limit(1);
  const v = rows[0]?.last;
  if (v === undefined || v === null) return 0n;
  return typeof v === 'bigint' ? v : BigInt(String(v));
}

export async function upsertAtlasCursor(
  tx: AtlasTx,
  lastSwapId: bigint,
  stats: Record<string, unknown>,
): Promise<void> {
  await tx
    .insert(schema.atlasCursor)
    .values({
      name: CURSOR_NAME,
      lastSwapId,
      lastProcessedAt: new Date(),
      stats,
    })
    .onConflictDoUpdate({
      target: schema.atlasCursor.name,
      set: {
        lastSwapId,
        lastProcessedAt: new Date(),
        stats,
      },
    });
}
