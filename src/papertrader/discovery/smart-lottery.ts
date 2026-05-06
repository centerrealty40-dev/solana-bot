import { sql as dsql } from 'drizzle-orm';
import { db } from '../../core/db/client.js';
import type { PaperTraderConfig } from '../config.js';
import type { Lane, SnapshotCandidateRow, SnapshotFeatures, WhaleAnalysis } from '../types.js';
import { evaluateSnapshotSmartLottery } from '../filters/snapshot-filter.js';
import { globalGate } from '../filters/global-gate.js';
import { fetchWhaleAnalysis } from '../whale-analysis.js';
import { resolveHolderCount } from '../holders/holders-resolve.js';
import {
  evaluatedAtMap,
  lastEntryTsByMintMap,
  lastLossExitTsByMintMap,
  type DiscoveryTickResult,
  type EvalDecision,
  type HoldersDecisionMeta,
} from './dip-clones.js';
import { evaluateSmartLotteryIntelGate } from './smart-lottery-intel.js';

const SNAPSHOT_TABLES: Array<{ table: string; source: string }> = [
  { table: 'raydium_pair_snapshots', source: 'raydium' },
  { table: 'meteora_pair_snapshots', source: 'meteora' },
  { table: 'orca_pair_snapshots', source: 'orca' },
  { table: 'moonshot_pair_snapshots', source: 'moonshot' },
  { table: 'pumpswap_pair_snapshots', source: 'pumpswap' },
];

export async function fetchSmartLotteryLaneCandidates(
  cfg: PaperTraderConfig,
  lane: Lane,
): Promise<SnapshotCandidateRow[]> {
  const lc =
    lane === 'migration_event'
      ? {
          MIN_AGE_MIN: cfg.smlotMigMinAgeMin,
          MAX_AGE_MIN: cfg.smlotMigMaxAgeMin,
          MIN_LIQ_USD: cfg.smlotMigMinLiqUsd,
          MAX_LIQ_USD: cfg.smlotMigMaxLiqUsd,
          MIN_VOL_5M_USD: cfg.smlotMigMinVol5mUsd,
          MIN_BUYS_5M: cfg.smlotMigMinBuys5m,
          MIN_SELLS_5M: cfg.smlotMigMinSells5m,
        }
      : {
          MIN_AGE_MIN: cfg.smlotPostMinAgeMin,
          MAX_AGE_MIN: cfg.smlotPostMaxAgeMin,
          MIN_LIQ_USD: cfg.smlotPostMinLiqUsd,
          MAX_LIQ_USD: cfg.smlotPostMaxLiqUsd,
          MIN_VOL_5M_USD: cfg.smlotPostMinVol5mUsd,
          MIN_BUYS_5M: cfg.smlotPostMinBuys5m,
          MIN_SELLS_5M: cfg.smlotPostMinSells5m,
        };

  const unions = SNAPSHOT_TABLES.map(
    (t) => `
    SELECT
      p.base_mint AS mint,
      COALESCE(tok.symbol, '?') AS symbol,
      COALESCE(tok.holder_count, 0)::int AS holder_count,
      EXTRACT(EPOCH FROM (now() - COALESCE(p.launch_ts, tok.first_seen_at, p.ts))) / 60.0 AS token_age_min,
      p.ts,
      p.launch_ts AS launch_ts,
      EXTRACT(EPOCH FROM (p.ts - COALESCE(p.launch_ts, tok.first_seen_at, p.ts))) / 60.0 AS age_min,
      COALESCE(p.price_usd, 0)::float AS price_usd,
      COALESCE(p.liquidity_usd, 0)::float AS liquidity_usd,
      COALESCE(p.volume_5m, 0)::float AS volume_5m,
      COALESCE(p.volume_1h, 0)::float AS volume_1h,
      COALESCE(p.buys_5m, 0)::int AS buys_5m,
      COALESCE(p.sells_5m, 0)::int AS sells_5m,
      COALESCE(p.market_cap_usd, p.fdv_usd, 0)::float AS market_cap_usd,
      p.pair_address::text AS pair_address,
      '${t.source}'::text AS source
    FROM ${t.table} p
    LEFT JOIN tokens tok ON tok.mint = p.base_mint
    WHERE p.ts >= now() - interval '30 minutes'
      AND COALESCE(p.price_usd, 0) > 0
  `,
  ).join('\nUNION ALL\n');

  const maxAgeFilter = lc.MAX_AGE_MIN > 0 ? `AND COALESCE(age_min, 0) <= ${lc.MAX_AGE_MIN}` : '';
  const maxLiqFilter = lc.MAX_LIQ_USD > 0 ? `AND liquidity_usd <= ${lc.MAX_LIQ_USD}` : '';
  const limit =
    cfg.smlotSnapshotCandidateLimit > 0 ? cfg.smlotSnapshotCandidateLimit : cfg.snapshotCandidateLimit;

  const r = await db.execute(dsql.raw(`
    WITH raw AS (
      ${unions}
    ),
    ranked AS (
      SELECT *,
             ROW_NUMBER() OVER (PARTITION BY mint ORDER BY ts DESC) AS rn
      FROM raw
    )
    SELECT *
    FROM ranked
    WHERE rn = 1
      AND COALESCE(age_min, 0) >= ${lc.MIN_AGE_MIN}
      ${maxAgeFilter}
      AND liquidity_usd >= ${lc.MIN_LIQ_USD}
      ${maxLiqFilter}
      AND volume_5m >= ${lc.MIN_VOL_5M_USD}
      AND buys_5m >= ${lc.MIN_BUYS_5M}
      AND sells_5m >= ${lc.MIN_SELLS_5M}
    ORDER BY ts DESC
    LIMIT ${limit}
  `));
  return r as unknown as SnapshotCandidateRow[];
}

function shouldEvaluate(mint: string, reevalAfterSec: number): boolean {
  const last = evaluatedAtMap.get(mint) || 0;
  if (Date.now() - last < reevalAfterSec * 1000) return false;
  evaluatedAtMap.set(mint, Date.now());
  return true;
}

function buildSmartLotteryFeatures(row: SnapshotCandidateRow): SnapshotFeatures {
  return {
    price_usd: +Number(row.price_usd || 0).toFixed(8),
    liq_usd: +Number(row.liquidity_usd || 0).toFixed(0),
    pair_address: row.pair_address != null && String(row.pair_address).trim() ? String(row.pair_address) : null,
    vol5m_usd: +Number(row.volume_5m || 0).toFixed(0),
    vol1h_usd: +Number(row.volume_1h ?? 0).toFixed(0),
    buys5m: row.buys_5m,
    sells5m: row.sells_5m,
    buy_sell_ratio_5m: row.sells_5m > 0 ? +(row.buys_5m / row.sells_5m).toFixed(2) : null,
    holders: row.holder_count,
    token_age_min: +Number(row.token_age_min ?? 0).toFixed(1),
    dip_pct: null,
    impulse_pct: null,
    dip_lookback_min: null,
    market_cap_usd:
      row.market_cap_usd != null && Number(row.market_cap_usd) > 0
        ? +Number(row.market_cap_usd).toFixed(2)
        : null,
  };
}

async function warmupSnapshotHolderCounts(
  cfg: PaperTraderConfig,
  snapshotTagged: Array<{ row: SnapshotCandidateRow; lane: Lane }>,
): Promise<void> {
  const max = cfg.holdersSnapshotWarmupMax;
  if (!(max > 0)) return;

  const mints: string[] = [];
  const seen = new Set<string>();
  for (const { row } of snapshotTagged) {
    if ((row.holder_count ?? 0) > 0) continue;
    if (seen.has(row.mint)) continue;
    seen.add(row.mint);
    mints.push(row.mint);
    if (mints.length >= max) break;
  }
  if (mints.length === 0) return;

  const resolved = new Map<string, number>();
  for (const mint of mints) {
    const r = await resolveHolderCount(cfg, mint);
    if (r.ok) resolved.set(mint, r.count);
  }
  if (resolved.size === 0) return;

  for (const x of snapshotTagged) {
    const c = resolved.get(x.row.mint);
    if (c !== undefined) x.row.holder_count = c;
  }
}

export async function runSmartLotteryDiscovery(cfg: PaperTraderConfig): Promise<DiscoveryTickResult> {
  const [migRows, postRows] = await Promise.all([
    cfg.smlotEnableMigrationLane ? fetchSmartLotteryLaneCandidates(cfg, 'migration_event') : Promise.resolve([]),
    cfg.smlotEnablePostLane ? fetchSmartLotteryLaneCandidates(cfg, 'post_migration') : Promise.resolve([]),
  ]);
  const snapshotTagged: Array<{ row: SnapshotCandidateRow; lane: Lane }> = [
    ...migRows.map((row) => ({ row, lane: 'migration_event' as const })),
    ...postRows.map((row) => ({ row, lane: 'post_migration' as const })),
  ];
  if (snapshotTagged.length === 0) {
    return { discovered: 0, evaluated: 0, passed: 0, decisions: [] };
  }

  await warmupSnapshotHolderCounts(cfg, snapshotTagged);
  const reevalAfterSec = cfg.discoveryReevalSec;

  const decisions: EvalDecision[] = [];
  let evaluated = 0;
  let passed = 0;
  let liveHoldersThisTick = 0;
  const liveHoldersEnabled = cfg.holdersLiveEnabled && cfg.globalMinHolderCount > 0;

  for (const { row, lane } of snapshotTagged) {
    if (!shouldEvaluate(row.mint, reevalAfterSec)) continue;
    evaluated++;

    const v = evaluateSnapshotSmartLottery(cfg, row, lane);
    const globalReasons = globalGate(cfg, row.token_age_min, row.holder_count, {
      skipHolderCheck: liveHoldersEnabled,
    });
    const baseReasons = [...v.reasons, ...globalReasons];
    const snapshotPass = baseReasons.length === 0;

    let whale: WhaleAnalysis | null = null;
    const whaleReasons: string[] = [];
    if (snapshotPass && cfg.whaleEnabled) {
      whale = await fetchWhaleAnalysis(cfg, row.mint);
      if (whale.creator_dump_block) {
        whaleReasons.push(`creator_dumping_${(whale.creator_dumped_pct * 100).toFixed(0)}%`);
      }
      if (whale.dca_aggressive_present) whaleReasons.push('dca_aggressive_seller');
      if (cfg.whaleRequireTrigger && !whale.trigger_fired && !whaleReasons.length) {
        whaleReasons.push('no_whale_trigger');
      }
    }

    const cooldownMin =
      whale?.trigger_fired === 'dca_predictable' ? cfg.dipCooldownMinScalp : cfg.dipCooldownMinDefault;
    const lastEntry = lastEntryTsByMintMap.get(row.mint) || 0;
    const minutesSinceLast = (Date.now() - lastEntry) / 60_000;
    const cooldownReasons: string[] = [];
    if (lastEntry > 0 && minutesSinceLast < cooldownMin) {
      cooldownReasons.push(
        `cooldown_active_${cooldownMin}m_left_${(cooldownMin - minutesSinceLast).toFixed(0)}m`,
      );
    }

    const lossH = cfg.dipLossExitCooldownHours;
    if (Number(lossH) > 0) {
      const lastLossExit = lastLossExitTsByMintMap.get(row.mint) ?? 0;
      const resumeAt = lastLossExit + lossH * 3_600_000;
      if (lastLossExit > 0 && Date.now() < resumeAt) {
        const leftH = (resumeAt - Date.now()) / 3_600_000;
        cooldownReasons.push(`loss_exit_cooldown_${lossH}h_left_${leftH.toFixed(2)}h`);
      }
    }

    const preHoldersReasons = [...baseReasons, ...whaleReasons, ...cooldownReasons];
    const cheapPass = preHoldersReasons.length === 0;

    let holdersMeta: HoldersDecisionMeta | undefined;
    const holderReasons: string[] = [];

    if (liveHoldersEnabled && cheapPass) {
      const dbHolders = Number(row.holder_count ?? 0);
      if (liveHoldersThisTick >= cfg.holdersMaxPerTick) {
        holdersMeta = {
          holders_db: dbHolders,
          holders_live: null,
          holders_source: 'none',
          holders_age_ms: null,
          holders_fail_reason: 'budget_per_tick',
          holders_used_for_gate: dbHolders,
        };
        if (cfg.holdersOnFail === 'block') {
          holderReasons.push('holders_unknown:budget_per_tick');
        } else if (cfg.holdersOnFail === 'db_fallback') {
          if (dbHolders < cfg.globalMinHolderCount) {
            holderReasons.push(`holders<${cfg.globalMinHolderCount}:db_fallback`);
          }
        }
      } else {
        liveHoldersThisTick += 1;
        const r = await resolveHolderCount(cfg, row.mint);
        if (r.ok) {
          holdersMeta = {
            holders_db: dbHolders,
            holders_live: r.count,
            holders_source: r.source,
            holders_age_ms: r.ageMs,
            holders_used_for_gate: r.count,
          };
          if (r.count < cfg.globalMinHolderCount) {
            holderReasons.push(`holders<${cfg.globalMinHolderCount}`);
          }
        } else {
          holdersMeta = {
            holders_db: dbHolders,
            holders_live: null,
            holders_source: 'none',
            holders_age_ms: null,
            holders_fail_reason: r.reason,
            holders_used_for_gate: dbHolders,
          };
          if (cfg.holdersOnFail === 'block') {
            holderReasons.push(`holders_unknown:${r.reason}`);
          } else if (cfg.holdersOnFail === 'db_fallback') {
            holdersMeta.holders_source = 'db';
            if (dbHolders < cfg.globalMinHolderCount) {
              holderReasons.push(`holders<${cfg.globalMinHolderCount}:db_fallback`);
            }
          }
        }
      }
    }

    const preIntelReasons = [...preHoldersReasons, ...holderReasons];
    const intelReasons: string[] = [];
    if (preIntelReasons.length === 0) {
      const ig = await evaluateSmartLotteryIntelGate(row.mint, cfg);
      if (!ig.ok) intelReasons.push(...ig.reasons);
    }

    const mergedReasons = [...preIntelReasons, ...intelReasons];
    const pass = mergedReasons.length === 0;
    if (pass) passed++;

    decisions.push({
      lane,
      source: row.source,
      mint: row.mint,
      symbol: row.symbol,
      ageMin: +Number(row.age_min ?? 0).toFixed(1),
      pass,
      reasons: mergedReasons,
      features: buildSmartLotteryFeatures(row),
      whale,
      holdersMeta,
    });
  }

  return { discovered: snapshotTagged.length, evaluated, passed, decisions };
}
