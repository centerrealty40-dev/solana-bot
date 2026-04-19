import { sql as dsql } from 'drizzle-orm';
import { db, schema } from '../core/db/client.js';
import type { MarketCtx, NormalizedSwap, PriceSample, WalletScore } from '../core/types.js';

/**
 * Build a fresh MarketCtx for a token at a given moment.
 *
 * Used by both onSwap (to give hypothesis context to a single swap) and the periodic
 * shouldExit loop (to give context to open positions).
 */
export async function buildMarketCtx(
  baseMint: string,
  walletScores: ReadonlyMap<string, WalletScore>,
): Promise<MarketCtx> {
  const since = new Date(Date.now() - 60 * 60_000);
  const swapRows = await db
    .select()
    .from(schema.swaps)
    .where(dsql`${schema.swaps.baseMint} = ${baseMint} AND ${schema.swaps.blockTime} >= ${since}`)
    .orderBy(dsql`${schema.swaps.blockTime} DESC`)
    .limit(500);
  const recentSwaps: NormalizedSwap[] = swapRows.map((r) => ({
    signature: r.signature,
    slot: Number(r.slot),
    blockTime: r.blockTime,
    wallet: r.wallet,
    baseMint: r.baseMint,
    quoteMint: r.quoteMint,
    side: r.side as 'buy' | 'sell',
    baseAmountRaw: r.baseAmountRaw,
    quoteAmountRaw: r.quoteAmountRaw,
    priceUsd: r.priceUsd,
    amountUsd: r.amountUsd,
    dex: r.dex as NormalizedSwap['dex'],
    source: r.source as NormalizedSwap['source'],
  }));
  const sampleRows = await db
    .select()
    .from(schema.priceSamples)
    .where(dsql`${schema.priceSamples.mint} = ${baseMint} AND ${schema.priceSamples.ts} >= ${since}`)
    .orderBy(dsql`${schema.priceSamples.ts} DESC`)
    .limit(60);
  const priceSamples: PriceSample[] = sampleRows.map((r) => ({
    mint: r.mint,
    ts: r.ts,
    priceUsd: r.priceUsd,
    volumeUsd5m: r.volumeUsd5m,
  }));
  return {
    now: new Date(),
    recentSwaps,
    priceSamples,
    scores: walletScores,
  };
}

export async function loadAllScores(): Promise<Map<string, WalletScore>> {
  const rows = await db.select().from(schema.walletScores);
  return new Map(
    rows.map((r) => [
      r.wallet,
      {
        wallet: r.wallet,
        earlyEntryScore: r.earlyEntryScore,
        realizedPnl30d: r.realizedPnl30d,
        holdingAvgMinutes: r.holdingAvgMinutes,
        sellInTranchesRatio: r.sellInTranchesRatio,
        fundingOriginAgeDays: r.fundingOriginAgeDays,
        clusterId: r.clusterId,
        consistencyScore: r.consistencyScore,
        updatedAt: r.updatedAt,
      },
    ]),
  );
}

/**
 * Best-known recent price for a mint, used by exit logic.
 * Tries last swap, then last price_samples row.
 */
export async function getCurrentPrice(mint: string): Promise<number | null> {
  const last = await db
    .select({ price: schema.swaps.priceUsd })
    .from(schema.swaps)
    .where(dsql`${schema.swaps.baseMint} = ${mint}`)
    .orderBy(dsql`${schema.swaps.blockTime} DESC`)
    .limit(1);
  if (last[0]?.price) return last[0].price;
  const sample = await db
    .select({ price: schema.priceSamples.priceUsd })
    .from(schema.priceSamples)
    .where(dsql`${schema.priceSamples.mint} = ${mint}`)
    .orderBy(dsql`${schema.priceSamples.ts} DESC`)
    .limit(1);
  return sample[0]?.price ?? null;
}
