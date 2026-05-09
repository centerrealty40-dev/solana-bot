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
/** Насколько глубоко искать «последний» снимок (сек); запас относительно lookback. */
const LATEST_FLOOR_SEC = Math.max(180, Math.min(3600, Math.ceil(LOOKBACK_SEC * 15)));

const THRESHOLD_PCT = Math.max(0.5, Math.min(80, envNum('SPIKE_ALERT_THRESHOLD_PCT', 5)));
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
  symbol: string | null;
  holder_count: number | null;
  liq_usd: number | null;
};

function buildQuery(table: DexTable): string {
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
  o.price_usd::double precision AS px_old,
  o.ts AS ts_old,
  t.symbol,
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
) o ON true
WHERE o.price_usd IS NOT NULL AND o.price_usd > 0
`;
}

async function fetchCandidates(table: DexTable): Promise<CandidateRow[]> {
  const q = buildQuery(table);
  const r = await db.execute(dsql.raw(q));
  const rows = r as unknown as Record<string, unknown>[];
  const out: CandidateRow[] = [];
  for (const row of rows) {
    const mint = String(row.base_mint ?? '');
    if (!mint) continue;
    out.push({
      base_mint: mint,
      pair_address: String(row.pair_address ?? ''),
      px_now: Number(row.px_now),
      ts_now: row.ts_now as Date | string,
      px_old: Number(row.px_old),
      ts_old: row.ts_old as Date | string,
      symbol: row.symbol != null ? String(row.symbol) : null,
      holder_count: row.holder_count != null ? Number(row.holder_count) : null,
      liq_usd: row.liq_usd != null ? Number(row.liq_usd) : null,
    });
  }
  return out;
}

async function sendTelegram(text: string): Promise<boolean> {
  if (!TG_TOKEN || !TG_CHAT) return false;
  const url = `https://api.telegram.org/bot${TG_TOKEN}/sendMessage`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: TG_CHAT,
      text,
      disable_web_page_preview: true,
    }),
  });
  return r.ok;
}

async function main(): Promise<void> {
  if (!TG_TOKEN || !TG_CHAT) {
    console.error(
      '[market-spike-telegram-watch] Skip: set SPIKE_ALERT_TELEGRAM_BOT_TOKEN and SPIKE_ALERT_TELEGRAM_CHAT_ID (не используйте прод TELEGRAM_* Live Oscar).',
    );
    process.exit(0);
  }

  const merged = new Map<string, CandidateRow & { dex: string; pct: number }>();

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
      const pct = (row.px_now / row.px_old - 1) * 100;
      if (!Number.isFinite(pct) || Math.abs(pct) < THRESHOLD_PCT) continue;

      const prev = merged.get(row.base_mint);
      if (!prev || Math.abs(pct) > Math.abs(prev.pct)) {
        merged.set(row.base_mint, { ...row, dex, pct });
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

    const sym = row.symbol?.trim() || '?';
    const kind = row.pct >= 0 ? 'spike_pump' : 'spike_dump';
    const tag = `[MARKET][${kind}]`;
    const winLabel = LOOKBACK_SEC >= 120 ? `~${Math.round(LOOKBACK_SEC / 60)} мин` : `~${LOOKBACK_SEC}s`;
    const body =
      `${tag} ${row.pct >= 0 ? 'Рост' : 'Пролив'} ~${Math.abs(row.pct).toFixed(2)}% за ${winLabel}\n` +
      `symbol: ${sym}\n` +
      `mint: ${row.base_mint}\n` +
      `dex: ${row.dex}  pair: ${row.pair_address}\n` +
      `holders: ${row.holder_count ?? '?'}\n` +
      `px ${row.px_old.toPrecision(6)} → ${row.px_now.toPrecision(6)} USD\n` +
      (row.liq_usd != null && row.liq_usd > 0 ? `liq ~${Math.round(row.liq_usd)} USD\n` : '');

    if (DRY_RUN) {
      console.log('[DRY_RUN]', body);
      continue;
    }

    const ok = await sendTelegram(body.trimEnd());
    if (ok) {
      sent++;
      if (COOLDOWN_MS > 0) cooldown[key] = now;
    } else {
      console.warn('[market-spike-telegram-watch] Telegram send failed for', row.base_mint.slice(0, 12));
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  if (COOLDOWN_MS > 0 && sent > 0) saveCooldown(cooldown);

  console.log(
    `[market-spike-telegram-watch] done candidates=${merged.size} sent=${sent} threshold=±${THRESHOLD_PCT}% lookback=${LOOKBACK_SEC}s holders>=${MIN_HOLDERS} age>=${MIN_AGE_HOURS}h liq>=${MIN_LIQ_USD} vol5m>=${MIN_VOL_5M_USD}`,
  );
}

main().catch((e) => {
  console.error('[market-spike-telegram-watch] fatal', e);
  process.exit(1);
});
