/**
 * Watch-only: по минутным снимкам DEX в Postgres ищем паттерн «рост ≥ X% от локального дна,
 * затем откат ≥ Y% от пика» при market cap ≥ Z USD → Telegram (отдельный бот/канал, RETRACE_ALERT_*).
 *
 * Не использует TELEGRAM_* / SPIKE_ALERT_* Live Oscar и market-spike-бота.
 *
 * Логика детектора (одна пара mint+pair, ряд баров по времени):
 *  — «дно» = минимум цены среди баров с индексами [0 .. j-1];
 *  — «пик» на баре j: цена на j ≥ (1 + MIN_PUMP_PCT/100) × дно, и j — точка глобального максимума на [vi .. k];
 *  — «откат» на баре k (k > j): цена на k ≤ (1 - MIN_RETRACE_PCT/100) × пик;
 *  — бар k (фиксация отката) не старше RETRACE_ALERT_MAX_EVENT_AGE_MINUTES относительно now.
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

const SCAN_MINUTES = Math.max(30, Math.min(240, Math.floor(envNum('RETRACE_ALERT_SCAN_MINUTES', 120))));
const LATEST_FLOOR_SEC = Math.max(600, Math.min(3600, SCAN_MINUTES * 60 + 300));

const MIN_MCAP_USD = Math.max(0, envNum('RETRACE_ALERT_MIN_MCAP_USD', 1_500_000));
const MIN_PUMP_PCT = Math.max(0.5, Math.min(200, envNum('RETRACE_ALERT_MIN_PUMP_PCT', 6)));
const MIN_RETRACE_PCT = Math.max(0.5, Math.min(200, envNum('RETRACE_ALERT_MIN_RETRACE_FROM_PEAK_PCT', 10)));

const MIN_HOLDERS = Math.max(0, envNum('RETRACE_ALERT_MIN_HOLDERS', 0));
const HOLDER_NULL_SOFT = envBool('RETRACE_ALERT_HOLDER_NULL_SOFT', true);
const MIN_AGE_HOURS = Math.max(0, envNum('RETRACE_ALERT_MIN_AGE_HOURS', 3));
const MAX_ROWS = Math.max(50, Math.min(5000, envNum('RETRACE_ALERT_MAX_ROWS_PER_TABLE', 800)));

const POLL_INTERVAL_MS_RAW = Math.floor(envNum('RETRACE_ALERT_POLL_INTERVAL_MS', 0));
const POLL_INTERVAL_MS =
  POLL_INTERVAL_MS_RAW <= 0 ? 0 : Math.max(5000, Math.min(600_000, POLL_INTERVAL_MS_RAW));
const POLL_SEND_DEDUPE_MS = Math.max(
  0,
  Math.min(3_600_000, Math.floor(envNum('RETRACE_ALERT_POLL_SEND_DEDUPE_MS', 120_000))),
);

const MINT_COOLDOWN_MINUTES = Math.max(
  0,
  Math.min(24 * 60, Math.floor(envNum('RETRACE_ALERT_MINT_COOLDOWN_MINUTES', 30))),
);
const MINT_COOLDOWN_MS = MINT_COOLDOWN_MINUTES * 60_000;

const MAX_EVENT_AGE_MIN = Math.max(
  1,
  Math.min(180, Math.floor(envNum('RETRACE_ALERT_MAX_EVENT_AGE_MINUTES', 15))),
);

const DRY_RUN = envBool('RETRACE_ALERT_DRY_RUN', false);
const DISPLAY_TZ = process.env.RETRACE_ALERT_DISPLAY_TZ?.trim() || 'Europe/Moscow';

const TG_TOKEN = process.env.RETRACE_ALERT_TELEGRAM_BOT_TOKEN?.trim() ?? '';
const TG_CHAT = process.env.RETRACE_ALERT_TELEGRAM_CHAT_ID?.trim() ?? '';

const ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,64}$/;

type Bar = { ts: Date; px: number; mcapUsd: number | null };

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

export type PumpRetracePick = {
  vi: number;
  j: number;
  k: number;
  valleyPx: number;
  peakPx: number;
  troughPx: number;
  pumpPct: number;
  retracePct: number;
};

function dexLabel(table: DexTable): string {
  return table.replace('_pair_snapshots', '');
}

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
  const mcapClause =
    MIN_MCAP_USD > 0
      ? `AND COALESCE(s.market_cap_usd, s.fdv_usd, t.fdv_usd, 0) >= ${MIN_MCAP_USD}`
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
 * Ищем последний (по k) валидный паттерн: дно на [0..j-1], пик на j, откат на k,
 * пик = max цены на [vi..k], рост от дна ≥ minPumpPct, падение от пика ≥ minRetracePct.
 * Бар k (момент фиксации отката) должен быть не старше maxEventAgeMin от nowMs.
 */
export function findPumpRetraceFromBars(
  rawBars: Bar[],
  minPumpPct: number,
  minRetracePct: number,
  nowMs: number,
  maxEventAgeMin: number,
): PumpRetracePick | null {
  const b = dedupeBarsSorted(rawBars);
  const n = b.length;
  if (n < 3) return null;
  const maxAgeMs = maxEventAgeMin * 60_000;

  for (let k = n - 1; k >= 2; k--) {
    const ageK = nowMs - b[k].ts.getTime();
    if (ageK < 0 || ageK > maxAgeMs) continue;

    const troughPx = b[k].px;
    if (!(troughPx > 0)) continue;

    for (let j = k - 1; j >= 1; j--) {
      const peakPx = b[j].px;
      if (!(peakPx > 0) || !(peakPx > troughPx)) continue;

      const retracePct = (1 - troughPx / peakPx) * 100;
      if (retracePct < minRetracePct - 1e-9) continue;

      let valley = Infinity;
      let vi = 0;
      for (let t = 0; t < j; t++) {
        if (b[t].px < valley) {
          valley = b[t].px;
          vi = t;
        }
      }
      if (!Number.isFinite(valley) || !(valley > 0)) continue;

      const pumpPct = (peakPx / valley - 1) * 100;
      if (pumpPct < minPumpPct - 1e-9) continue;

      let maxOnSegment = b[vi].px;
      for (let t = vi; t <= k; t++) {
        maxOnSegment = Math.max(maxOnSegment, b[t].px);
      }
      if (Math.abs(maxOnSegment - peakPx) > 1e-9 * Math.max(peakPx, 1e-12)) continue;

      return { vi, j, k, valleyPx: valley, peakPx, troughPx, pumpPct, retracePct };
    }
  }
  return null;
}

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

function formatSignedPct(pct: number): string {
  const v = pct.toFixed(2);
  return pct >= 0 ? `+${v}%` : `${v}%`;
}

type AlertRowWithTs = LatestMeta & {
  dex: string;
  pick: PumpRetracePick;
  rawBarsViTs: Date;
  rawBarsJTs: Date;
  rawBarsKTs: Date;
};

function buildAlertHtml(row: AlertRowWithTs): string {
  const mint = row.base_mint.trim();
  const p = row.pick;
  const sym = row.symbol?.trim() || '?';
  const nameRaw = row.token_name?.trim();
  const title =
    nameRaw && nameRaw !== sym
      ? `<b>${escapeHtml(sym)}</b>\n<i>${escapeHtml(nameRaw)}</i>`
      : `<b>${escapeHtml(sym)}</b>`;
  const gmgnUrl = gmgnSolTokenUrl(mint);

  const body =
    `[RETRACE][pump_then_pullback] рост ≥${MIN_PUMP_PCT}% и откат от пика ≥${MIN_RETRACE_PCT}%\n` +
    `рост от дна: <b>${escapeHtml(formatSignedPct(p.pumpPct))}</b> · откат от пика: <b>${escapeHtml(formatSignedPct(-p.retracePct))}</b>\n` +
    `дно ${formatDisplayHm(row.rawBarsViTs)} → пик ${formatDisplayHm(row.rawBarsJTs)} → текущий минимум после пика ${formatDisplayHm(row.rawBarsKTs)}\n\n` +
    `${title}\n` +
    `<a href="${gmgnUrl}">${escapeHtml(mint)}</a>\n\n` +
    `dex: ${escapeHtml(row.dex)} · pair: ${escapeHtml(row.pair_address)}\n` +
    `mcap filter: ≥ $${(MIN_MCAP_USD / 1e6).toFixed(2)}M (снимок/FDV в отборе latest)\n` +
    `<i>Мин. бары PG · ${DISPLAY_TZ}</i>`;

  return body;
}

function buildRowWithTs(meta: LatestMeta, dex: string, bars: Bar[], pick: PumpRetracePick): AlertRowWithTs {
  return {
    ...meta,
    dex,
    pick,
    rawBarsViTs: bars[pick.vi].ts,
    rawBarsJTs: bars[pick.j].ts,
    rawBarsKTs: bars[pick.k].ts,
  };
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
    console.warn('[retrace-alert-watch] sendMessage failed', res.status, errBody.slice(0, 400));
  }
  return res.ok;
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function pruneSendDedupe(map: Map<string, number>, olderThanMs: number): void {
  const cut = Date.now() - olderThanMs;
  for (const [k, t] of map) {
    if (t < cut) map.delete(k);
  }
}

function pruneMintCooldown(map: Map<string, number>): void {
  if (MINT_COOLDOWN_MS <= 0) return;
  const cut = Date.now() - MINT_COOLDOWN_MS * 2;
  for (const [k, t] of map) {
    if (t < cut) map.delete(k);
  }
}

async function runOnePass(
  sendDedupe: Map<string, number> | null,
  mintCooldown: Map<string, number> | null,
): Promise<void> {
  const merged = new Map<string, AlertRowWithTs>();

  for (const table of SNAPSHOT_TABLES) {
    let latestRows: LatestMeta[];
    try {
      latestRows = await fetchLatestOnly(table);
    } catch (e) {
      console.warn(`[retrace-alert-watch] ${table} latest query failed`, String(e));
      continue;
    }
    let barsByKey: Map<string, Bar[]>;
    try {
      barsByKey = await fetchBarsBatch(table, latestRows);
    } catch (e) {
      console.warn(`[retrace-alert-watch] ${table} bars query failed`, String(e));
      continue;
    }

    const dex = dexLabel(table);
    const nowMs = Date.now();

    for (const meta of latestRows) {
      const raw = barsByKey.get(barsMapKey(meta.base_mint, meta.pair_address)) ?? [];
      const pick = findPumpRetraceFromBars(raw, MIN_PUMP_PCT, MIN_RETRACE_PCT, nowMs, MAX_EVENT_AGE_MIN);
      if (!pick) continue;

      const bars = dedupeBarsSorted(raw);
      const row = buildRowWithTs(meta, dex, bars, pick);
      const prev = merged.get(meta.base_mint);
      if (
        !prev ||
        pick.retracePct > prev.pick.retracePct ||
        (Math.abs(pick.retracePct - prev.pick.retracePct) < 1e-9 &&
          row.rawBarsKTs.getTime() > prev.rawBarsKTs.getTime())
      ) {
        merged.set(meta.base_mint, row);
      }
    }
  }

  let sent = 0;
  if (sendDedupe && POLL_SEND_DEDUPE_MS > 0) {
    pruneSendDedupe(sendDedupe, POLL_SEND_DEDUPE_MS * 3);
  }
  if (mintCooldown && MINT_COOLDOWN_MS > 0) {
    pruneMintCooldown(mintCooldown);
  }

  for (const [, row] of merged) {
    const html = buildAlertHtml(row);
    if (DRY_RUN) {
      console.log('[DRY_RUN]', html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
      continue;
    }

    if (sendDedupe && POLL_SEND_DEDUPE_MS > 0) {
      const kTs = row.rawBarsKTs.toISOString();
      const dedupeKey = `${row.base_mint}|${row.dex}|${kTs}`;
      const last = sendDedupe.get(dedupeKey) ?? 0;
      if (Date.now() - last < POLL_SEND_DEDUPE_MS) continue;
    }

    const mintKey = row.base_mint.trim();
    if (mintCooldown && MINT_COOLDOWN_MS > 0) {
      const lastMint = mintCooldown.get(mintKey) ?? 0;
      if (Date.now() - lastMint < MINT_COOLDOWN_MS) continue;
    }

    const ok = await sendTelegram(html, 'HTML');
    if (ok) {
      sent++;
      if (sendDedupe && POLL_SEND_DEDUPE_MS > 0) {
        sendDedupe.set(`${row.base_mint}|${row.dex}|${row.rawBarsKTs.toISOString()}`, Date.now());
      }
      if (mintCooldown && MINT_COOLDOWN_MS > 0) {
        mintCooldown.set(mintKey, Date.now());
      }
    }
    await sleepMs(200);
  }

  const pollLog = POLL_INTERVAL_MS > 0 ? ` poll=${POLL_INTERVAL_MS}ms` : ' poll=off(cron)';
  console.log(
    `[retrace-alert-watch] done candidates=${merged.size} sent=${sent} mcap>=${MIN_MCAP_USD} pump>=${MIN_PUMP_PCT}% retrace>=${MIN_RETRACE_PCT}% scan=${SCAN_MINUTES}m eventAge<=${MAX_EVENT_AGE_MIN}m cooldownMin=${MINT_COOLDOWN_MINUTES}${pollLog}`,
  );
}

async function main(): Promise<void> {
  if (!TG_TOKEN || !TG_CHAT) {
    console.error(
      '[retrace-alert-watch] Skip: set RETRACE_ALERT_TELEGRAM_BOT_TOKEN and RETRACE_ALERT_TELEGRAM_CHAT_ID in .env (не используйте TELEGRAM_* Live Oscar).',
    );
    process.exit(0);
  }

  if (POLL_INTERVAL_MS > 0) {
    const sendDedupe = new Map<string, number>();
    const mintCooldown = MINT_COOLDOWN_MS > 0 ? new Map<string, number>() : null;
    console.log(
      `[retrace-alert-watch] poll mode interval=${POLL_INTERVAL_MS}ms dedupe=${POLL_SEND_DEDUPE_MS}ms`,
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
        console.warn('[retrace-alert-watch] cycle error', String(e));
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

  await runOnePass(null, MINT_COOLDOWN_MS > 0 ? new Map<string, number>() : null);
}

if (process.env.RETRACE_ALERT_SKIP_MAIN !== '1') {
  main().catch((e) => {
    console.error('[retrace-alert-watch] fatal', e);
    process.exit(1);
  });
}
