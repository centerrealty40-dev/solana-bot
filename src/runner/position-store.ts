import { and, eq, sql as dsql } from 'drizzle-orm';
import { db, schema } from '../core/db/client.js';
import type { ExecutorMode } from '../core/types.js';
import type { HypothesisPositionView } from '../hypotheses/base.js';

/**
 * Open a new position row + its first fill (entry trade).
 * Returns the freshly-created position id.
 */
export async function openPosition(args: {
  hypothesisId: string;
  mode: ExecutorMode;
  baseMint: string;
  quoteMint: string;
  sizeUsd: number;
  entryPriceUsd: number;
  baseAmountRaw: bigint;
  quoteAmountRaw: bigint;
  slippageBps: number;
  feeUsd: number;
  signature: string | null;
  signalMeta: Record<string, unknown>;
}): Promise<bigint> {
  return db.transaction(async (tx) => {
    const [pos] = await tx
      .insert(schema.positions)
      .values({
        hypothesisId: args.hypothesisId,
        mode: args.mode,
        baseMint: args.baseMint,
        quoteMint: args.quoteMint,
        sizeUsd: args.sizeUsd,
        entryPriceUsd: args.entryPriceUsd,
        baseAmountRaw: args.baseAmountRaw,
        costUsd: args.feeUsd,
        status: 'open',
        signalMeta: args.signalMeta,
      })
      .returning({ id: schema.positions.id });
    const positionId = pos!.id;
    await tx.insert(schema.trades).values({
      positionId,
      side: 'buy',
      baseAmountRaw: args.baseAmountRaw,
      quoteAmountRaw: args.quoteAmountRaw,
      priceUsd: args.entryPriceUsd,
      slippageBps: args.slippageBps,
      feeUsd: args.feeUsd,
      signature: args.signature,
    });
    return positionId;
  });
}

/**
 * Apply a partial or full exit to an existing position. Updates baseAmountRaw,
 * realizedPnlUsd and status. Inserts a sell trade row.
 *
 * @returns updated position row
 */
export async function applyExit(args: {
  positionId: bigint;
  fraction: number;
  exitPriceUsd: number;
  slippageBps: number;
  feeUsd: number;
  signature: string | null;
  reason: string;
}): Promise<typeof schema.positions.$inferSelect> {
  return db.transaction(async (tx) => {
    const [cur] = await tx
      .select()
      .from(schema.positions)
      .where(eq(schema.positions.id, args.positionId))
      .for('update');
    if (!cur) throw new Error(`position ${args.positionId} not found`);
    if (cur.status !== 'open') throw new Error(`position ${args.positionId} is ${cur.status}`);
    const sellRaw = scaleBigInt(cur.baseAmountRaw, args.fraction);
    if (sellRaw <= 0n) {
      return cur;
    }
    // Approx: realized PnL = (exit - entry) * sellRaw / decimals  — we don't have decimals here
    // so use proportional notional: notional sold = sizeUsd * fraction
    const notionalSold = cur.sizeUsd * args.fraction;
    const ratio = args.exitPriceUsd / cur.entryPriceUsd;
    const realized = notionalSold * (ratio - 1) - args.feeUsd;
    const newBase = cur.baseAmountRaw - sellRaw;
    const closing = newBase <= 0n || args.fraction >= 0.999;
    const upd = await tx
      .update(schema.positions)
      .set({
        baseAmountRaw: closing ? 0n : newBase,
        realizedPnlUsd: cur.realizedPnlUsd + realized,
        costUsd: cur.costUsd + args.feeUsd,
        status: closing ? 'closed' : 'open',
        closedAt: closing ? new Date() : null,
        exitPriceUsd: args.exitPriceUsd,
        closeReason: closing ? args.reason : cur.closeReason,
      })
      .where(eq(schema.positions.id, args.positionId))
      .returning();
    await tx.insert(schema.trades).values({
      positionId: args.positionId,
      side: 'sell',
      baseAmountRaw: sellRaw,
      quoteAmountRaw: BigInt(Math.round(notionalSold * args.exitPriceUsd / Math.max(cur.entryPriceUsd, 1e-9) * 1_000_000)),
      priceUsd: args.exitPriceUsd,
      slippageBps: args.slippageBps,
      feeUsd: args.feeUsd,
      signature: args.signature,
    });
    return upd[0]!;
  });
}

function scaleBigInt(amount: bigint, fraction: number): bigint {
  if (fraction >= 1) return amount;
  if (fraction <= 0) return 0n;
  // multiply via integer math: amount * round(fraction*1e9) / 1e9
  const factor = BigInt(Math.round(fraction * 1_000_000_000));
  return (amount * factor) / 1_000_000_000n;
}

/**
 * Load all open positions for a hypothesis as read-only views.
 */
export async function loadOpenPositionViews(
  hypothesisId: string,
  currentPrice: (mint: string) => number | undefined,
): Promise<HypothesisPositionView[]> {
  const rows = await db
    .select()
    .from(schema.positions)
    .where(
      and(
        eq(schema.positions.hypothesisId, hypothesisId),
        eq(schema.positions.status, 'open'),
      ),
    );
  const ids = rows.map((r) => r.id);
  if (ids.length === 0) return [];
  const exitsRows = await db.execute(dsql`
    SELECT position_id, COUNT(*) AS n
    FROM trades
    WHERE side = 'sell' AND position_id = ANY(${dsql.raw(`ARRAY[${ids.join(',')}]::bigint[]`)})
    GROUP BY position_id
  `);
  const exitsById = new Map<string, number>();
  for (const r of exitsRows as unknown as Array<{ position_id: bigint | string; n: bigint | number }>) {
    exitsById.set(String(r.position_id), Number(r.n));
  }
  return rows.map((p) => {
    const px = currentPrice(p.baseMint) ?? p.entryPriceUsd;
    const ratio = px / Math.max(p.entryPriceUsd, 1e-12);
    return {
      positionId: p.id,
      hypothesisId: p.hypothesisId,
      baseMint: p.baseMint,
      quoteMint: p.quoteMint,
      openedAt: p.openedAt,
      sizeUsd: p.sizeUsd,
      entryPriceUsd: p.entryPriceUsd,
      baseAmountRaw: p.baseAmountRaw,
      signalMeta: p.signalMeta as Record<string, unknown>,
      currentPriceUsd: px,
      unrealizedPnlUsd: p.sizeUsd * (ratio - 1),
      exitsCount: exitsById.get(String(p.id)) ?? 0,
    };
  });
}
