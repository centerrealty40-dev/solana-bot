import { sql as dsql } from 'drizzle-orm';
import { db } from '../../core/db/client.js';
import type { PaperTraderConfig } from '../config.js';
import type { Lane, SnapshotCandidateRow } from '../types.js';
import { laneCfg } from '../filters/snapshot-filter.js';
import { isLiveOscarScalpWaveLaneEnabled } from '../live-oscar-scalp-wave.js';
import { isRunnerProbeLaneEnabled } from '../live-oscar-runner-probe.js';
import { isRunnerLiteLaneEnabled } from '../live-oscar-runner-lite.js';
import {
  CANONICAL_SNAPSHOT_ROW_ORDER_SQL,
} from './snapshot-canonical-pick.js';
import {
  buildDiscoverySnapshotSanitySqlClause,
  discoverySnapshotSanityCfg,
  pickCanonicalSnapshotRowsByMint,
} from './snapshot-row-sanity.js';

export {
  pickCanonicalSnapshotRow,
  dedupeSnapshotTaggedByMintCanonical,
  CANONICAL_SNAPSHOT_ROW_ORDER_SQL,
  CANONICAL_VOLUME_ROW_ORDER_SQL,
} from './snapshot-canonical-pick.js';

function sqlQuoteMint(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

const SNAPSHOT_TABLES: Array<{ table: string; source: string }> = [
  { table: 'raydium_pair_snapshots', source: 'raydium' },
  { table: 'meteora_pair_snapshots', source: 'meteora' },
  { table: 'orca_pair_snapshots', source: 'orca' },
  { table: 'moonshot_pair_snapshots', source: 'moonshot' },
  { table: 'pumpswap_pair_snapshots', source: 'pumpswap' },
];

export async function fetchSnapshotLaneCandidates(
  cfg: PaperTraderConfig,
  lane: Lane,
): Promise<SnapshotCandidateRow[]> {
  const lc = laneCfg(cfg, lane);
  /** When scalp_wave, runner_probe, or runner_lite is on, widen SQL universe to lane min age while prod keeps 36h in eval gates. */
  const laneMinAgeCandidates = [
    lane === 'post_migration' && isLiveOscarScalpWaveLaneEnabled(cfg)
      ? cfg.liveOscarScalpWaveMinAgeMin
      : null,
    lane === 'post_migration' && isRunnerProbeLaneEnabled(cfg) ? cfg.runnerProbeMinAgeMin : null,
    lane === 'post_migration' && isRunnerLiteLaneEnabled(cfg) ? cfg.runnerLiteMinAgeMin : null,
  ].filter((v): v is number => v != null && v >= 0);
  const sqlMinAgeMin =
    laneMinAgeCandidates.length > 0
      ? Math.min(lc.MIN_AGE_MIN, ...laneMinAgeCandidates)
      : lc.MIN_AGE_MIN;
  /** Pool/token age anchor: pair launch when collectors filled `launch_ts` (DexScreener `pairCreatedAt`, etc.), else first time we saw the mint in `tokens`. */
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
  const maxVol5mFilter = lc.MAX_VOL_5M_USD > 0 ? `AND volume_5m <= ${lc.MAX_VOL_5M_USD}` : '';
  /** `market_cap_usd` in raw already COALESCE(mcap, fdv) from pair row — do not reference `fdv_usd` here. */
  const minMcapFilter =
    cfg.discoveryMinMarketCapUsd > 0
      ? `AND COALESCE(market_cap_usd, 0) >= ${cfg.discoveryMinMarketCapUsd}`
      : '';
  const maxMcapFilter =
    cfg.discoveryMaxMarketCapUsd > 0
      ? `AND COALESCE(market_cap_usd, 0) <= ${cfg.discoveryMaxMarketCapUsd}`
      : '';
  const sanitySql = buildDiscoverySnapshotSanitySqlClause(cfg);

  const r = await db.execute(dsql.raw(`
    WITH raw AS (
      ${unions}
    ),
    with_max AS (
      SELECT *,
             MAX(liquidity_usd) OVER (PARTITION BY mint) AS mint_max_liq
      FROM raw
    ),
    eligible AS (
      SELECT mint, symbol, holder_count, token_age_min, ts, launch_ts, age_min,
             price_usd, liquidity_usd, volume_5m, volume_1h, buys_5m, sells_5m,
             market_cap_usd, pair_address, source
      FROM with_max
      WHERE COALESCE(age_min, 0) >= ${sqlMinAgeMin}
        ${maxAgeFilter}
        AND liquidity_usd >= ${lc.MIN_LIQ_USD}
        ${maxLiqFilter}
        AND volume_5m >= ${lc.MIN_VOL_5M_USD}
        ${maxVol5mFilter}
        AND buys_5m >= ${lc.MIN_BUYS_5M}
        AND sells_5m >= ${lc.MIN_SELLS_5M}
        ${minMcapFilter}
        ${maxMcapFilter}
        ${sanitySql}
    ),
    ranked AS (
      SELECT *,
             ROW_NUMBER() OVER (
               PARTITION BY mint
               ORDER BY ${CANONICAL_SNAPSHOT_ROW_ORDER_SQL}
             ) AS rn
      FROM eligible
    )
    SELECT *
    FROM ranked
    WHERE rn = 1
    ORDER BY ${CANONICAL_SNAPSHOT_ROW_ORDER_SQL}
    LIMIT ${cfg.snapshotCandidateLimit}
  `));
  return r as unknown as SnapshotCandidateRow[];
}

function mapSnapshotRow(row: Record<string, unknown>, source: string): SnapshotCandidateRow {
  return {
    mint: String(row.mint ?? ''),
    symbol: String(row.symbol ?? '?'),
    holder_count: Number(row.holder_count ?? 0),
    token_age_min: Number(row.token_age_min ?? 0),
    ts: row.ts as Date | string,
    launch_ts: (row.launch_ts as Date | string | null) ?? null,
    age_min: row.age_min != null ? Number(row.age_min) : null,
    price_usd: Number(row.price_usd ?? 0),
    liquidity_usd: Number(row.liquidity_usd ?? 0),
    volume_5m: Number(row.volume_5m ?? 0),
    volume_1h: Number(row.volume_1h ?? 0),
    buys_5m: Number(row.buys_5m ?? 0),
    sells_5m: Number(row.sells_5m ?? 0),
    market_cap_usd: row.market_cap_usd != null ? Number(row.market_cap_usd) : null,
    pair_address: row.pair_address != null ? String(row.pair_address) : null,
    source,
  };
}

/**
 * Latest snapshot row for a mint across all collector tables (last N minutes, price > 0).
 * Канонический пул = max `liquidity_usd` среди свежих пар всех DEX (не «самый новый ts» на мёртвом пуле).
 */
/**
 * Volume-leader snapshot SQL age floor — separate from prod global/dip/post gates (48h).
 * Rollback: raise `PAPER_VOLUME_LEADER_MIN_TOKEN_AGE_MIN` toward 2880.
 */
export function resolveVolumeLeaderMinTokenAgeMin(cfg: PaperTraderConfig): number {
  return Math.max(0, cfg.volumeLeaderMinTokenAgeMin);
}

export async function fetchLatestCrossVenueSnapshotRowForMint(
  mint: string,
  opts?: { lookbackMinutes?: number; canonicalByVolume?: boolean },
): Promise<SnapshotCandidateRow | null> {
  const m = mint.trim();
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,48}$/.test(m)) return null;
  const map = await fetchCrossVenueSnapshotRowsByVolumeCanonical(
    { volumeLeaderSnapshotLookbackMin: opts?.lookbackMinutes ?? 30 } as PaperTraderConfig,
    [m],
    { canonicalByVolume: opts?.canonicalByVolume === true, lookbackMinutes: opts?.lookbackMinutes },
  );
  return map.get(m) ?? null;
}

/**
 * Batch: latest row per mint across venues. Volume tier uses max volume_1h pair; default max liq.
 */
export async function fetchCrossVenueSnapshotRowsByVolumeCanonical(
  cfg: PaperTraderConfig,
  mints: readonly string[],
  opts?: { canonicalByVolume?: boolean; lookbackMinutes?: number },
): Promise<Map<string, SnapshotCandidateRow>> {
  const out = new Map<string, SnapshotCandidateRow>();
  const valid = mints
    .map((m) => m.trim())
    .filter((m) => /^[1-9A-HJ-NP-Za-km-z]{32,48}$/.test(m));
  if (valid.length === 0) return out;

  const lookbackMin =
    opts?.lookbackMinutes != null && Number.isFinite(opts.lookbackMinutes) && opts.lookbackMinutes > 0
      ? Math.floor(opts.lookbackMinutes)
      : Math.max(5, Math.min(240, cfg.volumeLeaderSnapshotLookbackMin ?? 30));

  const minTokenAgeMin = resolveVolumeLeaderMinTokenAgeMin(cfg);
  const minTokenAgeSql =
    minTokenAgeMin > 0
      ? `AND EXTRACT(EPOCH FROM (now() - COALESCE(p.launch_ts, tok.first_seen_at, p.ts))) / 60.0 >= ${minTokenAgeMin}`
      : '';

  const mintList = valid.map((m) => sqlQuoteMint(m)).join(', ');

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
    WHERE p.base_mint IN (${mintList})
      AND p.ts >= now() - interval '${lookbackMin} minutes'
      AND COALESCE(p.price_usd, 0) > 0
      ${minTokenAgeSql}
  `,
  ).join('\nUNION ALL\n');

  const r = await db.execute(dsql.raw(`
    WITH raw AS (
      ${unions}
    ),
    latest_per_pair AS (
      SELECT mint, symbol, holder_count, token_age_min, ts, launch_ts, age_min,
             price_usd, liquidity_usd, volume_5m, volume_1h, buys_5m, sells_5m,
             market_cap_usd, pair_address, source,
             ROW_NUMBER() OVER (PARTITION BY mint, pair_address ORDER BY ts DESC) AS rn
      FROM raw
    )
    SELECT mint, symbol, holder_count, token_age_min, ts, launch_ts, age_min,
           price_usd, liquidity_usd, volume_5m, volume_1h, buys_5m, sells_5m,
           market_cap_usd, pair_address, source
    FROM latest_per_pair
    WHERE rn = 1
  `));
  const rows = r as unknown as Record<string, unknown>[];
  if (!Array.isArray(rows)) return out;
  const mapped: SnapshotCandidateRow[] = [];
  for (const row of rows) {
    const mint = String(row.mint ?? '');
    if (!mint) continue;
    mapped.push(mapSnapshotRow(row, String(row.source ?? '?')));
  }
  const sanity = discoverySnapshotSanityCfg(cfg);
  const picked = pickCanonicalSnapshotRowsByMint(mapped, sanity, {
    canonicalByVolume: opts?.canonicalByVolume === true,
  });
  for (const [mint, row] of picked) out.set(mint, row);
  return out;
}
