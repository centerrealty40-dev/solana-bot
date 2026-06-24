/**
 * PG-native pullback scan for Preset C (reuses bar geometry from market-pullback-telegram-watch).
 */
import { sql as dsql } from 'drizzle-orm';

import { db } from '../core/db/client.js';
import {
  detectLocalHighRetraceFromBars,
  type Bar,
  type PullbackPick,
} from '../scripts/market-pullback-telegram-watch.js';
import {
  isMatureTokenMicroValleyArtifact,
  isRetraceContradictedByLatestSnapshot,
} from '../scripts/market-retrace-sanity.js';
import { isTelegramMarketAlertMintBlocked } from '../scripts/telegram-alert-mint-blacklist.js';
import {
  PRESET_C_MAX_MCAP_USD,
  PRESET_C_MIN_MCAP_USD,
  PRESET_C_MIN_RETRACE_PCT,
  PRESET_C_MAX_RETRACE_PCT,
  passesPresetCMcapBand,
  passesPresetCRetraceBand,
} from './filters.js';

const SNAPSHOT_TABLES = [
  'raydium_pair_snapshots',
  'meteora_pair_snapshots',
  'orca_pair_snapshots',
  'moonshot_pair_snapshots',
  'pumpswap_pair_snapshots',
] as const;

type DexTable = (typeof SNAPSHOT_TABLES)[number];

const ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,64}$/;

export type PresetCPullbackCandidate = {
  dex: string;
  mint: string;
  pair: string;
  symbol: string;
  tokenAgeMin: number;
  holderCount: number | null;
  liqUsd: number;
  refMcapUsd: number;
  priceUsd: number;
  pick: PullbackPick;
  /** preset_c_spike when sourced from spike-channel dedupe */
  entryPath?: 'preset_c_pullback' | 'preset_c_spike';
};

function envNum(name: string, fallback: number): number {
  const v = process.env[name]?.trim();
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

const SCAN_MINUTES = Math.max(
  15,
  Math.min(1440, Math.floor(envNum('PRESET_C_DISCOVERY_SCAN_MINUTES', 360))),
);
const LATEST_FLOOR_SEC = Math.max(600, Math.min(3600, SCAN_MINUTES * 60 + 300));
const MIN_HOLDERS = Math.max(0, envNum('PRESET_C_DISCOVERY_MIN_HOLDERS', 1000));
const HOLDER_NULL_SOFT = (process.env.PRESET_C_DISCOVERY_HOLDER_NULL_SOFT ?? '1').trim() !== '0';
const MIN_AGE_HOURS = Math.max(0, envNum('PRESET_C_DISCOVERY_MIN_AGE_HOURS', 8));
const MIN_LIQ_USD = Math.max(0, envNum('PRESET_C_DISCOVERY_MIN_LIQ_USD', 0));
const MIN_VOL_5M_USD = Math.max(0, envNum('PRESET_C_DISCOVERY_MIN_VOL_5M_USD', 0));
const MAX_ROWS = Math.max(50, Math.min(5000, envNum('PRESET_C_DISCOVERY_MAX_ROWS_PER_TABLE', 800)));
const MAX_NEWER_BAR_AGE_MIN = Math.max(
  1,
  Math.min(180, Math.floor(envNum('PRESET_C_DISCOVERY_MAX_NEWER_BAR_AGE_MINUTES', 25))),
);

type LatestMeta = {
  base_mint: string;
  pair_address: string;
  px_now: number;
  ts_now: Date | string;
  symbol: string | null;
  token_name: string | null;
  holder_count: number | null;
  liq_usd: number | null;
  token_fdv_usd: number | null;
  token_age_min: number | null;
};

function sqlMintPairInTuples(rows: LatestMeta[]): string | null {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const r of rows) {
    const mint = r.base_mint.trim();
    const pair = r.pair_address.trim();
    if (!ADDR_RE.test(mint) || !ADDR_RE.test(pair)) continue;
    const key = `${mint}|${pair}`;
    if (seen.has(key)) continue;
    seen.add(key);
    parts.push(`('${mint.replace(/'/g, "''")}', '${pair.replace(/'/g, "''")}')`);
  }
  if (!parts.length) return null;
  return parts.join(', ');
}

function buildLatestOnlyQuery(table: DexTable): string {
  const liqClause = MIN_LIQ_USD > 0 ? `AND COALESCE(s.liquidity_usd, 0) >= ${MIN_LIQ_USD}` : '';
  const volClause = MIN_VOL_5M_USD > 0 ? `AND COALESCE(s.volume_5m, 0) >= ${MIN_VOL_5M_USD}` : '';
  const mcapClause = `AND (
      COALESCE(s.market_cap_usd, s.fdv_usd, t.fdv_usd, 0) = 0
      OR (
        COALESCE(s.market_cap_usd, s.fdv_usd, t.fdv_usd, 0) >= ${PRESET_C_MIN_MCAP_USD}
        AND COALESCE(s.market_cap_usd, s.fdv_usd, t.fdv_usd, 0) <= ${PRESET_C_MAX_MCAP_USD}
      )
    )`;
  const holdersClause = HOLDER_NULL_SOFT
    ? `AND (t.holder_count IS NULL OR t.holder_count >= ${MIN_HOLDERS})`
    : `AND COALESCE(t.holder_count, 0) >= ${MIN_HOLDERS}`;
  const snapshotFilters = `
    AND s.ts > now() - (${LATEST_FLOOR_SEC} * interval '1 second')
    AND COALESCE(s.price_usd, 0) > 0
    ${holdersClause}
    AND (
      (s.launch_ts IS NOT NULL AND s.launch_ts <= now() - interval '${MIN_AGE_HOURS} hours')
      OR (s.launch_ts IS NULL AND t.first_seen_at <= now() - interval '${MIN_AGE_HOURS} hours')
    )
    ${liqClause}
    ${volClause}
    ${mcapClause}`;
  return `
WITH top_mints AS (
  SELECT s.base_mint
  FROM ${table} s
  INNER JOIN tokens t ON t.mint = s.base_mint
  WHERE true
    ${snapshotFilters}
  GROUP BY s.base_mint
  ORDER BY MAX(s.ts) DESC, s.base_mint ASC
  LIMIT ${MAX_ROWS}
),
latest AS (
  SELECT DISTINCT ON (s.base_mint, s.pair_address)
    s.base_mint,
    s.pair_address,
    s.price_usd AS px_now,
    s.ts AS ts_now,
    s.liquidity_usd AS liq_usd,
    EXTRACT(EPOCH FROM (now() - COALESCE(s.launch_ts, t.first_seen_at))) / 60.0 AS token_age_min
  FROM ${table} s
  INNER JOIN tokens t ON t.mint = s.base_mint
  INNER JOIN top_mints m ON m.base_mint = s.base_mint
  WHERE true
    ${snapshotFilters}
  ORDER BY s.base_mint, s.pair_address, s.ts DESC
)
SELECT
  l.base_mint,
  l.pair_address,
  l.px_now::double precision AS px_now,
  l.ts_now,
  t.symbol,
  t.name AS token_name,
  t.holder_count,
  l.liq_usd::double precision AS liq_usd,
  t.fdv_usd::double precision AS token_fdv_usd,
  l.token_age_min::double precision AS token_age_min
FROM latest l
INNER JOIN tokens t ON t.mint = l.base_mint`;
}

function buildBarsQuery(table: DexTable, mintPairTuplesSql: string): string {
  return `
SELECT
  s.base_mint,
  s.pair_address,
  s.ts,
  s.price_usd::double precision AS price_usd,
  COALESCE(s.market_cap_usd, s.fdv_usd)::double precision AS market_cap_usd
FROM ${table} s
WHERE (s.base_mint, s.pair_address) IN (${mintPairTuplesSql})
  AND s.ts > now() - (${SCAN_MINUTES} * interval '1 minute')
  AND COALESCE(s.price_usd, 0) > 0
ORDER BY s.base_mint, s.pair_address, s.ts ASC`;
}

function parseTs(v: Date | string): Date {
  return v instanceof Date ? v : new Date(v);
}

function parseMcapUsd(row: Record<string, unknown>): number | null {
  const m = Number(row.market_cap_usd);
  return Number.isFinite(m) && m > 0 ? m : null;
}

function barsMapKey(mint: string, pair: string): string {
  return `${mint}|${pair}`;
}

function refMcapUsd(meta: LatestMeta, lastBarMcap: number | null): number {
  const fromBar = lastBarMcap != null && lastBarMcap > 0 ? lastBarMcap : 0;
  const fdv = meta.token_fdv_usd != null && meta.token_fdv_usd > 0 ? meta.token_fdv_usd : 0;
  return Math.max(fromBar, fdv);
}

function enrichPullbackPickMcap(pick: PullbackPick, bars: Bar[]): PullbackPick {
  const findMcap = (ts: Date): number | null => {
    const t = ts.getTime();
    let best: number | null = null;
    let bestDt = Infinity;
    for (const b of bars) {
      const dt = Math.abs(b.ts.getTime() - t);
      if (dt < bestDt && b.mcapUsd != null && b.mcapUsd > 0) {
        bestDt = dt;
        best = b.mcapUsd;
      }
    }
    return best;
  };
  return {
    ...pick,
    anchorMcapUsd: findMcap(pick.anchorTs),
    peakMcapUsd: findMcap(pick.peakTs),
    lastMcapUsd: findMcap(pick.lastTs),
  };
}

function isPullbackPickDataGlitch(pick: PullbackPick, meta: LatestMeta, refM: number): boolean {
  if (
    isMatureTokenMicroValleyArtifact(
      pick.anchorMcapUsd ?? null,
      pick.peakMcapUsd ?? null,
      refM,
      pick.risePct,
    )
  ) {
    return true;
  }
  if (
    isRetraceContradictedByLatestSnapshot(
      pick.peakPx,
      pick.lastPx,
      meta.px_now,
      pick.retraceFromPeakPct,
    )
  ) {
    return true;
  }
  return false;
}

/**
 * Scan PG pair snapshots for Preset C pullback candidates (pullback only, no Telegram).
 * Does not mutate global state; safe to call from discovery tick.
 */
export async function evaluatePresetCCandidates(): Promise<PresetCPullbackCandidate[]> {
  const nowMs = Date.now();
  const maxBarAgeMs = MAX_NEWER_BAR_AGE_MIN * 60_000;
  const byMint = new Map<string, PresetCPullbackCandidate>();

  for (const table of SNAPSHOT_TABLES) {
    let latest: LatestMeta[];
    try {
      const r = await db.execute(dsql.raw(buildLatestOnlyQuery(table)));
      latest = (r as unknown as Record<string, unknown>[]).map((row) => ({
        base_mint: String(row.base_mint ?? ''),
        pair_address: String(row.pair_address ?? ''),
        px_now: Number(row.px_now),
        ts_now: row.ts_now as Date | string,
        symbol: row.symbol != null ? String(row.symbol) : null,
        token_name: row.token_name != null ? String(row.token_name) : null,
        holder_count: row.holder_count != null ? Number(row.holder_count) : null,
        liq_usd: row.liq_usd != null ? Number(row.liq_usd) : null,
        token_fdv_usd:
          row.token_fdv_usd != null && Number.isFinite(Number(row.token_fdv_usd))
            ? Number(row.token_fdv_usd)
            : null,
        token_age_min:
          row.token_age_min != null && Number.isFinite(Number(row.token_age_min))
            ? Number(row.token_age_min)
            : null,
      }));
    } catch {
      continue;
    }

    const barsMap = await (async () => {
      const tupleSql = sqlMintPairInTuples(latest);
      if (!tupleSql) return new Map<string, Bar[]>();
      const r = await db.execute(dsql.raw(buildBarsQuery(table, tupleSql)));
      const map = new Map<string, Bar[]>();
      for (const row of r as unknown as Record<string, unknown>[]) {
        const mint = String(row.base_mint ?? '');
        const pair = String(row.pair_address ?? '');
        const px = Number(row.price_usd);
        if (!mint || !pair || !(px > 0)) continue;
        const key = barsMapKey(mint, pair);
        const arr = map.get(key) ?? [];
        arr.push({ ts: parseTs(row.ts as Date | string), px, mcapUsd: parseMcapUsd(row) });
        map.set(key, arr);
      }
      return map;
    })();

    for (const meta of latest) {
      const mint = meta.base_mint.trim();
      if (!ADDR_RE.test(mint)) continue;
      if (isTelegramMarketAlertMintBlocked(mint)) continue;

      const key = barsMapKey(mint, meta.pair_address.trim());
      const bars = barsMap.get(key);
      if (!bars || bars.length < 2) continue;

      const lastBar = bars[bars.length - 1]!;
      if (nowMs - lastBar.ts.getTime() > maxBarAgeMs) continue;

      const rawPick = detectLocalHighRetraceFromBars(bars, PRESET_C_MIN_RETRACE_PCT);
      if (!rawPick) continue;
      if (rawPick.retraceFromPeakPct > PRESET_C_MAX_RETRACE_PCT + 1e-6) continue;

      const pick = enrichPullbackPickMcap(rawPick, bars);
      const refM = refMcapUsd(meta, pick.lastMcapUsd ?? null);
      if (!passesPresetCMcapBand(refM)) continue;
      if (!passesPresetCRetraceBand(pick.retraceFromPeakPct)) continue;
      if (isPullbackPickDataGlitch(pick, meta, refM)) continue;

      const dex = table.replace('_pair_snapshots', '');
      const prev = byMint.get(mint);
      const liq = meta.liq_usd ?? 0;
      if (prev && (prev.liqUsd ?? 0) >= liq) continue;

      byMint.set(mint, {
        dex,
        mint,
        pair: meta.pair_address.trim(),
        symbol: meta.symbol?.trim() || meta.token_name?.trim() || mint.slice(0, 8),
        tokenAgeMin: meta.token_age_min ?? 0,
        holderCount: meta.holder_count,
        liqUsd: liq,
        refMcapUsd: refM,
        priceUsd: meta.px_now,
        pick,
      });
    }
  }

  return [...byMint.values()];
}
