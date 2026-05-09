/**
 * Отдельный watch-only бот: резкий рост/пролив по снимкам DEX в Postgres → Telegram.
 *
 * Не использует TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID продового Live Oscar.
 * Только SPIKE_ALERT_TELEGRAM_* и только SELECT по таблицам снимков + tokens.
 *
 * Детекция: по каждому mint из свежей выборки поднимаем цепочку минутных баров за SPIKE_ALERT_SCAN_MINUTES
 * и ищем **соседнюю** пару баров с |Δ%| ≥ порога (отдельно для роста и пролива:
 * SPIKE_ALERT_THRESHOLD_PUMP_CONSEC_PCT / SPIKE_ALERT_THRESHOLD_DUMP_CONSEC_PCT).
 * Дополнительно — накопление: для каждого целого окна от SPIKE_ALERT_ROLLING_MINUTES до
 * SPIKE_ALERT_ROLLING_MAX_MINUTES ищем бар-опору «не новее чем W минут назад» и сравниваем с последним
 * баром; достаточно |Δ%| ≥ SPIKE_ALERT_THRESHOLD_ROLLING_PCT хотя бы для одного W (берётся кандидат
 * с наибольшим |Δ%|, при равенстве — меньшее W).
 *
 * SPIKE_ALERT_WINDOW_MIN / SPIKE_ALERT_LOOKBACK_SEC оставлены в коде через resolveLookbackSec только для
 * совместимости env; основной триггер — скан пар баров + rolling.
 *
 * Если в tokens нет symbol/name — перед отправкой в Telegram опционально подтягиваем метаданные с
 * Dexscreener (SPIKE_ALERT_DEXSCREENER_META) и можем дописать строку в PG (SPIKE_ALERT_UPSERT_TOKEN_META).
 *
 * Отбор «latest» по таблице: до SPIKE_ALERT_MAX_ROWS_PER_TABLE mint с **наиболее свежим** последним снимком
 * в окне пола (ORDER BY MAX(ts) DESC), не лексикографически по адресу mint.
 *
 * SPIKE_ALERT_POLL_INTERVAL_MS > 0 — цикл опроса PG (чаще, чем раз в минуту), чтобы второй минутный бар
 * успевал попасть в БД между проверками. При опросе включена короткая дедупликация отправок
 * SPIKE_ALERT_POLL_SEND_DEDUPE_MS (не путать с удалённым часовым cooldown).
 *
 * Алерт только если «новый» бар события не старше SPIKE_ALERT_MAX_NEWER_BAR_AGE_MINUTES; соседняя пара
 * берётся самая свежая в ряду (не максимум |%| за всю глубину). При очень низкой liq_usd в снимке —
 * потолок |Δ%| (anti-glitch). Время в тексте — SPIKE_ALERT_DISPLAY_TZ (по умолчанию Москва).
 *
 * История баров фильтруется по (base_mint, pair_address) из «latest», чтобы не смешивать несколько пулов
 * одного mint в одной минутной метке. SPIKE_ALERT_GLITCH_NEXT_BAR_RETRACE_MIN — подавление одноминутного
 * выброса, если следующий бар откатывает большую долю движения.
 */
import 'dotenv/config';
import { sql as dsql } from 'drizzle-orm';

import { db, sql as pgSql } from '../core/db/client.js';

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

/** Legacy env (сек), не участвует в SQL после перехода на скан баров. */
function resolveLookbackSec(): number {
  const secRaw = process.env.SPIKE_ALERT_LOOKBACK_SEC?.trim();
  if (secRaw) {
    return Math.max(30, Math.min(7200, envNum('SPIKE_ALERT_LOOKBACK_SEC', 60)));
  }
  const minRaw = process.env.SPIKE_ALERT_WINDOW_MIN?.trim();
  if (minRaw) {
    const wm = Math.max(1, Math.min(180, envNum('SPIKE_ALERT_WINDOW_MIN', 30)));
    return wm * 60;
  }
  return 60;
}

const LOOKBACK_SEC = resolveLookbackSec();
/** Нижняя граница длины окна накопления (мин); 0 — выключить накопление целиком. */
let ROLLING_MINUTES_MIN = Math.max(0, Math.min(120, Math.floor(envNum('SPIKE_ALERT_ROLLING_MINUTES', 3))));
/** Верхняя граница того же (мин); по умолчанию 10 → окна 3…10 мин включительно. */
let ROLLING_MINUTES_MAX = Math.max(0, Math.min(120, Math.floor(envNum('SPIKE_ALERT_ROLLING_MAX_MINUTES', 10))));
if (ROLLING_MINUTES_MIN > ROLLING_MINUTES_MAX) {
  const t = ROLLING_MINUTES_MIN;
  ROLLING_MINUTES_MIN = ROLLING_MINUTES_MAX;
  ROLLING_MINUTES_MAX = t;
}
/** Накопление включено, если задан положительный диапазон. */
const ROLLING_RANGE_ENABLED = ROLLING_MINUTES_MIN > 0 && ROLLING_MINUTES_MAX > 0;
/** Глубина истории баров для поиска резких скачков между соседними минутами. */
const SCAN_MINUTES = Math.max(15, Math.min(180, Math.floor(envNum('SPIKE_ALERT_SCAN_MINUTES', 60))));

/** Последний снимок mint должен быть не старше этого порога (сек). */
const LATEST_FLOOR_SEC = Math.max(
  600,
  Math.min(
    3600,
    Math.max(
      900,
      ROLLING_RANGE_ENABLED ? ROLLING_MINUTES_MAX * 60 + 300 : 900,
    ),
  ),
);

/**
 * Legacy SPIKE_ALERT_THRESHOLD_PCT — дефолт для порога pump по соседним минутам,
 * если отдельный SPIKE_ALERT_THRESHOLD_PUMP_CONSEC_PCT не задан.
 */
const THRESHOLD_PCT_LEGACY = Math.max(0.5, Math.min(80, envNum('SPIKE_ALERT_THRESHOLD_PCT', 5)));
/** Минутное окно: рост (соседние бары). */
const THRESHOLD_CONSEC_PUMP_PCT = Math.max(
  0.5,
  Math.min(80, envNum('SPIKE_ALERT_THRESHOLD_PUMP_CONSEC_PCT', THRESHOLD_PCT_LEGACY)),
);
/** Минутное окно: пролив (соседние бары). */
const THRESHOLD_CONSEC_DUMP_PCT = Math.max(
  0.5,
  Math.min(80, envNum('SPIKE_ALERT_THRESHOLD_DUMP_CONSEC_PCT', 5)),
);
/** Накопление по окнам SPIKE_ALERT_ROLLING_MINUTES…MAX (последний бар vs опора за W минут). */
const THRESHOLD_ROLLING_PCT = Math.max(
  0.5,
  Math.min(80, envNum('SPIKE_ALERT_THRESHOLD_ROLLING_PCT', 10)),
);

const SPIKE_THRESHOLD_FLOOR = Math.max(
  THRESHOLD_CONSEC_PUMP_PCT,
  THRESHOLD_CONSEC_DUMP_PCT,
  THRESHOLD_ROLLING_PCT,
);
const MIN_HOLDERS = Math.max(0, envNum('SPIKE_ALERT_MIN_HOLDERS', 1000));
const MIN_AGE_HOURS = Math.max(0, envNum('SPIKE_ALERT_MIN_AGE_HOURS', 3));
const MIN_LIQ_USD = Math.max(0, envNum('SPIKE_ALERT_MIN_LIQ_USD', 0));
const MIN_VOL_5M_USD = Math.max(0, envNum('SPIKE_ALERT_MIN_VOL_5M_USD', 0));
const MAX_ROWS = Math.max(50, Math.min(5000, envNum('SPIKE_ALERT_MAX_ROWS_PER_TABLE', 800)));
const DRY_RUN = envBool('SPIKE_ALERT_DRY_RUN', false);

/** 0 — один проход и exit (только с PM2 autorestart:false + cron_restart). Иначе цикл каждые N мс. */
const POLL_INTERVAL_MS_RAW = Math.floor(envNum('SPIKE_ALERT_POLL_INTERVAL_MS', 0));
const POLL_INTERVAL_MS =
  POLL_INTERVAL_MS_RAW <= 0 ? 0 : Math.max(5000, Math.min(600_000, POLL_INTERVAL_MS_RAW));
/** Анти-спам при poll: не слать повтор того же события чаще чем раз в N мс (только если POLL > 0). */
const POLL_SEND_DEDUPE_MS = Math.max(0, Math.min(3_600_000, Math.floor(envNum('SPIKE_ALERT_POLL_SEND_DEDUPE_MS', 120_000))));

/** Алерт только если «новый» бар скачка не старше N минут относительно now (отсекает старые движения в окне скана). */
const MAX_NEWER_BAR_AGE_MIN = Math.max(
  1,
  Math.min(180, Math.floor(envNum('SPIKE_ALERT_MAX_NEWER_BAR_AGE_MINUTES', 12))),
);

/**
 * Если известна liq_usd из последнего снимка и она ниже порога — не считать движение выше LOW_LIQ_MAX_ABS_PCT
 * (тонкий пул / шум котировки price_usd в PG).
 */
const LOW_LIQ_GLITCH_THRESHOLD_USD = Math.max(0, envNum('SPIKE_ALERT_LOW_LIQ_GLITCH_THRESHOLD_USD', 5000));
const LOW_LIQ_MAX_ABS_PCT = Math.max(
  SPIKE_THRESHOLD_FLOOR,
  Math.min(500, envNum('SPIKE_ALERT_LOW_LIQ_MAX_ABS_PCT', 55)),
);

/** Достать symbol/name у Dexscreener, если в tokens пусто (кэш на процесс + опционально UPSERT). */
const DEXSCREENER_META_ENABLED = envBool('SPIKE_ALERT_DEXSCREENER_META', true);
const UPSERT_TOKEN_META_FROM_DEX = envBool('SPIKE_ALERT_UPSERT_TOKEN_META', true);
const DEX_META_CHUNK = Math.max(1, Math.min(40, Math.floor(envNum('SPIKE_ALERT_DEXSCREENER_CHUNK', 20))));
const DEX_META_CACHE_TTL_MS = Math.max(
  60_000,
  Math.min(7 * 24 * 3600_000, Math.floor(envNum('SPIKE_ALERT_DEXSCREENER_CACHE_TTL_MS', 24 * 3600_000))),
);

type DexTokenMeta = { symbol: string | null; name: string | null };
const dexMetaCache = new Map<string, { meta: DexTokenMeta; at: number }>();

/**
 * Если следующий минутный бар откатывает ≥ доли импульса (разовый выброс в PG) — не считать пару событий.
 * 0 = выкл.
 */
const GLITCH_NEXT_BAR_RETRACE_MIN = Math.max(
  0,
  Math.min(1, envNum('SPIKE_ALERT_GLITCH_NEXT_BAR_RETRACE_MIN', 0.55)),
);

const DISPLAY_TZ = process.env.SPIKE_ALERT_DISPLAY_TZ?.trim() || 'Europe/Moscow';

const TG_TOKEN = process.env.SPIKE_ALERT_TELEGRAM_BOT_TOKEN?.trim() ?? '';
const TG_CHAT = process.env.SPIKE_ALERT_TELEGRAM_CHAT_ID?.trim() ?? '';

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
  /** Fallback для строки Market cap, если в мин. снимках нет mcap/fdv по паре. */
  token_fdv_usd: number | null;
};

type Bar = { ts: Date; px: number; mcapUsd: number | null };

type SpikeSignalKind = 'consecutive' | 'rolling';

type SpikePick = {
  pct: number;
  anchorPx: number;
  pxNow: number;
  anchorMcapUsd: number | null;
  nowMcapUsd: number | null;
  anchorTs: Date;
  tsNew: Date;
  windowLabel: string;
  signalKind: SpikeSignalKind;
  /** Заполнено для signalKind rolling: какое W минут дало этот кандидат. */
  rollingSpanMinutes?: number;
};

const ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,64}$/;

/** Кортежи (mint, pair) только для пулов из latest — иначе несколько пар на mint смешиваются в одну минуту. */
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
  const snapshotFilters = `
    AND s.ts > now() - (${LATEST_FLOOR_SEC} * interval '1 second')
    AND COALESCE(s.price_usd, 0) > 0
    AND COALESCE(t.holder_count, 0) >= ${MIN_HOLDERS}
    AND (
      (s.launch_ts IS NOT NULL AND s.launch_ts <= now() - interval '${MIN_AGE_HOURS} hours')
      OR (s.launch_ts IS NULL AND t.first_seen_at <= now() - interval '${MIN_AGE_HOURS} hours')
    )
    ${liqClause}
    ${volClause}`;
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
  SELECT DISTINCT ON (s.base_mint)
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
  ORDER BY s.base_mint, s.ts DESC
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
SELECT base_mint::text, ts, price_usd::double precision AS price_usd,
  COALESCE(market_cap_usd, fdv_usd)::double precision AS mcap_usd
FROM ${table}
WHERE (base_mint, pair_address) IN (${mintPairTuplesSql})
  AND ts > now() - (${SCAN_MINUTES} * interval '1 minute')
  AND COALESCE(price_usd, 0) > 0
ORDER BY base_mint ASC, ts ASC`;
}

function parseTs(v: Date | string): Date {
  if (v instanceof Date) return v;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? new Date(0) : d;
}

/** Один ts — одна точка (последняя цена на метку времени). */
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

function formatDisplayHm(d: Date): string {
  try {
    const fmt = new Intl.DateTimeFormat('ru-RU', {
      timeZone: DISPLAY_TZ,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    return `${fmt.format(d)} МСК`;
  } catch {
    return d.toISOString().slice(11, 16) + ' UTC';
  }
}

/** Новый бар события достаточно свежий, чтобы слать алерт (не «архив» из SCAN_MINUTES). */
function isPickFreshEnough(pick: SpikePick, nowMs: number): boolean {
  const ageMs = nowMs - pick.tsNew.getTime();
  return ageMs >= 0 && ageMs <= MAX_NEWER_BAR_AGE_MIN * 60_000;
}

/** Отсечь подозрительно большие % при очень маленькой ликвидности в снимке pair. */
function isPickPlausibleForLiquidity(pick: SpikePick, liqUsd: number | null): boolean {
  if (LOW_LIQ_GLITCH_THRESHOLD_USD <= 0 || LOW_LIQ_MAX_ABS_PCT >= 500) return true;
  if (liqUsd == null || !(liqUsd > 0) || liqUsd >= LOW_LIQ_GLITCH_THRESHOLD_USD) return true;
  return Math.abs(pick.pct) <= LOW_LIQ_MAX_ABS_PCT;
}

/** Следующий бар частично отменил скачок — типичный артефакт минутного снимка. */
function isOneBarGlitchReversedByNext(bars: Bar[], newerIdx: number): boolean {
  const thr = GLITCH_NEXT_BAR_RETRACE_MIN;
  if (thr <= 0 || newerIdx + 1 >= bars.length) return false;
  const o = bars[newerIdx - 1].px;
  const n = bars[newerIdx].px;
  const x = bars[newerIdx + 1].px;
  if (!(o > 0) || !(n > 0) || !(x > 0)) return false;
  if (n < o && x > n) {
    const impulse = o - n;
    const rec = x - n;
    return impulse > 0 && rec / impulse >= thr;
  }
  if (n > o && x < n) {
    const impulse = n - o;
    const rec = n - x;
    return impulse > 0 && rec / impulse >= thr;
  }
  return false;
}

/** Для W ∈ [ROLLING_MINUTES_MIN … MAX]: опора — последний бар с ts ≤ now−W·60s; сравнение с последним баром ряда. */
function pickRollingRangeFromBars(bars: Bar[]): SpikePick | null {
  if (!ROLLING_RANGE_ENABLED || bars.length < 2) return null;
  const newest = bars[bars.length - 1];
  let best: SpikePick | null = null;
  for (let w = ROLLING_MINUTES_MIN; w <= ROLLING_MINUTES_MAX; w++) {
    const cutoffMs = Date.now() - w * 60_000;
    let anchor: Bar | null = null;
    for (let i = bars.length - 1; i >= 0; i--) {
      if (bars[i].ts.getTime() <= cutoffMs) {
        anchor = bars[i];
        break;
      }
    }
    if (!anchor || !(anchor.px > 0) || !(newest.px > 0)) continue;
    if (anchor.ts.getTime() >= newest.ts.getTime()) continue;
    const pct = (newest.px / anchor.px - 1) * 100;
    if (!Number.isFinite(pct) || Math.abs(pct) < THRESHOLD_ROLLING_PCT) continue;
    const pick: SpikePick = {
      pct,
      anchorPx: anchor.px,
      pxNow: newest.px,
      anchorMcapUsd: anchor.mcapUsd,
      nowMcapUsd: newest.mcapUsd,
      anchorTs: anchor.ts,
      tsNew: newest.ts,
      windowLabel: `${w} мин накопл., конец ${formatDisplayHm(newest.ts)}`,
      signalKind: 'rolling',
      rollingSpanMinutes: w,
    };
    if (
      !best ||
      Math.abs(pick.pct) > Math.abs(best.pct) ||
      (Math.abs(pick.pct) === Math.abs(best.pct) &&
        (best.rollingSpanMinutes == null || w < best.rollingSpanMinutes))
    ) {
      best = pick;
    }
  }
  return best;
}

/** Самая свежая соседняя пара минутных баров с |Δ%| ≥ порога (с конца ряда), не максимум за всю глубину скана. */
function pickConsecutiveBarSpike(bars: Bar[]): SpikePick | null {
  if (bars.length < 2) return null;
  for (let i = bars.length - 1; i >= 1; i--) {
    const older = bars[i - 1];
    const newer = bars[i];
    if (!(older.px > 0) || !(newer.px > 0)) continue;
    const pct = (newer.px / older.px - 1) * 100;
    if (!Number.isFinite(pct)) continue;
    const thrAbs = pct >= 0 ? THRESHOLD_CONSEC_PUMP_PCT : THRESHOLD_CONSEC_DUMP_PCT;
    if (Math.abs(pct) < thrAbs) continue;
    if (isOneBarGlitchReversedByNext(bars, i)) continue;
    return {
      pct,
      anchorPx: older.px,
      pxNow: newer.px,
      anchorMcapUsd: older.mcapUsd,
      nowMcapUsd: newer.mcapUsd,
      anchorTs: older.ts,
      tsNew: newer.ts,
      windowLabel: `мин. ${formatDisplayHm(older.ts)}→${formatDisplayHm(newer.ts)}`,
      signalKind: 'consecutive',
    };
  }
  return null;
}

function analyzeBarsForMint(rawBars: Bar[]): SpikePick | null {
  const bars = dedupeBarsSorted(rawBars);
  const c1 = pickConsecutiveBarSpike(bars);
  const c2 = pickRollingRangeFromBars(bars);
  if (!c1) return c2;
  if (!c2) return c1;
  return Math.abs(c2.pct) > Math.abs(c1.pct) ? c2 : c1;
}

/** Как в `src/live/mint-whitelist.ts`. */
function gmgnSolTokenUrl(mint: string): string {
  return `https://gmgn.ai/sol/token/${encodeURIComponent(mint.trim())}`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatSignedPct(pct: number): string {
  const v = pct.toFixed(2);
  return pct >= 0 ? `+${v}%` : `${v}%`;
}

function formatMarketCapUsd(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '?';
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(2)}k`;
  return `$${n.toFixed(0)}`;
}

function marketCapMessageLine(row: AlertRow): string {
  const a = row.anchorMcapUsd;
  const b = row.nowMcapUsd;
  if (a != null && b != null && a > 0 && b > 0) {
    return `Market cap ${formatMarketCapUsd(a)} → ${formatMarketCapUsd(b)} USD`;
  }
  const fdv = row.token_fdv_usd;
  if (fdv != null && Number.isFinite(fdv) && fdv > 0) {
    return `Market cap нет в мин. снимках пары · FDV токена (tokens.fdv_usd) ~${formatMarketCapUsd(fdv)} USD`;
  }
  return 'Market cap недоступна в PG для этой пары (снимки без mcap/fdv, tokens.fdv_usd пуст)';
}

type AlertRow = LatestMeta & {
  dex: string;
  pct: number;
  windowLabel: string;
  signalKind: SpikeSignalKind;
  rollingSpanMinutes?: number;
  anchorPx: number;
  anchorTs: Date | string;
  anchorMcapUsd: number | null;
  nowMcapUsd: number | null;
};

/** Короткая метка для Telegram: «минутное окно» vs «трёхминутное» (накопление по диапазону минут). */
function telegramSignalTypeRu(row: AlertRow): string {
  return row.signalKind === 'consecutive' ? 'минутное окно' : 'трёхминутное';
}

function buildAlertHtml(row: AlertRow): string {
  const mint = row.base_mint.trim();
  const gmgnUrl = gmgnSolTokenUrl(mint);
  const sym = row.symbol?.trim() || '?';
  const kindWord = row.pct >= 0 ? 'Рост' : 'Пролив';
  const kindTag = row.pct >= 0 ? 'spike_pump' : 'spike_dump';
  const tag = `[MARKET][${kindTag}]`;
  const pctHuman = formatSignedPct(row.pct);
  const nameRaw = row.token_name?.trim();
  const title =
    nameRaw && nameRaw !== sym
      ? `<b>${escapeHtml(sym)}</b>\n<i>${escapeHtml(nameRaw)}</i>`
      : `<b>${escapeHtml(sym)}</b>`;

  let body =
    `${tag} ${kindWord} <b>${escapeHtml(pctHuman)}</b>\n` +
    `тип: <b>${escapeHtml(telegramSignalTypeRu(row))}</b>\n` +
    `окно: ${escapeHtml(row.windowLabel)}\n\n` +
    `${title}\n` +
    `<a href="${gmgnUrl}">${escapeHtml(mint)}</a>\n\n` +
    `dex: ${escapeHtml(row.dex)} · pair: ${escapeHtml(row.pair_address)}\n` +
    `holders: ${row.holder_count ?? '?'}\n` +
    `${escapeHtml(marketCapMessageLine(row))}`;
  if (row.liq_usd != null && row.liq_usd > 0) body += `\nliq ~${Math.round(row.liq_usd)} USD`;
  body += `\n<i>Мин. снимки в PG (Δ% по price_usd) · время МСК</i>`;
  return body;
}

function buildAlertPlain(row: AlertRow): string {
  const mint = row.base_mint.trim();
  const sym = row.symbol?.trim() || '?';
  const kindWord = row.pct >= 0 ? 'Рост' : 'Пролив';
  const kindTag = row.pct >= 0 ? 'spike_pump' : 'spike_dump';
  const tag = `[MARKET][${kindTag}]`;
  const nameRaw = row.token_name?.trim();
  const title = nameRaw && nameRaw !== sym ? `${sym} (${nameRaw})` : sym;
  let body =
    `${tag} ${kindWord} ${formatSignedPct(row.pct)}\n` +
    `тип: ${telegramSignalTypeRu(row)}\n` +
    `окно: ${row.windowLabel}\n\n` +
    `${title}\n` +
    `${mint}\n` +
    `GMGN: ${gmgnSolTokenUrl(mint)}\n\n` +
    `dex: ${row.dex} · pair: ${row.pair_address}\n` +
    `holders: ${row.holder_count ?? '?'}\n` +
    `${marketCapMessageLine(row)}`;
  if (row.liq_usd != null && row.liq_usd > 0) body += `\nliq ~${Math.round(row.liq_usd)} USD`;
  body += `\nМин. снимки в PG (Δ% по price_usd) · время МСК`;
  return body;
}

async function fetchLatestOnly(table: DexTable): Promise<LatestMeta[]> {
  const q = buildLatestOnlyQuery(table);
  const r = await db.execute(dsql.raw(q));
  const rows = r as unknown as Record<string, unknown>[];
  const out: LatestMeta[] = [];
  for (const row of rows) {
    const mint = String(row.base_mint ?? '');
    if (!mint) continue;
    const fdvRaw = row.token_fdv_usd;
    const fdvNum = fdvRaw != null ? Number(fdvRaw) : NaN;
    out.push({
      base_mint: mint,
      pair_address: String(row.pair_address ?? ''),
      px_now: Number(row.px_now),
      ts_now: row.ts_now as Date | string,
      symbol: row.symbol != null ? String(row.symbol) : null,
      token_name: row.token_name != null ? String(row.token_name) : null,
      holder_count: row.holder_count != null ? Number(row.holder_count) : null,
      liq_usd: row.liq_usd != null ? Number(row.liq_usd) : null,
      token_fdv_usd: Number.isFinite(fdvNum) && fdvNum > 0 ? fdvNum : null,
    });
  }
  return out;
}

async function fetchBarsBatch(table: DexTable, latestRows: LatestMeta[]): Promise<Map<string, Bar[]>> {
  const map = new Map<string, Bar[]>();
  if (latestRows.length === 0) return map;
  const tupleSql = sqlMintPairInTuples(latestRows);
  if (tupleSql === null) return map;
  const q = buildBarsQuery(table, tupleSql);
  const r = await db.execute(dsql.raw(q));
  const rows = r as unknown as Record<string, unknown>[];
  for (const row of rows) {
    const mint = String(row.base_mint ?? '');
    const px = Number(row.price_usd);
    if (!mint || !(px > 0)) continue;
    const ts = parseTs(row.ts as Date | string);
    const mcapUsd = parseMcapUsd(row);
    const arr = map.get(mint) ?? [];
    arr.push({ ts, px, mcapUsd });
    map.set(mint, arr);
  }
  return map;
}

async function sendTelegram(text: string, parseMode?: 'HTML'): Promise<boolean> {
  if (!TG_TOKEN || !TG_CHAT) return false;
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
      '[market-spike-telegram-watch] sendMessage failed',
      res.status,
      errBody.slice(0, 400),
    );
  }
  return res.ok;
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function tokenMetaLooksMissing(v: string | null | undefined): boolean {
  const t = v?.trim();
  return !t || t === '?';
}

function needsDexMeta(meta: LatestMeta): boolean {
  return tokenMetaLooksMissing(meta.symbol) || tokenMetaLooksMissing(meta.token_name);
}

function truncateTokenMetaField(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return `${s.slice(0, Math.max(0, maxLen - 1))}…`;
}

async function fetchDexscreenerTokenMetaForMints(mints: string[]): Promise<Map<string, DexTokenMeta>> {
  const out = new Map<string, DexTokenMeta>();
  const now = Date.now();
  const unique = [...new Set(mints.map((m) => m.trim()).filter((m) => ADDR_RE.test(m)))];
  const toRequest: string[] = [];
  for (const m of unique) {
    const c = dexMetaCache.get(m);
    if (c && now - c.at < DEX_META_CACHE_TTL_MS) {
      out.set(m, c.meta);
    } else {
      toRequest.push(m);
    }
  }

  for (let i = 0; i < toRequest.length; i += DEX_META_CHUNK) {
    const chunk = toRequest.slice(i, i + DEX_META_CHUNK);
    const chunkSet = new Set(chunk);
    let apiOk = false;
    const fromPairs = new Map<string, DexTokenMeta>();
    try {
      const url = `https://api.dexscreener.com/latest/dex/tokens/${chunk.map((m) => encodeURIComponent(m)).join(',')}`;
      const r = await fetch(url, { signal: AbortSignal.timeout(12_000) });
      apiOk = r.ok;
      if (r.ok) {
        const j = (await r.json()) as {
          pairs?: { baseToken?: { address?: string; symbol?: string; name?: string } }[];
        };
        const firstSeenAddr = new Set<string>();
        for (const p of j.pairs ?? []) {
          const addr = String(p.baseToken?.address ?? '').trim();
          if (!ADDR_RE.test(addr) || firstSeenAddr.has(addr) || !chunkSet.has(addr)) continue;
          firstSeenAddr.add(addr);
          const sym = String(p.baseToken?.symbol ?? '').trim() || null;
          const nam = String(p.baseToken?.name ?? '').trim() || null;
          fromPairs.set(addr, { symbol: sym, name: nam });
        }
      }
    } catch {
      apiOk = false;
    }

    if (apiOk) {
      for (const m of chunk) {
        const meta = fromPairs.get(m) ?? { symbol: null, name: null };
        dexMetaCache.set(m, { meta, at: Date.now() });
        out.set(m, meta);
      }
    }

    if (i + DEX_META_CHUNK < toRequest.length) await sleepMs(350);
  }

  return out;
}

async function upsertTokenMetaFromDex(mint: string, meta: DexTokenMeta): Promise<void> {
  const sym = meta.symbol ? truncateTokenMetaField(meta.symbol, 120) : null;
  const nam = meta.name ? truncateTokenMetaField(meta.name, 240) : null;
  if (!sym && !nam) return;
  try {
    await pgSql`
      INSERT INTO tokens (mint, symbol, name, decimals, metadata, updated_at)
      VALUES (
        ${mint},
        ${sym},
        ${nam},
        0,
        ${pgSql.json({ source: 'spike_watch_dexscreener' })},
        now()
      )
      ON CONFLICT (mint) DO UPDATE SET
        symbol = COALESCE(NULLIF(TRIM(tokens.symbol), ''), EXCLUDED.symbol),
        name = COALESCE(NULLIF(TRIM(tokens.name), ''), EXCLUDED.name),
        updated_at = now()
    `;
  } catch (e) {
    console.warn('[market-spike-telegram-watch] token upsert failed', mint.slice(0, 12), String(e));
  }
}

async function enrichAlertRowsWithDexMeta(rows: Iterable<AlertRow>): Promise<void> {
  if (!DEXSCREENER_META_ENABLED) return;
  const list = [...rows].filter((r) => needsDexMeta(r));
  if (!list.length) return;
  const mints = list.map((r) => r.base_mint.trim());
  const metaByMint = await fetchDexscreenerTokenMetaForMints(mints);
  for (const row of list) {
    const m = metaByMint.get(row.base_mint.trim());
    if (!m) continue;
    if (m.symbol && tokenMetaLooksMissing(row.symbol)) row.symbol = m.symbol;
    if (m.name && tokenMetaLooksMissing(row.token_name)) row.token_name = m.name;
    if (UPSERT_TOKEN_META_FROM_DEX && (m.symbol || m.name)) {
      await upsertTokenMetaFromDex(row.base_mint.trim(), m);
    }
  }
}

function pruneSendDedupe(map: Map<string, number>, olderThanMs: number): void {
  const cut = Date.now() - olderThanMs;
  for (const [k, t] of map) {
    if (t < cut) map.delete(k);
  }
}

async function runOnePass(sendDedupe: Map<string, number> | null): Promise<void> {
  const merged = new Map<string, AlertRow>();

  for (const table of SNAPSHOT_TABLES) {
    let latestRows: LatestMeta[];
    try {
      latestRows = await fetchLatestOnly(table);
    } catch (e) {
      console.warn(`[market-spike-telegram-watch] ${table} latest query failed`, String(e));
      continue;
    }
    let barsByMint: Map<string, Bar[]>;
    try {
      barsByMint = await fetchBarsBatch(table, latestRows);
    } catch (e) {
      console.warn(`[market-spike-telegram-watch] ${table} bars query failed`, String(e));
      continue;
    }

    const dex = dexLabel(table);
    const nowMs = Date.now();
    for (const meta of latestRows) {
      const bars = barsByMint.get(meta.base_mint) ?? [];
      const pick = analyzeBarsForMint(bars);
      if (!pick) continue;
      if (!isPickFreshEnough(pick, nowMs)) continue;
      if (!isPickPlausibleForLiquidity(pick, meta.liq_usd)) continue;

      const row: AlertRow = {
        ...meta,
        dex,
        pct: pick.pct,
        px_now: pick.pxNow,
        ts_now: pick.tsNew,
        windowLabel: pick.windowLabel,
        signalKind: pick.signalKind,
        rollingSpanMinutes: pick.rollingSpanMinutes,
        anchorPx: pick.anchorPx,
        anchorTs: pick.anchorTs,
        anchorMcapUsd: pick.anchorMcapUsd,
        nowMcapUsd: pick.nowMcapUsd,
      };

      const prev = merged.get(meta.base_mint);
      if (!prev || Math.abs(pick.pct) > Math.abs(prev.pct)) merged.set(meta.base_mint, row);
    }
  }

  try {
    await enrichAlertRowsWithDexMeta(merged.values());
  } catch (e) {
    console.warn('[market-spike-telegram-watch] dex meta enrich failed', String(e));
  }

  let sent = 0;
  if (sendDedupe && POLL_SEND_DEDUPE_MS > 0) {
    pruneSendDedupe(sendDedupe, POLL_SEND_DEDUPE_MS * 3);
  }

  for (const [, row] of merged) {
    const htmlBody = buildAlertHtml(row);

    if (DRY_RUN) {
      console.log('[DRY_RUN]', buildAlertPlain(row));
      continue;
    }

    if (sendDedupe && POLL_SEND_DEDUPE_MS > 0) {
      const tsNew = parseTs(row.ts_now as Date | string);
      const dedupeKey = `${row.base_mint}|${row.dex}|${tsNew.toISOString()}|${row.pct >= 0 ? 'u' : 'd'}`;
      const last = sendDedupe.get(dedupeKey) ?? 0;
      if (Date.now() - last < POLL_SEND_DEDUPE_MS) continue;
    }

    const ok = await sendTelegram(htmlBody, 'HTML');
    if (ok) {
      sent++;
      if (sendDedupe && POLL_SEND_DEDUPE_MS > 0) {
        const tsNew = parseTs(row.ts_now as Date | string);
        const dedupeKey = `${row.base_mint}|${row.dex}|${tsNew.toISOString()}|${row.pct >= 0 ? 'u' : 'd'}`;
        sendDedupe.set(dedupeKey, Date.now());
      }
    } else {
      console.warn('[market-spike-telegram-watch] Telegram send failed for', row.base_mint.slice(0, 12));
    }
    await sleepMs(200);
  }

  const rollLog = ROLLING_RANGE_ENABLED
    ? ` rolling=${ROLLING_MINUTES_MIN}-${ROLLING_MINUTES_MAX}m`
    : ' rolling=off';
  const pollLog = POLL_INTERVAL_MS > 0 ? ` poll=${POLL_INTERVAL_MS}ms` : ' poll=off(cron)';
  console.log(
    `[market-spike-telegram-watch] done candidates=${merged.size} sent=${sent} thr_consec_pump=${THRESHOLD_CONSEC_PUMP_PCT}% thr_consec_dump=${THRESHOLD_CONSEC_DUMP_PCT}% thr_rolling=${THRESHOLD_ROLLING_PCT}% scan=${SCAN_MINUTES}m newer<=${MAX_NEWER_BAR_AGE_MIN}m lowLiq<${LOW_LIQ_GLITCH_THRESHOLD_USD}USD_maxAbs=${LOW_LIQ_MAX_ABS_PCT}% glitchNextRetrace=${GLITCH_NEXT_BAR_RETRACE_MIN}${rollLog}${pollLog} legacy_lookback_sec=${LOOKBACK_SEC} holders>=${MIN_HOLDERS} age>=${MIN_AGE_HOURS}h tz=${DISPLAY_TZ} dexMeta=${DEXSCREENER_META_ENABLED ? 'on' : 'off'}`,
  );
}

async function main(): Promise<void> {
  if (!TG_TOKEN || !TG_CHAT) {
    console.error(
      '[market-spike-telegram-watch] Skip: set SPIKE_ALERT_TELEGRAM_BOT_TOKEN and SPIKE_ALERT_TELEGRAM_CHAT_ID (не используйте прод TELEGRAM_* Live Oscar).',
    );
    process.exit(0);
  }

  if (POLL_INTERVAL_MS > 0) {
    const sendDedupe = new Map<string, number>();
    console.log(
      `[market-spike-telegram-watch] poll mode: interval=${POLL_INTERVAL_MS}ms poll_send_dedupe=${POLL_SEND_DEDUPE_MS}ms`,
    );
    let stop = false;
    const onStop = (): void => {
      stop = true;
    };
    process.on('SIGINT', onStop);
    process.on('SIGTERM', onStop);
    while (!stop) {
      try {
        await runOnePass(sendDedupe);
      } catch (e) {
        console.warn('[market-spike-telegram-watch] cycle error', String(e));
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

  await runOnePass(null);
}

main().catch((e) => {
  console.error('[market-spike-telegram-watch] fatal', e);
  process.exit(1);
});
