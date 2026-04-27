import { sql as dsql } from 'drizzle-orm';
import { db, schema } from '../core/db/client.js';
import type {
  MarketCtx,
  NormalizedSwap,
  PriceSample,
  RecentSignalAgg,
  WalletScore,
} from '../core/types.js';

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
  // Aggregate recent signals on this mint by hypothesisId — used by meta-hypotheses (H7).
  // We fetch lightweight rows; full meta isn't needed here.
  const sigRows = await db.execute(dsql`
    SELECT DISTINCT ON (hypothesis_id, side)
           id, hypothesis_id, side, ts, reason
    FROM signals
    WHERE base_mint = ${baseMint} AND ts >= ${since}
    ORDER BY hypothesis_id, side, ts DESC
  `);
  const sigCounts = await db.execute(dsql`
    SELECT hypothesis_id, side, COUNT(*)::int AS cnt
    FROM signals
    WHERE base_mint = ${baseMint} AND ts >= ${since}
    GROUP BY hypothesis_id, side
  `);
  const countMap = new Map<string, number>();
  for (const r of sigCounts as unknown as Array<{
    hypothesis_id: string;
    side: string;
    cnt: number;
  }>) {
    countMap.set(`${r.hypothesis_id}|${r.side}`, r.cnt);
  }
  const recentSignals = new Map<string, RecentSignalAgg>();
  for (const r of sigRows as unknown as Array<{
    id: string | bigint;
    hypothesis_id: string;
    side: string;
    ts: Date;
    reason: string;
  }>) {
    const key = r.hypothesis_id;
    // Prefer 'buy' side over 'sell' if both present for same hypothesis on same mint
    const existing = recentSignals.get(key);
    if (existing && existing.side === 'buy' && r.side === 'sell') continue;
    recentSignals.set(key, {
      hypothesisId: r.hypothesis_id,
      side: r.side as 'buy' | 'sell',
      count: countMap.get(`${r.hypothesis_id}|${r.side}`) ?? 1,
      lastTs: r.ts,
      lastSignalId: BigInt(r.id),
      lastReason: r.reason,
    });
  }
  return {
    now: new Date(),
    recentSwaps,
    priceSamples,
    scores: walletScores,
    recentSignals,
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
