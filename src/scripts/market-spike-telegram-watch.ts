/**
 * Отдельный watch-only бот: резкий рост/пролив по снимкам DEX в Postgres → Telegram.
 *
 * Не использует TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID продового Live Oscar.
 * Только SPIKE_ALERT_TELEGRAM_* и только SELECT по таблицам снимков + tokens.
 *
 * Детекция: по каждому mint из свежей выборки поднимаем цепочку минутных баров за SPIKE_ALERT_SCAN_MINUTES
 * и ищем любую **соседнюю** пару баров с |Δ%| ≥ порога (пролив между двумя минутами не теряется,
 * если следующий прогон попал после записи обоих баров в PG). Дополнительно — накопление за
 * SPIKE_ALERT_ROLLING_MINUTES по первому/последнему бару в окне.
 *
 * SPIKE_ALERT_WINDOW_MIN / SPIKE_ALERT_LOOKBACK_SEC оставлены в коде через resolveLookbackSec только для
 * совместимости env; основной триггер — скан пар баров + rolling.
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
const ROLLING_MINUTES = Math.max(0, Math.min(120, Math.floor(envNum('SPIKE_ALERT_ROLLING_MINUTES', 3))));
/** Глубина истории баров для поиска резких скачков между соседними минутами. */
const SCAN_MINUTES = Math.max(15, Math.min(180, Math.floor(envNum('SPIKE_ALERT_SCAN_MINUTES', 60))));

/** Последний снимок mint должен быть не старше этого порога (сек). */
const LATEST_FLOOR_SEC = Math.max(
  600,
  Math.min(
    3600,
    Math.max(900, ROLLING_MINUTES > 0 ? ROLLING_MINUTES * 60 + 300 : 900),
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

type LatestMeta = {
  base_mint: string;
  pair_address: string;
  px_now: number;
  ts_now: Date | string;
  symbol: string | null;
  token_name: string | null;
  holder_count: number | null;
  liq_usd: number | null;
};

type Bar = { ts: Date; px: number };

type SpikePick = {
  pct: number;
  anchorPx: number;
  pxNow: number;
  anchorTs: Date;
  tsNew: Date;
  windowLabel: string;
};

function sqlMintArrayLiteral(mints: string[]): string {
  const uniq = [...new Set(mints)].filter((m) => /^[1-9A-HJ-NP-Za-km-z]{32,48}$/.test(m.trim()));
  if (!uniq.length) return 'ARRAY[]::text[]';
  return `ARRAY[${uniq.map((m) => `'${m.trim().replace(/'/g, "''")}'`).join(',')}]::text[]`;
}

function buildLatestOnlyQuery(table: DexTable): string {
  const liqClause =
    MIN_LIQ_USD > 0 ? `AND COALESCE(s.liquidity_usd, 0) >= ${MIN_LIQ_USD}` : '';
  const volClause =
    MIN_VOL_5M_USD > 0 ? `AND COALESCE(s.volume_5m, 0) >= ${MIN_VOL_5M_USD}` : '';
  return `
WITH latest AS (
  SELECT DISTINCT ON (s.base_mint)
    s.base_mint,
    s.pair_address,
    s.price_usd AS px_now,
    s.ts AS ts_now,
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
  t.symbol,
  t.name AS token_name,
  t.holder_count,
  l.liq_usd::double precision AS liq_usd
FROM latest l
INNER JOIN tokens t ON t.mint = l.base_mint`;
}

function buildBarsQuery(table: DexTable, mintsSql: string): string {
  return `
SELECT base_mint::text, ts, price_usd::double precision AS price_usd
FROM ${table}
WHERE base_mint = ANY(${mintsSql})
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

function formatUtcHm(d: Date): string {
  return d.toISOString().slice(11, 16) + ' UTC';
}

function pickRollingFromBars(bars: Bar[]): SpikePick | null {
  if (ROLLING_MINUTES <= 0 || bars.length < 2) return null;
  const newest = bars[bars.length - 1];
  const cutoffMs = Date.now() - ROLLING_MINUTES * 60_000;
  let anchor: Bar | null = null;
  for (let i = bars.length - 1; i >= 0; i--) {
    if (bars[i].ts.getTime() <= cutoffMs) {
      anchor = bars[i];
      break;
    }
  }
  if (!anchor || !(anchor.px > 0) || !(newest.px > 0)) return null;
  if (anchor.ts.getTime() >= newest.ts.getTime()) return null;
  const pct = (newest.px / anchor.px - 1) * 100;
  if (!Number.isFinite(pct) || Math.abs(pct) < THRESHOLD_PCT) return null;
  return {
    pct,
    anchorPx: anchor.px,
    pxNow: newest.px,
    anchorTs: anchor.ts,
    tsNew: newest.ts,
    windowLabel: `~${ROLLING_MINUTES} мин (накопл.)`,
  };
}

function pickConsecutiveBarSpike(bars: Bar[]): SpikePick | null {
  if (bars.length < 2) return null;
  let best: SpikePick | null = null;
  for (let i = 1; i < bars.length; i++) {
    const older = bars[i - 1];
    const newer = bars[i];
    if (!(older.px > 0) || !(newer.px > 0)) continue;
    const pct = (newer.px / older.px - 1) * 100;
    if (!Number.isFinite(pct) || Math.abs(pct) < THRESHOLD_PCT) continue;
    const cand: SpikePick = {
      pct,
      anchorPx: older.px,
      pxNow: newer.px,
      anchorTs: older.ts,
      tsNew: newer.ts,
      windowLabel: `мин. ${formatUtcHm(older.ts)}→${formatUtcHm(newer.ts)}`,
    };
    if (!best || Math.abs(cand.pct) > Math.abs(best.pct)) best = cand;
  }
  return best;
}

function analyzeBarsForMint(rawBars: Bar[]): SpikePick | null {
  const bars = dedupeBarsSorted(rawBars);
  const c1 = pickConsecutiveBarSpike(bars);
  const c2 = pickRollingFromBars(bars);
  if (!c1) return c2;
  if (!c2) return c1;
  return Math.abs(c2.pct) > Math.abs(c1.pct) ? c2 : c1;
}

function cooldownEventKey(mint: string, dir: 'up' | 'down', tsNew: Date): string {
  return `${mint}|${dir}|${tsNew.toISOString()}`;
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

type AlertRow = LatestMeta & {
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

async function fetchLatestOnly(table: DexTable): Promise<LatestMeta[]> {
  const q = buildLatestOnlyQuery(table);
  const r = await db.execute(dsql.raw(q));
  const rows = r as unknown as Record<string, unknown>[];
  const out: LatestMeta[] = [];
  for (const row of rows) {
    const mint = String(row.base_mint ?? '');
    if (!mint) continue;
    out.push({
      base_mint: mint,
      pair_address: String(row.pair_address ?? ''),
      px_now: Number(row.px_now),
      ts_now: row.ts_now as Date | string,
      symbol: row.symbol != null ? String(row.symbol) : null,
      token_name: row.token_name != null ? String(row.token_name) : null,
      holder_count: row.holder_count != null ? Number(row.holder_count) : null,
      liq_usd: row.liq_usd != null ? Number(row.liq_usd) : null,
    });
  }
  return out;
}

async function fetchBarsBatch(table: DexTable, mints: string[]): Promise<Map<string, Bar[]>> {
  const map = new Map<string, Bar[]>();
  if (mints.length === 0) return map;
  const mintsSql = sqlMintArrayLiteral(mints);
  const q = buildBarsQuery(table, mintsSql);
  const r = await db.execute(dsql.raw(q));
  const rows = r as unknown as Record<string, unknown>[];
  for (const row of rows) {
    const mint = String(row.base_mint ?? '');
    const px = Number(row.price_usd);
    if (!mint || !(px > 0)) continue;
    const ts = parseTs(row.ts as Date | string);
    const arr = map.get(mint) ?? [];
    arr.push({ ts, px });
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

async function main(): Promise<void> {
  if (!TG_TOKEN || !TG_CHAT) {
    console.error(
      '[market-spike-telegram-watch] Skip: set SPIKE_ALERT_TELEGRAM_BOT_TOKEN and SPIKE_ALERT_TELEGRAM_CHAT_ID (не используйте прод TELEGRAM_* Live Oscar).',
    );
    process.exit(0);
  }

  const merged = new Map<string, AlertRow>();

  for (const table of SNAPSHOT_TABLES) {
    let latestRows: LatestMeta[];
    try {
      latestRows = await fetchLatestOnly(table);
    } catch (e) {
      console.warn(`[market-spike-telegram-watch] ${table} latest query failed`, String(e));
      continue;
    }
    const mints = latestRows.map((r) => r.base_mint);
    let barsByMint: Map<string, Bar[]>;
    try {
      barsByMint = await fetchBarsBatch(table, mints);
    } catch (e) {
      console.warn(`[market-spike-telegram-watch] ${table} bars query failed`, String(e));
      continue;
    }

    const dex = dexLabel(table);
    for (const meta of latestRows) {
      const bars = barsByMint.get(meta.base_mint) ?? [];
      const pick = analyzeBarsForMint(bars);
      if (!pick) continue;

      const row: AlertRow = {
        ...meta,
        dex,
        pct: pick.pct,
        px_now: pick.pxNow,
        ts_now: pick.tsNew,
        windowLabel: pick.windowLabel,
        anchorPx: pick.anchorPx,
        anchorTs: pick.anchorTs,
      };

      const prev = merged.get(meta.base_mint);
      if (!prev || Math.abs(pick.pct) > Math.abs(prev.pct)) merged.set(meta.base_mint, row);
    }
  }

  const cooldown = loadCooldown();
  const now = Date.now();
  let sent = 0;

  for (const [, row] of merged) {
    const dir: 'up' | 'down' = row.pct >= 0 ? 'up' : 'down';
    const tsNew = parseTs(row.ts_now as Date | string);
    const eventKey = cooldownEventKey(row.base_mint, dir, tsNew);
    if (COOLDOWN_MS > 0) {
      const last = cooldown[eventKey] ?? 0;
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
      if (COOLDOWN_MS > 0) cooldown[eventKey] = now;
    } else {
      console.warn('[market-spike-telegram-watch] Telegram send failed for', row.base_mint.slice(0, 12));
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  if (COOLDOWN_MS > 0 && sent > 0) saveCooldown(cooldown);

  const rollLog = ROLLING_MINUTES > 0 ? ` rolling=${ROLLING_MINUTES}m` : ' rolling=off';
  console.log(
    `[market-spike-telegram-watch] done candidates=${merged.size} sent=${sent} threshold=±${THRESHOLD_PCT}% scan=${SCAN_MINUTES}m${rollLog} legacy_lookback_sec=${LOOKBACK_SEC} holders>=${MIN_HOLDERS} age>=${MIN_AGE_HOURS}h`,
  );
}

main().catch((e) => {
  console.error('[market-spike-telegram-watch] fatal', e);
  process.exit(1);
});
