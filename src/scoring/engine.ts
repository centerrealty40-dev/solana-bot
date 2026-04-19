import { sql as dsql } from 'drizzle-orm';
import pLimit from 'p-limit';
import { db, schema } from '../core/db/client.js';
import { child } from '../core/logger.js';
import {
  getActiveWallets30d,
  getWalletSwapsLast30d,
} from '../core/db/repository.js';
import { buildWalletAggregate } from './fifo.js';
import { computeRealizedPnl30d, computeWinrate } from './metrics/realized-pnl.js';
import {
  computeHoldingAvgMinutes,
  computeSellInTranchesRatio,
} from './metrics/holding-pattern.js';
import { computeConsistencyScore } from './metrics/consistency.js';
import { computeFundingOriginAge } from './metrics/funding-origin.js';
import { computeEarlyEntryScores } from './metrics/early-entry.js';
import { computeClusters } from './metrics/cluster.js';

const log = child('scoring-engine');

export interface ScoringRunOptions {
  /** override the candidate wallet list. Default: top-N active wallets in last 30d. */
  wallets?: string[];
  /** min trade count in window for a wallet to be considered */
  minTrades?: number;
  /** max wallets to score in one pass (cost guard) */
  maxWallets?: number;
  /** parallelism for per-wallet swap fetch */
  concurrency?: number;
  /** also compute clustering (expensive; can be skipped on intermediate runs) */
  withClustering?: boolean;
}

/**
 * Run a full scoring pass and upsert into wallet_scores.
 *
 * High-level flow:
 *   1. Pick candidate wallets (active in last 30d with >= minTrades)
 *   2. Pre-compute SQL-side metrics in batch (early-entry, funding-age)
 *   3. For each wallet, fetch swaps once and compute in-memory metrics
 *   4. Optionally compute clusters across all candidates
 *   5. Upsert wallet_scores in batches of 200
 */
export async function runScoring(opts: ScoringRunOptions = {}): Promise<{
  scored: number;
  durationMs: number;
}> {
  const t0 = Date.now();
  const minTrades = opts.minTrades ?? 5;
  const maxWallets = opts.maxWallets ?? 1000;
  const concurrency = opts.concurrency ?? 10;
  const since30 = new Date(Date.now() - 30 * 86_400_000);

  const candidates = (opts.wallets ?? (await getActiveWallets30d(minTrades))).slice(0, maxWallets);
  log.info({ candidates: candidates.length }, 'scoring candidates picked');
  if (candidates.length === 0) return { scored: 0, durationMs: Date.now() - t0 };

  // 2. Batch SQL-side metrics
  const [earlyMap, fundingAgeMap] = await Promise.all([
    computeEarlyEntryScores(candidates, since30),
    computeFundingOriginAge(candidates),
  ]);
  log.info(
    { earlyHits: earlyMap.size, fundingAgeKnown: fundingAgeMap.size },
    'sql-side metrics done',
  );

  // 3. Per-wallet metrics
  const limit = pLimit(concurrency);
  const perWallet = await Promise.all(
    candidates.map((w) =>
      limit(async () => {
        const swaps = await getWalletSwapsLast30d(w);
        if (swaps.length === 0) return null;
        const agg = buildWalletAggregate(w, swaps);
        return {
          wallet: w,
          realizedPnl30d: computeRealizedPnl30d(agg),
          winrate30d: computeWinrate(agg),
          holdingAvgMinutes: computeHoldingAvgMinutes(agg),
          sellInTranchesRatio: computeSellInTranchesRatio(agg),
          consistencyScore: computeConsistencyScore(agg),
          earlyEntryScore: earlyMap.get(w) ?? 0,
          fundingOriginAgeDays: fundingAgeMap.get(w) ?? 0,
          tradeCount30d: agg.tradeCount,
          distinctTokens30d: agg.distinctTokens,
        };
      }),
    ),
  );
  const rows = perWallet.filter((r): r is NonNullable<typeof r> => r !== null);
  log.info({ rows: rows.length }, 'per-wallet metrics computed');

  // 4. Clustering (optional)
  let clusterMap = new Map<string, string>();
  if (opts.withClustering ?? true) {
    clusterMap = await computeClusters(
      rows.map((r) => r.wallet),
      30,
    );
  }

  // 5. Upsert
  const now = new Date();
  const BATCH = 200;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH).map((r) => ({
      wallet: r.wallet,
      earlyEntryScore: r.earlyEntryScore,
      realizedPnl30d: r.realizedPnl30d,
      unrealizedPnl: 0,
      holdingAvgMinutes: r.holdingAvgMinutes,
      sellInTranchesRatio: r.sellInTranchesRatio,
      fundingOriginAgeDays: r.fundingOriginAgeDays,
      clusterId: clusterMap.get(r.wallet) ?? null,
      consistencyScore: r.consistencyScore,
      tradeCount30d: r.tradeCount30d,
      distinctTokens30d: r.distinctTokens30d,
      winrate30d: r.winrate30d,
      updatedAt: now,
    }));
    await db
      .insert(schema.walletScores)
      .values(batch)
      .onConflictDoUpdate({
        target: schema.walletScores.wallet,
        set: {
          earlyEntryScore: dsql`excluded.early_entry_score`,
          realizedPnl30d: dsql`excluded.realized_pnl_30d`,
          unrealizedPnl: dsql`excluded.unrealized_pnl`,
          holdingAvgMinutes: dsql`excluded.holding_avg_minutes`,
          sellInTranchesRatio: dsql`excluded.sell_in_tranches_ratio`,
          fundingOriginAgeDays: dsql`excluded.funding_origin_age_days`,
          clusterId: dsql`excluded.cluster_id`,
          consistencyScore: dsql`excluded.consistency_score`,
          tradeCount30d: dsql`excluded.trade_count_30d`,
          distinctTokens30d: dsql`excluded.distinct_tokens_30d`,
          winrate30d: dsql`excluded.winrate_30d`,
          updatedAt: dsql`excluded.updated_at`,
        },
      });
  }

  // Also propagate cluster_id back to wallets table for fast joins
  if (clusterMap.size > 0) {
    const entries = Array.from(clusterMap.entries());
    for (let i = 0; i < entries.length; i += BATCH) {
      const batch = entries.slice(i, i + BATCH);
      await db.transaction(async (tx) => {
        for (const [w, cid] of batch) {
          await tx
            .update(schema.wallets)
            .set({ clusterId: cid, updatedAt: now })
            .where(dsql`${schema.wallets.address} = ${w}`);
        }
      });
    }
  }

  return { scored: rows.length, durationMs: Date.now() - t0 };
}
