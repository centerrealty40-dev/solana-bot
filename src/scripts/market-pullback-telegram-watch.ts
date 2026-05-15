/**
 * Watch-only (второй Telegram-канал): отдельный бот (`PULLBACK_ALERT_TELEGRAM_*`), не spike-watch, не Live Oscar.
 *
 * Режимы (`PULLBACK_ALERT_SIGNAL_MODE`):
 * - **`local_high_retrace`** (рекомендуется для «после локального хая»): в окне `PULLBACK_ALERT_SCAN_MINUTES`
 *   ищем **пик** (глобальный max `price_usd`, правый хвост плато), затем сравниваем **последний бар** с пиком;
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
const MIN_AGE_HOURS = Math.max(0, envNum('PULLBACK_ALERT_MIN_AGE_HOURS', 3));
const MIN_LIQ_USD = Math.max(0, envNum('PULLBACK_ALERT_MIN_LIQ_USD', 0));
const MIN_VOL_5M_USD = Math.max(0, envNum('PULLBACK_ALERT_MIN_VOL_5M_USD', 0));
const MIN_MARKET_CAP_USD = Math.max(0, envNum('PULLBACK_ALERT_MIN_MARKET_CAP_USD', 1_500_000));
const MAX_ROWS = Math.max(50, Math.min(5000, envNum('PULLBACK_ALERT_MAX_ROWS_PER_TABLE', 800)));
const DRY_RUN = envBool('PULLBACK_ALERT_DRY_RUN', false);

const POLL_INTERVAL_MS_RAW = Math.floor(envNum('PULLBACK_ALERT_POLL_INTERVAL_MS', 20_000));
const POLL_INTERVAL_MS =
  POLL_INTERVAL_MS_RAW <= 0 ? 0 : Math.max(5000, Math.min(600_000, POLL_INTERVAL_MS_RAW));
const POLL_SEND_DEDUPE_MS = Math.max(
  0,
  Math.min(3_600_000, Math.floor(envNum('PULLBACK_ALERT_POLL_SEND_DEDUPE_MS', 120_000))),
);

const MINT_COOLDOWN_MINUTES = Math.max(
  0,
  Math.min(24 * 60, Math.floor(envNum('PULLBACK_ALERT_MINT_COOLDOWN_MINUTES', 30))),
);
const MINT_COOLDOWN_MS = MINT_COOLDOWN_MINUTES * 60_000;

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

function parseMcapUsd(row: Record<string, unknown>): number | null {
  const v = row.mcap_usd;
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Пик — последняя точка глобального максимума цены в окне; якорь — минимум до пика; откат считается
 * от пика до **последнего бара** (текущая котировка должна быть в откате, а не только исторический минимум).
 */
export function detectRiseThenRetraceFromBars(
  bars: Bar[],
  minRisePct: number,
  minRetraceFromPeakPct: number,
): PullbackPick | null {
  const b = dedupeBarsSorted(bars);
  if (b.length < 2) return null;

  let peakPx = b[0].px;
  let peakIdx = 0;
  const eps = (px: number) => Math.max(1e-12, Math.abs(px) * 1e-12);
  for (let i = 1; i < b.length; i++) {
    if (b[i].px > peakPx + eps(peakPx)) {
      peakPx = b[i].px;
      peakIdx = i;
    } else if (Math.abs(b[i].px - peakPx) <= eps(peakPx)) {
      peakIdx = i;
    }
  }
  if (!(peakPx > 0) || !Number.isFinite(peakPx)) return null;

  let anchorPx = b[0].px;
  let anchorTs = b[0].ts;
  for (let i = 0; i <= peakIdx; i++) {
    if (b[i].px < anchorPx) {
      anchorPx = b[i].px;
      anchorTs = b[i].ts;
    }
  }

  const last = b[b.length - 1];
  const lastPx = last.px;
  const lastTs = last.ts;

  if (!(anchorPx > 0) || !(peakPx > anchorPx)) return null;

  const risePct = ((peakPx - anchorPx) / anchorPx) * 100;
  if (risePct + 1e-6 < minRisePct) return null;

  const retraceFromPeakPct = ((peakPx - lastPx) / peakPx) * 100;
  if (retraceFromPeakPct + 1e-6 < minRetraceFromPeakPct) return null;

  return {
    signalMode: 'rise_then_retrace',
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

/**
 * Только «локальный хай» в окне: пик = max цены (правый хвост плато); откат = пик → последний бар.
 * Нет фильтра по предварительному росту от минимума до пика.
 */
export function detectLocalHighRetraceFromBars(
  bars: Bar[],
  minRetraceFromPeakPct: number,
): PullbackPick | null {
  const b = dedupeBarsSorted(bars);
  if (b.length < 2) return null;

  let peakPx = b[0].px;
  let peakIdx = 0;
  const eps = (px: number) => Math.max(1e-12, Math.abs(px) * 1e-12);
  for (let i = 1; i < b.length; i++) {
    if (b[i].px > peakPx + eps(peakPx)) {
      peakPx = b[i].px;
      peakIdx = i;
    } else if (Math.abs(b[i].px - peakPx) <= eps(peakPx)) {
      peakIdx = i;
    }
  }
  if (!(peakPx > 0) || !Number.isFinite(peakPx)) return null;

  let anchorPx = b[0].px;
  let anchorTs = b[0].ts;
  for (let i = 0; i <= peakIdx; i++) {
    if (b[i].px < anchorPx) {
      anchorPx = b[i].px;
      anchorTs = b[i].ts;
    }
  }

  const last = b[b.length - 1];
  const lastPx = last.px;
  const lastTs = last.ts;

  if (!(peakPx > 0) || !(lastPx > 0)) return null;

  const retraceFromPeakPct = ((peakPx - lastPx) / peakPx) * 100;
  if (retraceFromPeakPct + 1e-6 < minRetraceFromPeakPct) return null;

  const risePct = anchorPx > 0 && peakPx > anchorPx ? ((peakPx - anchorPx) / anchorPx) * 100 : 0;

  return {
    signalMode: 'local_high_retrace',
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

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatPct(x: number): string {
  return `${x >= 0 ? '+' : ''}${x.toFixed(2)}%`;
}

function formatTsInTz(d: Date): string {
  try {
    return new Intl.DateTimeFormat('ru-RU', {
      timeZone: DISPLAY_TZ,
      dateStyle: 'short',
      timeStyle: 'medium',
    }).format(d);
  } catch {
    return d.toISOString();
  }
}

function refMcapUsd(meta: LatestMeta, lastBarMcap: number | null): number {
  const fromBar = lastBarMcap != null && lastBarMcap > 0 ? lastBarMcap : 0;
  const fdv = meta.token_fdv_usd != null && meta.token_fdv_usd > 0 ? meta.token_fdv_usd : 0;
  return Math.max(fromBar, fdv);
}

function buildAlertHtml(args: {
  dex: string;
  meta: LatestMeta;
  pick: PullbackPick;
  refMcap: number;
}): string {
  const { dex, meta, pick, refMcap } = args;
  const sym = escapeHtml((meta.symbol ?? '?').trim() || '?');
  const name = escapeHtml((meta.token_name ?? '').trim());
  const mintShort = `${meta.base_mint.slice(0, 6)}…${meta.base_mint.slice(-4)}`;
  const holders =
    meta.holder_count != null && Number.isFinite(meta.holder_count)
      ? String(meta.holder_count)
      : 'n/a';
  const mcapStr =
    refMcap > 0
      ? `$${(refMcap / 1e6).toFixed(2)}M`
      : 'n/a';
  const riseLine =
    pick.signalMode === 'local_high_retrace'
      ? pick.risePct > 1e-6
        ? `Предварительный рост (min→peak, справочно): <b>${formatPct(pick.risePct)}</b> · Откат peak→now: <b>${formatPct(-pick.retraceFromPeakPct)}</b>`
        : `Откат от пика окна peak→now: <b>${formatPct(-pick.retraceFromPeakPct)}</b> <i>(без порога по росту до пика)</i>`
      : `Rise (anchor→peak): <b>${formatPct(pick.risePct)}</b> · Retrace from peak→now: <b>${formatPct(-pick.retraceFromPeakPct)}</b>`;
  const modeLine =
    pick.signalMode === 'local_high_retrace'
      ? `Режим: <b>local_high_retrace</b> · lookback <b>${SCAN_MINUTES}m</b>`
      : `Режим: <b>rise_then_retrace</b> · lookback <b>${SCAN_MINUTES}m</b>`;
  return [
    `<b>[MARKET][pullback]</b> <code>${escapeHtml(dex)}</code>`,
    modeLine,
    `<b>${sym}</b>${name ? ` — ${name}` : ''}`,
    `Mint: <code>${escapeHtml(meta.base_mint)}</code> (${escapeHtml(mintShort)})`,
    `Pair: <code>${escapeHtml(meta.pair_address)}</code>`,
    riseLine,
    `Low before peak ${formatTsInTz(pick.anchorTs)} · Peak ${formatTsInTz(pick.peakTs)} · Last ${formatTsInTz(pick.lastTs)}`,
    `Ref mcap/fdv ≈ ${escapeHtml(mcapStr)} · holders ${escapeHtml(holders)}`,
  ].join('\n');
}

async function runOnePass(sendDedupe: Map<string, number> | null, mintCooldown: Map<string, number>): Promise<void> {
  const nowMs = Date.now();
  const maxBarAgeMs = MAX_NEWER_BAR_AGE_MIN * 60_000;
  let sent = 0;
  let skipped = 0;

  for (const table of SNAPSHOT_TABLES) {
    const dex = dexLabel(table);
    const latest = await fetchLatestForTable(table);
    const barsByKey = await fetchBarsBatch(table, latest);
    for (const meta of latest) {
      const key = barsMapKey(meta.base_mint, meta.pair_address);
      const rawBars = barsByKey.get(key) ?? [];
      const pick =
        SIGNAL_MODE === 'local_high_retrace'
          ? detectLocalHighRetraceFromBars(rawBars, MIN_RETRACE_PCT)
          : detectRiseThenRetraceFromBars(rawBars, MIN_RISE_PCT, MIN_RETRACE_PCT);
      if (!pick) {
        skipped++;
        continue;
      }

      const lastMs = pick.lastTs.getTime();
      if (nowMs - lastMs > maxBarAgeMs) {
        skipped++;
        continue;
      }

      const cdKey = key;
      const lastCd = mintCooldown.get(cdKey) ?? 0;
      if (MINT_COOLDOWN_MS > 0 && nowMs - lastCd < MINT_COOLDOWN_MS) {
        skipped++;
        continue;
      }

      const lastBar = dedupeBarsSorted(rawBars).at(-1);
      const refM = refMcapUsd(meta, lastBar?.mcapUsd ?? null);
      if (MIN_MARKET_CAP_USD > 0 && refM + 1 < MIN_MARKET_CAP_USD) {
        skipped++;
        continue;
      }

      if (sendDedupe && POLL_SEND_DEDUPE_MS > 0) {
        const dedupeKey = `${key}|${pick.peakTs.toISOString()}|${pick.lastTs.toISOString()}`;
        const lastSend = sendDedupe.get(dedupeKey) ?? 0;
        if (nowMs - lastSend < POLL_SEND_DEDUPE_MS) {
          skipped++;
          continue;
        }
      }

      const html = buildAlertHtml({ dex, meta, pick, refMcap: refM });
      if (DRY_RUN) {
        console.log('[PULLBACK_DRY_RUN]', meta.base_mint.slice(0, 8), pick.risePct, pick.retraceFromPeakPct);
        mintCooldown.set(cdKey, nowMs);
        if (sendDedupe && POLL_SEND_DEDUPE_MS > 0) {
          const dedupeKey = `${key}|${pick.peakTs.toISOString()}|${pick.lastTs.toISOString()}`;
          sendDedupe.set(dedupeKey, nowMs);
        }
        sent++;
        continue;
      }

      const tg = await sendTelegram(html, 'HTML');
      if (tg.ok) {
        sent++;
        mintCooldown.set(cdKey, nowMs);
        if (sendDedupe && POLL_SEND_DEDUPE_MS > 0) {
          const dedupeKey = `${key}|${pick.peakTs.toISOString()}|${pick.lastTs.toISOString()}`;
          sendDedupe.set(dedupeKey, nowMs);
        }
        await sleepMs(200);
      } else {
        skipped++;
      }
    }
  }

  const riseLog =
    SIGNAL_MODE === 'local_high_retrace' ? `retrace>=${MIN_RETRACE_PCT}%` : `rise>=${MIN_RISE_PCT}% retrace>=${MIN_RETRACE_PCT}%`;
  console.log(
    `[market-pullback-telegram-watch] pass done sent=${sent} skipped=${skipped} mode=${SIGNAL_MODE} ${riseLog} minMcap=$${MIN_MARKET_CAP_USD} scan=${SCAN_MINUTES}m barAge<=${MAX_NEWER_BAR_AGE_MIN}m cooldown=${MINT_COOLDOWN_MINUTES}m`,
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
    const mintCooldown = new Map<string, number>();
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
        await runOnePass(sendDedupe, mintCooldown);
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
