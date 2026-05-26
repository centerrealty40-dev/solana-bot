import { and, asc, gt, gte, sql } from 'drizzle-orm';
import { db, schema } from '../core/db/client.js';

export type SwapTailRow = {
  id: bigint;
  signature: string;
  slot: number;
  blockTime: Date;
  wallet: string;
  baseMint: string;
  side: string;
  quoteAmountRaw: bigint;
  amountUsd: number;
  dex: string;
};

export async function readSwapBatch(
  afterSwapId: bigint,
  lookbackHours: number,
  limit: number,
): Promise<SwapTailRow[]> {
  const hours = Math.max(1, Math.floor(lookbackHours));
  const since = sql.raw(`now() - interval '${hours} hours'`);

  const rows = await db
    .select({
      id: schema.swaps.id,
      signature: schema.swaps.signature,
      slot: schema.swaps.slot,
      blockTime: schema.swaps.blockTime,
      wallet: schema.swaps.wallet,
      baseMint: schema.swaps.baseMint,
      side: schema.swaps.side,
      quoteAmountRaw: schema.swaps.quoteAmountRaw,
      amountUsd: schema.swaps.amountUsd,
      dex: schema.swaps.dex,
    })
    .from(schema.swaps)
    .where(and(gt(schema.swaps.id, afterSwapId), gte(schema.swaps.createdAt, since)))
    .orderBy(asc(schema.swaps.id))
    .limit(limit);

  return rows.map((r) => ({
    id: typeof r.id === 'bigint' ? r.id : BigInt(String(r.id)),
    signature: r.signature,
    slot: r.slot,
    blockTime: r.blockTime,
    wallet: r.wallet,
    baseMint: r.baseMint,
    side: r.side,
    quoteAmountRaw: typeof r.quoteAmountRaw === 'bigint' ? r.quoteAmountRaw : BigInt(String(r.quoteAmountRaw)),
    amountUsd: r.amountUsd,
    dex: r.dex,
  }));
}
