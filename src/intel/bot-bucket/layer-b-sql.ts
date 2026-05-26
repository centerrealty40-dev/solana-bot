import { sql } from 'drizzle-orm';
import type { DB } from '../../core/db/client.js';
import type { BotBucketConfig } from './config.js';
import {
  SOURCE_BOT_RULE_FLOW_FANOUT_V0,
  SOURCE_BOT_RULE_MANY_MINTS_V0,
  SOURCE_BOT_RULE_SWAP_BURST_V0,
} from './constants.js';
import { upsertBotTag } from './persist.js';

/** BOT_RULE_SWAP_BURST — высокая частота свапов, узкая медиана интервала. */
export async function querySwapBurstWallets(db: DB, c: BotBucketConfig): Promise<
  Array<{ wallet: string; swapCnt: number; medianGap: number }>
> {
  const h = c.sinceHours;
  const cap = c.maxWalletsPerRule;

  const rows = (await db.execute(sql`
    WITH sw AS (
      SELECT s.wallet AS wallet,
             s.block_time AS block_time,
             EXTRACT(EPOCH FROM (
               s.block_time - LAG(s.block_time) OVER (PARTITION BY s.wallet ORDER BY s.block_time)
             )) AS gap_sec
      FROM swaps s
      WHERE s.block_time > now() - (${String(h)}::text || ' hours')::interval
    ),
    agg AS (
      SELECT sw.wallet AS wallet,
             COUNT(*)::int AS swap_cnt,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY sw.gap_sec)
               FILTER (WHERE sw.gap_sec IS NOT NULL AND sw.gap_sec >= 0) AS median_gap
      FROM sw
      GROUP BY sw.wallet
      HAVING COUNT(*) >= ${c.swapCountMin}
    )
    SELECT agg.wallet AS wallet,
           agg.swap_cnt AS swap_cnt,
           agg.median_gap::float8 AS median_gap
    FROM agg
    WHERE agg.median_gap IS NOT NULL
      AND agg.median_gap <= ${c.medianGapSecMax}
    ORDER BY agg.swap_cnt DESC
    LIMIT ${cap}
  `)) as unknown as Array<{ wallet: string; swap_cnt: number; median_gap: number }>;

  return rows.map((r) => ({
    wallet: r.wallet,
    swapCnt: r.swap_cnt,
    medianGap: Number(r.median_gap),
  }));
}

/** BOT_RULE_MANY_MINTS — много разных mint, относительно мелкий средний размер. */
export async function queryManyMintsWallets(db: DB, c: BotBucketConfig): Promise<
  Array<{ wallet: string; nMints: number; avgUsd: number; nSwaps: number }>
> {
  const h = c.sinceHours;
  const cap = c.maxWalletsPerRule;

  const rows = (await db.execute(sql`
    SELECT s.wallet AS wallet,
           COUNT(DISTINCT s.base_mint)::int AS n_mints,
           AVG(s.amount_usd)::float8 AS avg_usd,
           COUNT(*)::int AS n_swaps
    FROM swaps s
    WHERE s.block_time > now() - (${String(h)}::text || ' hours')::interval
    GROUP BY s.wallet
    HAVING COUNT(DISTINCT s.base_mint) >= ${c.distinctMintsMin}
       AND AVG(s.amount_usd) <= ${c.avgTradeUsdMax}
       AND COUNT(*) >= ${c.manyMintsSwapMin}
    ORDER BY COUNT(DISTINCT s.base_mint) DESC
    LIMIT ${cap}
  `)) as unknown as Array<{ wallet: string; n_mints: number; avg_usd: number; n_swaps: number }>;

  return rows.map((r) => ({
    wallet: r.wallet,
    nMints: r.n_mints,
    avgUsd: Number(r.avg_usd),
    nSwaps: r.n_swaps,
  }));
}

/** BOT_RULE_FLOW_FANOUT — много исходящих SOL-получателей (не дублирует узкие bot_farm_* жёстко). */
export async function queryFlowFanoutWallets(db: DB, c: BotBucketConfig): Promise<
  Array<{ wallet: string; nTargets: number }>
> {
  const h = c.sinceHours;
  const cap = c.maxWalletsPerRule;

  const rows = (await db.execute(sql`
    SELECT mf.source_wallet AS wallet,
           COUNT(DISTINCT mf.target_wallet)::int AS n_targets
    FROM money_flows mf
    WHERE mf.asset = 'SOL'
      AND mf.tx_time > now() - (${String(h)}::text || ' hours')::interval
      AND mf.source_wallet <> mf.target_wallet
      AND mf.amount >= ${c.fanoutMinSolPerLeg}
    GROUP BY mf.source_wallet
    HAVING COUNT(DISTINCT mf.target_wallet) >= ${c.fanoutDistinctTargetsMin}
    ORDER BY n_targets DESC
    LIMIT ${cap}
  `)) as unknown as Array<{ wallet: string; n_targets: number }>;

  return rows.map((r) => ({ wallet: r.wallet, nTargets: r.n_targets }));
}

export async function applyLayerBSwapBurst(
  db: DB,
  c: BotBucketConfig,
  dryRun: boolean,
): Promise<{ candidates: number; written: number }> {
  if (!c.layerBSwapBurst) return { candidates: 0, written: 0 };
  const rows = await querySwapBurstWallets(db, c);
  let written = 0;
  for (const r of rows) {
    if (!dryRun) {
      await upsertBotTag(r.wallet, SOURCE_BOT_RULE_SWAP_BURST_V0, 62, {
        rule_set: c.ruleSet,
        layer: 'B',
        rule: 'BOT_RULE_SWAP_BURST',
        swap_cnt: r.swapCnt,
        median_gap_sec: r.medianGap,
        since_hours: c.sinceHours,
      });
      written += 1;
    }
  }
  return { candidates: rows.length, written };
}

export async function applyLayerBManyMints(
  db: DB,
  c: BotBucketConfig,
  dryRun: boolean,
): Promise<{ candidates: number; written: number }> {
  if (!c.layerBManyMints) return { candidates: 0, written: 0 };
  const rows = await queryManyMintsWallets(db, c);
  let written = 0;
  for (const r of rows) {
    if (!dryRun) {
      await upsertBotTag(r.wallet, SOURCE_BOT_RULE_MANY_MINTS_V0, 58, {
        rule_set: c.ruleSet,
        layer: 'B',
        rule: 'BOT_RULE_MANY_MINTS',
        distinct_mints: r.nMints,
        avg_trade_usd: r.avgUsd,
        swap_cnt: r.nSwaps,
        since_hours: c.sinceHours,
      });
      written += 1;
    }
  }
  return { candidates: rows.length, written };
}

export async function applyLayerBFanout(
  db: DB,
  c: BotBucketConfig,
  dryRun: boolean,
): Promise<{ candidates: number; written: number }> {
  if (!c.layerBFanout) return { candidates: 0, written: 0 };
  const rows = await queryFlowFanoutWallets(db, c);
  let written = 0;
  for (const r of rows) {
    if (!dryRun) {
      await upsertBotTag(r.wallet, SOURCE_BOT_RULE_FLOW_FANOUT_V0, 55, {
        rule_set: c.ruleSet,
        layer: 'B',
        rule: 'BOT_RULE_FLOW_FANOUT',
        distinct_targets: r.nTargets,
        since_hours: c.sinceHours,
      });
      written += 1;
    }
  }
  return { candidates: rows.length, written };
}
