/**
 * Watch-only (второй Telegram-канал): отдельный бот (`PULLBACK_ALERT_TELEGRAM_*`), не spike-watch, не Live Oscar.
 *
 * Режимы (`PULLBACK_ALERT_SIGNAL_MODE`):
 * - **`local_high_retrace`** (рекомендуется для «после локального хая»): в окне `PULLBACK_ALERT_SCAN_MINUTES`
 *   ищем **последний пик ноги** (max `price_usd` на [пик..последний бар], правый хвост плато), затем откат к последнему бару;
 *   алерт при откате ≥ `PULLBACK_ALERT_MIN_RETRACE_FROM_PEAK_PCT` **без** требования предварительного роста
 *   от якоря (никаких «оценок за 10 минут» в смысле spike rolling — только PG-бары в lookback).
 * - **`rise_then_retrace`**: прежняя логика — рост якорь→пик ≥ `PULLBACK_ALERT_MIN_RISE_PCT` и откат от пика.
 *
 * Env: см. `ecosystem.market-pullback-watch.cjs`. Секреты только в `.env` на хосте.
 *
 * Тесты: `detectRiseThenRetraceFromBars`, `detectLocalHighRetraceFromBars`; автозапуск main подавляется `PULLBACK_ALERT_SKIP_MAIN=1`.
 */
import 'dotenv/config';
import { sql as dsql } from 'drizzle-orm';

import { db } from '../core/db/client.js';
import {
  retracePullbackChannelEventKey,
  reserveRetracePullbackChannelSlot,
} from './market-retrace-pullback-channel-dedupe.js';
import { wasMarketFastAlertRecent } from './market-fast-alert-shared-dedupe.js';
import {
  buildMintCanonicalPoolMap,
  groupCanonicalRowsByTable,
} from './market-snapshot-canonical-pool.js';
import { buildDipsCompactAlertHtml } from './market-dips-compact-telegram-format.js';
import {
  isMatureTokenMicroValleyArtifact,
  isRetraceContradictedByLatestSnapshot,
} from './market-retrace-sanity.js';

const SNAPSHOT_TABLES = [
  'raydium_pair_snapshots',
  'meteora_pair_snapshots',
  'orca_pair_snapshots',
  'moonshot_pair_snapshots',
  'pumpswap_pair_snapshots',
] as const;

type DexTable = (typeof SNAPSHOT_TABLES)[number];

function envNum(name: string, fallback: number): number {
  const v = process.env[name]?.trim();
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function envBool(name: string, fallback: boolean): boolean {
  const v = process.env[name]?.trim().toLowerCase();
  if (!v) return fallback;
  return v === '1' || v === 'true' || v === 'yes';
}

const SIGNAL_MODE_RAW = (process.env.PULLBACK_ALERT_SIGNAL_MODE ?? 'rise_then_retrace').trim().toLowerCase();
const SIGNAL_MODE: 'rise_then_retrace' | 'local_high_retrace' =
  SIGNAL_MODE_RAW === 'local_high' || SIGNAL_MODE_RAW === 'local_high_retrace'
    ? 'local_high_retrace'
    : 'rise_then_retrace';

const SCAN_MINUTES_CAP = SIGNAL_MODE === 'local_high_retrace' ? 1440 : 180;
const SCAN_MINUTES = Math.max(
  15,
  Math.min(SCAN_MINUTES_CAP, Math.floor(envNum('PULLBACK_ALERT_SCAN_MINUTES', SIGNAL_MODE === 'local_high_retrace' ? 360 : 90))),
);

const LATEST_FLOOR_SEC = Math.max(
  600,
  Math.min(3600, Math.max(900, SCAN_MINUTES * 60 + 300)),
);

const MIN_RISE_PCT = Math.max(0.5, Math.min(200, envNum('PULLBACK_ALERT_MIN_RISE_PCT', 6)));
const MIN_RETRACE_PCT = Math.max(0.5, Math.min(99, envNum('PULLBACK_ALERT_MIN_RETRACE_FROM_PEAK_PCT', 10)));

const MIN_HOLDERS = Math.max(0, envNum('PULLBACK_ALERT_MIN_HOLDERS', 1000));
const HOLDER_NULL_SOFT = envBool('PULLBACK_ALERT_HOLDER_NULL_SOFT', true);
const MIN_AGE_HOURS = Math.max(0, envNum('PULLBACK_ALERT_MIN_AGE_HOURS', 8));
const MIN_LIQ_USD = Math.max(0, envNum('PULLBACK_ALERT_MIN_LIQ_USD', 0));
const MIN_VOL_5M_USD = Math.max(0, envNum('PULLBACK_ALERT_MIN_VOL_5M_USD', 0));
const MIN_MARKET_CAP_USD = Math.max(0, envNum('PULLBACK_ALERT_MIN_MARKET_CAP_USD', 1_000_000));
const MAX_ROWS = Math.max(50, Math.min(5000, envNum('PULLBACK_ALERT_MAX_ROWS_PER_TABLE', 800)));
const DRY_RUN = envBool('PULLBACK_ALERT_DRY_RUN', false);

/** Детекция только на пуле с max liq — не dead meteora vs pumpswap. */
const CANONICAL_POOL_BY_MAX_LIQ = envBool('PULLBACK_ALERT_CANONICAL_POOL_BY_MAX_LIQ', true);

const POLL_INTERVAL_MS_RAW = Math.floor(envNum('PULLBACK_ALERT_POLL_INTERVAL_MS', 20_000));
const POLL_INTERVAL_MS =
  POLL_INTERVAL_MS_RAW <= 0 ? 0 : Math.max(5000, Math.min(600_000, POLL_INTERVAL_MS_RAW));
const POLL_SEND_DEDUPE_MS = Math.max(
  0,
  Math.min(3_600_000, Math.floor(envNum('PULLBACK_ALERT_POLL_SEND_DEDUPE_MS', 120_000))),
);

/** Уже слали откат с этого пика по mint (любая пара DEX) — не дублировать при углублении. */
export function isDuplicateOngoingPullback(
  lastSentPeakMs: number | undefined,
  peakTs: Date,
): boolean {
  if (lastSentPeakMs == null) return false;
  return lastSentPeakMs === peakTs.getTime();
}

export function pullbackAlertEventDedupeKey(mint: string, peakTs: Date): string {
  return retracePullbackChannelEventKey(mint, peakTs);
}

const MAX_NEWER_BAR_AGE_MIN = Math.max(
  1,
  Math.min(180, Math.floor(envNum('PULLBACK_ALERT_MAX_NEWER_BAR_AGE_MINUTES', 25))),
);

const DISPLAY_TZ = process.env.PULLBACK_ALERT_DISPLAY_TZ?.trim() || 'Europe/Moscow';

const TG_TOKEN = process.env.PULLBACK_ALERT_TELEGRAM_BOT_TOKEN?.trim() ?? '';
const TG_CHAT = process.env.PULLBACK_ALERT_TELEGRAM_CHAT_ID?.trim() ?? '';

function dexLabel(table: DexTable): string {
  return table.replace('_pair_snapshots', '');
}

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
};

export type Bar = { ts: Date; px: number; mcapUsd: number | null };

export type PullbackPick = {
  signalMode: 'rise_then_retrace' | 'local_high_retrace';
  risePct: number;
  retraceFromPeakPct: number;
  anchorPx: number;
  peakPx: number;
  lastPx: number;
  anchorTs: Date;
  peakTs: Date;
  lastTs: Date;
  /** Заполняется в `enrichPullbackPickMcap` из баров PG. */
  anchorMcapUsd?: number | null;
  peakMcapUsd?: number | null;
  lastMcapUsd?: number | null;
};

const ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,64}$/;

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
  const liqClause =
    MIN_LIQ_USD > 0 ? `AND COALESCE(s.liquidity_usd, 0) >= ${MIN_LIQ_USD}` : '';
  const volClause =
    MIN_VOL_5M_USD > 0 ? `AND COALESCE(s.volume_5m, 0) >= ${MIN_VOL_5M_USD}` : '';
  const mcapClause =
    MIN_MARKET_CAP_USD > 0
      ? `AND COALESCE(s.market_cap_usd, s.fdv_usd, t.fdv_usd, 0) >= ${MIN_MARKET_CAP_USD}`
      : '';
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
    s.liquidity_usd AS liq_usd
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
  t.fdv_usd::double precision AS token_fdv_usd
FROM latest l
INNER JOIN tokens t ON t.mint = l.base_mint`;
}

function buildBarsQuery(table: DexTable, mintPairTuplesSql: string): string {
  return `
SELECT base_mint::text, pair_address::text, ts, price_usd::double precision AS price_usd,
  COALESCE(market_cap_usd, fdv_usd)::double precision AS mcap_usd
FROM ${table}
WHERE (base_mint, pair_address) IN (${mintPairTuplesSql})
  AND ts > now() - (${SCAN_MINUTES} * interval '1 minute')
  AND COALESCE(price_usd, 0) > 0
ORDER BY base_mint ASC, pair_address ASC, ts ASC`;
}

function barsMapKey(mint: string, pair: string): string {
  return `${mint}|${pair}`;
}

function parseTs(v: Date | string): Date {
  if (v instanceof Date) return v;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? new Date(0) : d;
}

function dedupeBarsSorted(rows: Bar[]): Bar[] {
  const byMs = new Map<number, Bar>();
  for (const r of rows) {
    const ms = r.ts.getTime();
    byMs.set(ms, r);
  }
  return [...byMs.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, b]) => b);
}

function enrichPullbackPickMcap(pick: PullbackPick, rawBars: Bar[]): PullbackPick {
  const b = dedupeBarsSorted(rawBars);
  const mAt = (d: Date) => b.find((x) => x.ts.getTime() === d.getTime())?.mcapUsd ?? null;
  return {
    ...pick,
    anchorMcapUsd: mAt(pick.anchorTs),
    peakMcapUsd: mAt(pick.peakTs),
    lastMcapUsd: mAt(pick.lastTs),
  };
}

function parseMcapUsd(row: Record<string, unknown>): number | null {
  const v = row.mcap_usd;
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function epsPx(px: number): number {
  return Math.max(1e-12, Math.abs(px) * 1e-12);
}

/** Пик j — максимум на отрезке [j..k] (текущая нога), не глобальный max за всё окно. */
function isPeakOnTailSegment(b: Bar[], j: number, k: number): boolean {
  const peakPx = b[j].px;
  const eps = epsPx(peakPx);
  for (let t = j; t <= k; t++) {
    if (b[t].px > peakPx + eps) return false;
  }
  return true;
}

function rightmostPeakIdxOnTail(b: Bar[], j: number, k: number): number {
  const peakPx = b[j].px;
  const eps = epsPx(peakPx);
  let peakIdx = j;
  for (let t = j; t <= k; t++) {
    if (Math.abs(b[t].px - peakPx) <= eps) peakIdx = t;
  }
  return peakIdx;
}

/**
 * Последний (правый) пик перед последним баром: max на [j..k], откат j→k.
 * minRisePct = null — без порога роста (local_high_retrace).
 */
function detectLatestLegRetraceFromBars(
  bars: Bar[],
  minRetraceFromPeakPct: number,
  minRisePct: number | null,
  signalMode: PullbackPick['signalMode'],
): PullbackPick | null {
  const b = dedupeBarsSorted(bars);
  const n = b.length;
  if (n < 2) return null;

  const k = n - 1;
  const last = b[k];
  const lastPx = last.px;
  const lastTs = last.ts;
  if (!(lastPx > 0)) return null;

  for (let j = k - 1; j >= 0; j--) {
    if (!isPeakOnTailSegment(b, j, k)) continue;

    const peakIdx = rightmostPeakIdxOnTail(b, j, k);
    const peakPx = b[peakIdx].px;
    if (!(peakPx > lastPx)) continue;

    const retraceFromPeakPct = ((peakPx - lastPx) / peakPx) * 100;
    if (retraceFromPeakPct + 1e-6 < minRetraceFromPeakPct) continue;

    let anchorPx = b[0].px;
    let anchorTs = b[0].ts;
    for (let i = 0; i <= peakIdx; i++) {
      if (b[i].px < anchorPx) {
        anchorPx = b[i].px;
        anchorTs = b[i].ts;
      }
    }

    const risePct =
      anchorPx > 0 && peakPx > anchorPx ? ((peakPx - anchorPx) / anchorPx) * 100 : 0;
    if (minRisePct != null && risePct + 1e-6 < minRisePct) continue;

    return {
      signalMode,
      risePct,
      retraceFromPeakPct,
      anchorPx,
      peakPx,
      lastPx,
      anchorTs,
      peakTs: b[peakIdx].ts,
      lastTs,
    };
  }

  return null;
}

/**
 * Пик — последний локальный хай перед откатом (max на [пик..последний бар]), не старый глобальный max окна.
 */
export function detectRiseThenRetraceFromBars(
  bars: Bar[],
  minRisePct: number,
  minRetraceFromPeakPct: number,
): PullbackPick | null {
  return detectLatestLegRetraceFromBars(
    bars,
    minRetraceFromPeakPct,
    minRisePct,
    'rise_then_retrace',
  );
}

/**
 * То же определение пика, без порога роста от дна до пика.
 */
export function detectLocalHighRetraceFromBars(
  bars: Bar[],
  minRetraceFromPeakPct: number,
): PullbackPick | null {
  return detectLatestLegRetraceFromBars(
    bars,
    minRetraceFromPeakPct,
    null,
    'local_high_retrace',
  );
}

async function fetchLatestForTable(table: DexTable): Promise<LatestMeta[]> {
  const q = buildLatestOnlyQuery(table);
  const r = await db.execute(dsql.raw(q));
  const rows = r as unknown as Record<string, unknown>[];
  const out: LatestMeta[] = [];
  for (const row of rows) {
    const mint = String(row.base_mint ?? '').trim();
    const pair = String(row.pair_address ?? '').trim();
    const px = Number(row.px_now);
    if (!ADDR_RE.test(mint) || !ADDR_RE.test(pair) || !(px > 0)) continue;
    out.push({
      base_mint: mint,
      pair_address: pair,
      px_now: px,
      ts_now: row.ts_now as Date | string,
      symbol: row.symbol != null ? String(row.symbol) : null,
      token_name: row.token_name != null ? String(row.token_name) : null,
      holder_count: row.holder_count != null ? Number(row.holder_count) : null,
      liq_usd: row.liq_usd != null ? Number(row.liq_usd) : null,
      token_fdv_usd:
        row.token_fdv_usd != null && Number.isFinite(Number(row.token_fdv_usd))
          ? Number(row.token_fdv_usd)
          : null,
    });
  }
  return out;
}

async function fetchBarsBatch(
  table: DexTable,
  latestRows: LatestMeta[],
): Promise<Map<string, Bar[]>> {
  const map = new Map<string, Bar[]>();
  if (latestRows.length === 0) return map;
  const tupleSql = sqlMintPairInTuples(latestRows);
  if (tupleSql === null) return map;
  const q = buildBarsQuery(table, tupleSql);
  const r = await db.execute(dsql.raw(q));
  const rows = r as unknown as Record<string, unknown>[];
  for (const row of rows) {
    const mint = String(row.base_mint ?? '');
    const pair = String(row.pair_address ?? '');
    const px = Number(row.price_usd);
    if (!mint || !pair || !(px > 0)) continue;
    const ts = parseTs(row.ts as Date | string);
    const mcapUsd = parseMcapUsd(row);
    const key = barsMapKey(mint, pair);
    const arr = map.get(key) ?? [];
    arr.push({ ts, px, mcapUsd });
    map.set(key, arr);
  }
  return map;
}

type SendTelegramResult = { ok: boolean };

async function sendTelegram(text: string, parseMode?: 'HTML'): Promise<SendTelegramResult> {
  if (!TG_TOKEN || !TG_CHAT) return { ok: false };
  const url = `https://api.telegram.org/bot${TG_TOKEN}/sendMessage`;
  const payload: Record<string, unknown> = {
    chat_id: TG_CHAT,
    text,
    disable_web_page_preview: true,
  };
  if (parseMode) payload.parse_mode = parseMode;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const errBody = await res.text();
    console.warn(
      '[market-pullback-telegram-watch] sendMessage failed',
      res.status,
      errBody.slice(0, 400),
    );
    return { ok: false };
  }
  return { ok: true };
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function refMcapUsd(meta: LatestMeta, lastBarMcap: number | null): number {
  const fromBar = lastBarMcap != null && lastBarMcap > 0 ? lastBarMcap : 0;
  const fdv = meta.token_fdv_usd != null && meta.token_fdv_usd > 0 ? meta.token_fdv_usd : 0;
  return Math.max(fromBar, fdv);
}

/** Канал pullback/retrace: мин. пролив от пика (%) по ref mcap; null — ниже $1M, не слать. */
function minRetracePctByRefMcapUsd(mcapUsd: number): number | null {
  if (!(mcapUsd >= 1_000_000)) return null;
  if (mcapUsd < 4_000_000) return 17;
  if (mcapUsd < 8_000_000) return 13;
  return 9;
}

function passesRetraceTierByRefMcap(mcapUsd: number, retraceFromPeakPct: number): boolean {
  const minPct = minRetracePctByRefMcapUsd(mcapUsd);
  if (minPct == null) return false;
  return retraceFromPeakPct + 1e-6 >= minPct;
}

function buildAlertHtml(args: {
  dex: string;
  meta: LatestMeta;
  pick: PullbackPick;
  refMcap: number;
}): string {
  const { meta, pick, refMcap } = args;
  return buildDipsCompactAlertHtml({
    mint: meta.base_mint.trim(),
    symbol: meta.symbol,
    token_name: meta.token_name,
    retraceFromPeakPct: pick.retraceFromPeakPct,
    peakTs: pick.peakTs,
    peakMcapUsd: pick.peakMcapUsd,
    troughTs: pick.lastTs,
    troughMcapUsd: pick.lastMcapUsd,
    refMcap,
    displayTz: DISPLAY_TZ,
  });
}

type PullbackCandidate = {
  dex: string;
  meta: LatestMeta;
  pick: PullbackPick;
  refM: number;
};

function isPullbackPickDataGlitch(pick: PullbackPick, meta: LatestMeta, refMcapUsd: number): boolean {
  if (
    isMatureTokenMicroValleyArtifact(
      pick.anchorMcapUsd ?? null,
      pick.peakMcapUsd ?? null,
      refMcapUsd,
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

async function runOnePass(
  sendDedupe: Map<string, number> | null,
  lastSentPeakMsByMint: Map<string, number>,
): Promise<void> {
  const nowMs = Date.now();
  const maxBarAgeMs = MAX_NEWER_BAR_AGE_MIN * 60_000;
  let sent = 0;
  let skipped = 0;
  const byMint = new Map<string, PullbackCandidate>();
  const tableLatest: { table: DexTable; rows: LatestMeta[] }[] = [];

  for (const table of SNAPSHOT_TABLES) {
    try {
      const latest = await fetchLatestForTable(table);
      tableLatest.push({ table, rows: latest });
    } catch (e) {
      console.warn(`[market-pullback-telegram-watch] ${table} latest query failed`, String(e));
    }
  }

  const rowsByTable = CANONICAL_POOL_BY_MAX_LIQ
    ? groupCanonicalRowsByTable(buildMintCanonicalPoolMap(tableLatest))
    : new Map(tableLatest.map(({ table, rows }) => [table, rows] as const));

  for (const [table, analyzeRows] of rowsByTable) {
    const dexTable = table as DexTable;
    const dex = dexLabel(dexTable);
    let barsByKey: Map<string, Bar[]>;
    try {
      barsByKey = await fetchBarsBatch(dexTable, analyzeRows);
    } catch (e) {
      console.warn(`[market-pullback-telegram-watch] ${table} bars query failed`, String(e));
      continue;
    }

    for (const meta of analyzeRows) {
      const key = barsMapKey(meta.base_mint, meta.pair_address);
      const rawBars = barsByKey.get(key) ?? [];
      const pickRaw =
        SIGNAL_MODE === 'local_high_retrace'
          ? detectLocalHighRetraceFromBars(rawBars, MIN_RETRACE_PCT)
          : detectRiseThenRetraceFromBars(rawBars, MIN_RISE_PCT, MIN_RETRACE_PCT);
      if (!pickRaw) {
        skipped++;
        continue;
      }
      const pick = enrichPullbackPickMcap(pickRaw, rawBars);

      const lastMs = pick.lastTs.getTime();
      if (nowMs - lastMs > maxBarAgeMs) {
        skipped++;
        continue;
      }

      const lastBar = dedupeBarsSorted(rawBars).at(-1);
      const refM = refMcapUsd(meta, lastBar?.mcapUsd ?? null);
      if (MIN_MARKET_CAP_USD > 0 && refM + 1 < MIN_MARKET_CAP_USD) {
        skipped++;
        continue;
      }

      if (isPullbackPickDataGlitch(pick, meta, refM)) {
        skipped++;
        continue;
      }

      if (!passesRetraceTierByRefMcap(refM, pick.retraceFromPeakPct)) {
        skipped++;
        continue;
      }

      const mint = meta.base_mint.trim();
      const cand: PullbackCandidate = { dex, meta, pick, refM };
      const prev = byMint.get(mint);
      if (
        !prev ||
        pick.retraceFromPeakPct > prev.pick.retraceFromPeakPct ||
        (Math.abs(pick.retraceFromPeakPct - prev.pick.retraceFromPeakPct) < 1e-9 &&
          pick.lastTs.getTime() > prev.pick.lastTs.getTime())
      ) {
        byMint.set(mint, cand);
      }
    }
  }

  for (const [mint, { dex, meta, pick, refM }] of byMint) {
    const peakMs = pick.peakTs.getTime();
    if (isDuplicateOngoingPullback(lastSentPeakMsByMint.get(mint), pick.peakTs)) {
      skipped++;
      continue;
    }
    if (sendDedupe && POLL_SEND_DEDUPE_MS > 0) {
      const dedupeKey = pullbackAlertEventDedupeKey(mint, pick.peakTs);
      const lastSend = sendDedupe.get(dedupeKey) ?? 0;
      if (nowMs - lastSend < POLL_SEND_DEDUPE_MS) {
        skipped++;
        continue;
      }
    }

    if (!reserveRetracePullbackChannelSlot(mint, pick.peakTs, 'pullback')) {
      skipped++;
      continue;
    }

    if (await wasMarketFastAlertRecent(mint, 'dips')) {
      skipped++;
      continue;
    }

    const html = buildAlertHtml({ dex, meta, pick, refMcap: refM });
    if (DRY_RUN) {
      console.log('[PULLBACK_DRY_RUN]', mint.slice(0, 8), pick.risePct, pick.retraceFromPeakPct);
      lastSentPeakMsByMint.set(mint, peakMs);
      if (sendDedupe && POLL_SEND_DEDUPE_MS > 0) {
        sendDedupe.set(pullbackAlertEventDedupeKey(mint, pick.peakTs), nowMs);
      }
      sent++;
      continue;
    }

    const tg = await sendTelegram(html, 'HTML');
    if (tg.ok) {
      sent++;
      lastSentPeakMsByMint.set(mint, peakMs);
      if (sendDedupe && POLL_SEND_DEDUPE_MS > 0) {
        sendDedupe.set(pullbackAlertEventDedupeKey(mint, pick.peakTs), nowMs);
      }
      await sleepMs(200);
    } else {
      skipped++;
    }
  }

  const riseLog =
    SIGNAL_MODE === 'local_high_retrace' ? `retrace>=${MIN_RETRACE_PCT}%` : `rise>=${MIN_RISE_PCT}% retrace>=${MIN_RETRACE_PCT}%`;
  console.log(
    `[market-pullback-telegram-watch] pass done sent=${sent} skipped=${skipped} mode=${SIGNAL_MODE} ${riseLog} minMcap=$${MIN_MARKET_CAP_USD} scan=${SCAN_MINUTES}m barAge<=${MAX_NEWER_BAR_AGE_MIN}m mintPeakDedupe=on channelDedupe=on`,
  );
}

async function main(): Promise<void> {
  if (!TG_TOKEN || !TG_CHAT) {
    console.error(
      '[market-pullback-telegram-watch] Skip: set PULLBACK_ALERT_TELEGRAM_BOT_TOKEN and PULLBACK_ALERT_TELEGRAM_CHAT_ID.',
    );
    process.exit(0);
    return;
  }

  if (POLL_INTERVAL_MS > 0) {
    const sendDedupe = new Map<string, number>();
    const lastSentPeakMsByMint = new Map<string, number>();
    console.log(
      `[market-pullback-telegram-watch] poll interval=${POLL_INTERVAL_MS}ms dedupe=${POLL_SEND_DEDUPE_MS}ms signal_mode=${SIGNAL_MODE} scan=${SCAN_MINUTES}m`,
    );
    let stop = false;
    const onStop = (): void => {
      stop = true;
    };
    process.on('SIGINT', onStop);
    process.on('SIGTERM', onStop);
    while (!stop) {
      try {
        await runOnePass(sendDedupe, lastSentPeakMsByMint);
      } catch (e) {
        console.warn('[market-pullback-telegram-watch] cycle error', String(e));
      }
      let waited = 0;
      while (waited < POLL_INTERVAL_MS && !stop) {
        const chunk = Math.min(500, POLL_INTERVAL_MS - waited);
        await sleepMs(chunk);
        waited += chunk;
      }
    }
    process.exit(0);
    return;
  }

  await runOnePass(null, new Map<string, number>());
}

if (process.env.PULLBACK_ALERT_SKIP_MAIN !== '1') {
  main().catch((e) => {
    console.error('[market-pullback-telegram-watch] fatal', e);
    process.exit(1);
  });
}
