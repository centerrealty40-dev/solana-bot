import { and, desc, eq, gte, sql as dsql } from 'drizzle-orm';
import { db, schema } from './client.js';
import type { NormalizedSwap } from '../types.js';

/**
 * Idempotent insert of a normalized swap. Conflicting (signature,wallet,baseMint) rows are ignored.
 * Also upserts both the wallet and the token rows so we never have FK gaps.
 */
export async function insertSwap(swap: NormalizedSwap): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .insert(schema.wallets)
      .values({ address: swap.wallet, firstSeenAt: swap.blockTime })
      .onConflictDoNothing();

    await tx
      .insert(schema.tokens)
      .values({
        mint: swap.baseMint,
        firstSeenAt: swap.blockTime,
      })
      .onConflictDoNothing();

    await tx
      .insert(schema.swaps)
      .values({
        signature: swap.signature,
        slot: swap.slot,
        blockTime: swap.blockTime,
        wallet: swap.wallet,
        baseMint: swap.baseMint,
        quoteMint: swap.quoteMint,
        side: swap.side,
        baseAmountRaw: swap.baseAmountRaw,
        quoteAmountRaw: swap.quoteAmountRaw,
        priceUsd: swap.priceUsd,
        amountUsd: swap.amountUsd,
        dex: swap.dex,
        source: swap.source,
      })
      .onConflictDoNothing();
  });
}

export async function insertSwapsBatch(swaps: NormalizedSwap[]): Promise<number> {
  if (swaps.length === 0) return 0;
  let inserted = 0;
  await db.transaction(async (tx) => {
    const uniqueWallets = Array.from(new Set(swaps.map((s) => s.wallet)));
    const uniqueMints = Array.from(new Set(swaps.map((s) => s.baseMint)));
    if (uniqueWallets.length > 0) {
      await tx
        .insert(schema.wallets)
        .values(uniqueWallets.map((w) => ({ address: w })))
        .onConflictDoNothing();
    }
    if (uniqueMints.length > 0) {
      await tx
        .insert(schema.tokens)
        .values(uniqueMints.map((m) => ({ mint: m })))
        .onConflictDoNothing();
    }
    const result = await tx
      .insert(schema.swaps)
      .values(
        swaps.map((s) => ({
          signature: s.signature,
          slot: s.slot,
          blockTime: s.blockTime,
          wallet: s.wallet,
          baseMint: s.baseMint,
          quoteMint: s.quoteMint,
          side: s.side,
          baseAmountRaw: s.baseAmountRaw,
          quoteAmountRaw: s.quoteAmountRaw,
          priceUsd: s.priceUsd,
          amountUsd: s.amountUsd,
          dex: s.dex,
          source: s.source,
        })),
      )
      .onConflictDoNothing()
      .returning({ id: schema.swaps.id });
    inserted = result.length;
  });
  return inserted;
}

export async function getRecentSwapsForToken(
  baseMint: string,
  sinceMinutes = 60,
): Promise<(typeof schema.swaps.$inferSelect)[]> {
  const since = new Date(Date.now() - sinceMinutes * 60_000);
  return db
    .select()
    .from(schema.swaps)
    .where(and(eq(schema.swaps.baseMint, baseMint), gte(schema.swaps.blockTime, since)))
    .orderBy(desc(schema.swaps.blockTime))
    .limit(2000);
}

export async function getWalletSwapsLast30d(
  wallet: string,
): Promise<(typeof schema.swaps.$inferSelect)[]> {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60_000);
  return db
    .select()
    .from(schema.swaps)
    .where(and(eq(schema.swaps.wallet, wallet), gte(schema.swaps.blockTime, since)))
    .orderBy(desc(schema.swaps.blockTime))
    .limit(5000);
}

export async function getActiveWallets30d(minTrades = 5): Promise<string[]> {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60_000);
  const rows = await db
    .select({
      wallet: schema.swaps.wallet,
      cnt: dsql<number>`count(*)::int`.as('cnt'),
    })
    .from(schema.swaps)
    .where(gte(schema.swaps.blockTime, since))
    .groupBy(schema.swaps.wallet)
    .having(dsql`count(*) >= ${minTrades}`)
    .limit(5000);
  return rows.map((r) => r.wallet);
}
