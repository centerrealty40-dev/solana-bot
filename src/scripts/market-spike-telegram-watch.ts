/**
 * Отдельный watch-only бот: резкий рост/пролив по снимкам DEX в Postgres → Telegram.
 *
 * Не использует TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID продового Live Oscar.
 * Только SPIKE_ALERT_TELEGRAM_* и только SELECT по таблицам снимков + tokens.
 *
 * Запуск: SPIKE_ALERT_TELEGRAM_BOT_TOKEN=… SPIKE_ALERT_TELEGRAM_CHAT_ID=… npx tsx src/scripts/market-spike-telegram-watch.ts
 * Или PM2: см. ecosystem.market-spike-watch.cjs (отдельный файл — без reload основного ecosystem.config.cjs).
 *
 * Окно сравнения: SPIKE_ALERT_LOOKBACK_SEC (по умолчанию 60). Устаревшее SPIKE_ALERT_WINDOW_MIN (минуты)
 * задаёт то же в секундах, если LOOKBACK_SEC не задан. Коллекторы часто пишут ts с минутным бакетом —
 * фактическая дискретность может быть около минуты даже при lookback 60s.
 *
 * SPIKE_ALERT_ROLLING_MINUTES (>0): дополнительно считаем изменение от последней цены не новее чем N минут назад
 * до текущего снимка (накопленное за ~N минут при минутных барах). Триггер, если краткое ИЛИ накопленное
 * движение по модулю ≥ порога (берём сообщение по большему по модулю).
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
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

/** Сравнение px_now vs последний снимок не новее чем now−LOOKBACK_SEC (без новых HTTP/RPC). */
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
/** 0 = выкл.; иначе вторая опорная точка: ts <= now() − N минут (накопленное окно). */
const ROLLING_MINUTES = Math.max(0, Math.min(120, Math.floor(envNum('SPIKE_ALERT_ROLLING_MINUTES', 3))));
/** Насколько глубоко искать «последний» снимок (сек); запас относительно lookback и rolling. */
const LATEST_FLOOR_SEC = Math.max(
  180,
  Math.min(
    3600,
    Math.max(Math.ceil(LOOKBACK_SEC * 15), ROLLING_MINUTES > 0 ? ROLLING_MINUTES * 60 + 120 : 0),
  ),
);

const THRESHOLD_PCT = Math.max(0.5, Math.min(80, envNum('SPIKE_ALERT_THRESHOLD_PCT', 2.5)));
const MIN_HOLDERS = Math.max(0, envNum('SPIKE_ALERT_MIN_HOLDERS', 1000));
const MIN_AGE_HOURS = Math.max(0, envNum('SPIKE_ALERT_MIN_AGE_HOURS', 3));
const MIN_LIQ_USD = Math.max(0, envNum('SPIKE_ALERT_MIN_LIQ_USD', 0));
const MIN_VOL_5M_USD = Math.max(0, envNum('SPIKE_ALERT_MIN_VOL_5M_USD', 0));
const COOLDOWN_MS = Math.max(0, envNum('SPIKE_ALERT_COOLDOWN_MS', 3_600_000));
const MAX_ROWS = Math.max(50, Math.min(5000, envNum('SPIKE_ALERT_MAX_ROWS_PER_TABLE', 800)));
const DRY_RUN = envBool('SPIKE_ALERT_DRY_RUN', false);

const TG_TOKEN = process.env.SPIKE_ALERT_TELEGRAM_BOT_TOKEN?.trim() ?? '';
const TG_CHAT = process.env.SPIKE_ALERT_TELEGRAM_CHAT_ID?.trim() ?? '';

const STATE_PATH =
  process.env.SPIKE_ALERT_STATE_PATH?.trim() ||
  path.join(process.cwd(), 'data', 'market-spike-alert-state.json');

type CooldownState = Record<string, number>;

function loadCooldown(): CooldownState {
  try {
    const raw = fs.readFileSync(STATE_PATH, 'utf8');
    return JSON.parse(raw) as CooldownState;
  } catch {
    return {};
  }
}

function saveCooldown(st: CooldownState): void {
  const dir = path.dirname(STATE_PATH);
  if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true });
  const tmp = `${STATE_PATH}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(st, null, 2), 'utf8');
  fs.renameSync(tmp, STATE_PATH);
}

function dexLabel(table: DexTable): string {
  return table.replace('_pair_snapshots', '');
}

type CandidateRow = {
  base_mint: string;
  pair_address: string;
  px_now: number;
  ts_now: Date | string;
  px_old: number;
  ts_old: Date | string;
  px_old_roll: number | null;
  ts_old_roll: Date | string | null;
  symbol: string | null;
  token_name: string | null;
  holder_count: number | null;
  liq_usd: number | null;
};

function buildQuery(table: DexTable): string {
  const liqClause =
    MIN_LIQ_USD > 0 ? `AND COALESCE(s.liquidity_usd, 0) >= ${MIN_LIQ_USD}` : '';
  const volClause =
    MIN_VOL_5M_USD > 0 ? `AND COALESCE(s.volume_5m, 0) >= ${MIN_VOL_5M_USD}` : '';

  const rollSelect =
    ROLLING_MINUTES > 0
      ? `  o_r.price_usd::double precision AS px_old_roll,
  o_r.ts AS ts_old_roll,`
      : `  NULL::double precision AS px_old_roll,
  NULL::timestamptz AS ts_old_roll,`;

  const rollJoin =
    ROLLING_MINUTES > 0
      ? `LEFT JOIN LATERAL (
  SELECT s3.price_usd, s3.ts
  FROM ${table} s3
  WHERE s3.base_mint = l.base_mint
    AND s3.ts <= now() - (${ROLLING_MINUTES} * interval '1 minute')
    AND COALESCE(s3.price_usd, 0) > 0
  ORDER BY s3.ts DESC
  LIMIT 1
) o_r ON true`
      : '';

  return `
WITH latest AS (
  SELECT DISTINCT ON (s.base_mint)
    s.base_mint,
    s.pair_address,
    s.price_usd AS px_now,
    s.ts AS ts_now,
    s.launch_ts,
    s.liquidity_usd AS liq_usd
  FROM ${table} s
  INNER JOIN tokens t ON t.mint = s.base_mint
  WHERE s.ts > now() - (${LATEST_FLOOR_SEC} * interval '1 second')
    AND COALESCE(s.price_usd, 0) > 0
    AND COALESCE(t.holder_count, 0) >= ${MIN_HOLDERS}
    AND (
      (s.launch_ts IS NOT NULL AND s.launch_ts <= now() - interval '${MIN_AGE_HOURS} hours')
      OR (s.launch_ts IS NULL AND t.first_seen_at <= now() - interval '${MIN_AGE_HOURS} hours')
    )
    ${liqClause}
    ${volClause}
  ORDER BY s.base_mint, s.ts DESC
  LIMIT ${MAX_ROWS}
)
SELECT
  l.base_mint,
  l.pair_address,
  l.px_now::double precision AS px_now,
  l.ts_now,
  o_s.price_usd::double precision AS px_old,
  o_s.ts AS ts_old,
${rollSelect}
  t.symbol,
  t.name AS token_name,
  t.holder_count,
  l.liq_usd::double precision AS liq_usd
FROM latest l
INNER JOIN tokens t ON t.mint = l.base_mint
INNER JOIN LATERAL (
  SELECT s2.price_usd, s2.ts
  FROM ${table} s2
  WHERE s2.base_mint = l.base_mint
    AND s2.ts <= now() - (${LOOKBACK_SEC} * interval '1 second')
    AND COALESCE(s2.price_usd, 0) > 0
  ORDER BY s2.ts DESC
  LIMIT 1
) o_s ON true
${rollJoin}
WHERE o_s.price_usd IS NOT NULL AND o_s.price_usd > 0
`;
}

function pickPctFromAnchors(row: CandidateRow): {
  pct: number;
  anchorPx: number;
  anchorTs: Date | string;
  windowLabel: string;
} | null {
  const short = (row.px_now / row.px_old - 1) * 100;
  const roll =
    row.px_old_roll != null && row.px_old_roll > 0
      ? (row.px_now / row.px_old_roll - 1) * 100
      : null;

  const candidates: Array<{ pct: number; anchorPx: number; anchorTs: Date | string; windowLabel: string }> = [];
  if (Number.isFinite(short)) {
    candidates.push({
      pct: short,
      anchorPx: row.px_old,
      anchorTs: row.ts_old,
      windowLabel: LOOKBACK_SEC >= 120 ? `~${Math.round(LOOKBACK_SEC / 60)} мин (кратк.)` : `~${LOOKBACK_SEC}s`,
    });
  }
  if (roll != null && Number.isFinite(roll)) {
    candidates.push({
      pct: roll,
      anchorPx: row.px_old_roll!,
      anchorTs: row.ts_old_roll!,
      windowLabel: `~${ROLLING_MINUTES} мин (накопл.)`,
    });
  }
  const passed = candidates.filter((c) => Math.abs(c.pct) >= THRESHOLD_PCT);
  if (passed.length === 0) return null;
  return passed.reduce((a, b) => (Math.abs(b.pct) > Math.abs(a.pct) ? b : a));
}

/** Как в `src/live/mint-whitelist.ts` — клиент Telegram делает ссылку кликабельной. */
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

/** Точное значение расчёта (арифметика скрипта), со знаком. */
function formatSignedPct(pct: number): string {
  const v = pct.toFixed(2);
  return pct >= 0 ? `+${v}%` : `${v}%`;
}

type AlertRow = CandidateRow & {
  dex: string;
  pct: number;
  windowLabel: string;
  anchorPx: number;
  anchorTs: Date | string;
};

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
    `${tag} ${kindWord} <b>${escapeHtml(pctHuman)}</b> · окно: ${escapeHtml(row.windowLabel)}\n\n` +
    `${title}\n` +
    `<a href="${gmgnUrl}">${escapeHtml(mint)}</a>\n\n` +
    `dex: ${escapeHtml(row.dex)} · pair: ${escapeHtml(row.pair_address)}\n` +
    `holders: ${row.holder_count ?? '?'}\n` +
    `px ${row.anchorPx.toPrecision(6)} → ${row.px_now.toPrecision(6)} USD`;
  if (row.liq_usd != null && row.liq_usd > 0) body += `\nliq ~${Math.round(row.liq_usd)} USD`;
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
    `${tag} ${kindWord} ${formatSignedPct(row.pct)} · окно: ${row.windowLabel}\n\n` +
    `${title}\n` +
    `${mint}\n` +
    `GMGN: ${gmgnSolTokenUrl(mint)}\n\n` +
    `dex: ${row.dex} · pair: ${row.pair_address}\n` +
    `holders: ${row.holder_count ?? '?'}\n` +
    `px ${row.anchorPx.toPrecision(6)} → ${row.px_now.toPrecision(6)} USD`;
  if (row.liq_usd != null && row.liq_usd > 0) body += `\nliq ~${Math.round(row.liq_usd)} USD`;
  return body;
}

async function fetchCandidates(table: DexTable): Promise<CandidateRow[]> {
  const q = buildQuery(table);
  const r = await db.execute(dsql.raw(q));
  const rows = r as unknown as Record<string, unknown>[];
  const out: CandidateRow[] = [];
  for (const row of rows) {
    const mint = String(row.base_mint ?? '');
    if (!mint) continue;
    const pr = row.px_old_roll != null && row.px_old_roll !== '' ? Number(row.px_old_roll) : null;
    out.push({
      base_mint: mint,
      pair_address: String(row.pair_address ?? ''),
      px_now: Number(row.px_now),
      ts_now: row.ts_now as Date | string,
      px_old: Number(row.px_old),
      ts_old: row.ts_old as Date | string,
      px_old_roll: pr != null && Number.isFinite(pr) && pr > 0 ? pr : null,
      ts_old_roll: row.ts_old_roll as Date | string | null,
      symbol: row.symbol != null ? String(row.symbol) : null,
      token_name: row.token_name != null ? String(row.token_name) : null,
      holder_count: row.holder_count != null ? Number(row.holder_count) : null,
      liq_usd: row.liq_usd != null ? Number(row.liq_usd) : null,
    });
  }
  return out;
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
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    const errBody = await r.text();
    console.warn(
      '[market-spike-telegram-watch] sendMessage failed',
      r.status,
      errBody.slice(0, 400),
    );
  }
  return r.ok;
}

async function main(): Promise<void> {
  if (!TG_TOKEN || !TG_CHAT) {
    console.error(
      '[market-spike-telegram-watch] Skip: set SPIKE_ALERT_TELEGRAM_BOT_TOKEN and SPIKE_ALERT_TELEGRAM_CHAT_ID (не используйте прод TELEGRAM_* Live Oscar).',
    );
    process.exit(0);
  }

  const merged = new Map<string, AlertRow>();

  for (const table of SNAPSHOT_TABLES) {
    let rows: CandidateRow[];
    try {
      rows = await fetchCandidates(table);
    } catch (e) {
      console.warn(`[market-spike-telegram-watch] ${table} query failed`, String(e));
      continue;
    }
    const dex = dexLabel(table);
    for (const row of rows) {
      if (!(row.px_now > 0) || !(row.px_old > 0)) continue;
      const picked = pickPctFromAnchors(row);
      if (!picked) continue;

      const prev = merged.get(row.base_mint);
      if (!prev || Math.abs(picked.pct) > Math.abs(prev.pct)) {
        merged.set(row.base_mint, {
          ...row,
          dex,
          pct: picked.pct,
          windowLabel: picked.windowLabel,
          anchorPx: picked.anchorPx,
          anchorTs: picked.anchorTs,
        });
      }
    }
  }

  const cooldown = loadCooldown();
  const now = Date.now();
  let sent = 0;

  for (const [, row] of merged) {
    const dir = row.pct >= 0 ? 'up' : 'down';
    const key = `${row.base_mint}|${dir}`;
    if (COOLDOWN_MS > 0) {
      const last = cooldown[key] ?? 0;
      if (now - last < COOLDOWN_MS) continue;
    }

    const htmlBody = buildAlertHtml(row);

    if (DRY_RUN) {
      console.log('[DRY_RUN]', buildAlertPlain(row));
      continue;
    }

    const ok = await sendTelegram(htmlBody, 'HTML');
    if (ok) {
      sent++;
      if (COOLDOWN_MS > 0) cooldown[key] = now;
    } else {
      console.warn('[market-spike-telegram-watch] Telegram send failed for', row.base_mint.slice(0, 12));
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  if (COOLDOWN_MS > 0 && sent > 0) saveCooldown(cooldown);

  const rollLog = ROLLING_MINUTES > 0 ? ` rolling=${ROLLING_MINUTES}m` : ' rolling=off';
  console.log(
    `[market-spike-telegram-watch] done candidates=${merged.size} sent=${sent} threshold=±${THRESHOLD_PCT}% lookback=${LOOKBACK_SEC}s${rollLog} holders>=${MIN_HOLDERS} age>=${MIN_AGE_HOURS}h liq>=${MIN_LIQ_USD} vol5m>=${MIN_VOL_5M_USD}`,
  );
}

main().catch((e) => {
  console.error('[market-spike-telegram-watch] fatal', e);
  process.exit(1);
});
