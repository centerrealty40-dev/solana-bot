/**
 * Live Paper-Trader Dashboard
 *
 * - Читает /tmp/paper-trades.jsonl на каждый запрос /api/state
 * - Восстанавливает open / closed / metrics
 * - Догружает текущий market cap для open позиций с pump.fun (с кэшем 30s)
 * - Отдаёт статичный HTML dashboard на /
 *
 * Запуск:
 *   PORT=3007 tsx scripts-tmp/dashboard-server.ts
 *
 * Nginx прокидывает laivy.ru → http://127.0.0.1:3007
 */
import 'dotenv/config';
import crypto from 'node:crypto';
import Fastify from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetch } from 'undici';
import postgres from 'postgres';
import { lamportsFromGetBalanceResult, qnUsageSnapshot } from '../src/core/rpc/qn-client.js';
import { buildPriorityFeeMonitorApiPayload } from '../src/papertrader/pricing/priority-fee.js';
import { startQuickNodeUsageReporting } from '../src/stream/quicknode-usage-loop.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT ?? 3007);
const HOST = process.env.HOST ?? '0.0.0.0';
const STORE_PATH = process.env.STORE_PATH ?? '/tmp/paper-trades.jsonl';
/** Cursor file только для журнала организатора (не путать с другими стратегиями в той же папке). */
function isOrganizerPaperStorePath(p: string): boolean {
  const b = path.basename(p).toLowerCase();
  return b === 'organizer-paper.jsonl' || (b.startsWith('organizer') && b.endsWith('.jsonl'));
}

function resolvedOrgCursorPath(): string | null {
  if (!isOrganizerPaperStorePath(STORE_PATH)) return null;
  return (
    process.env.DASHBOARD_ORG_CURSOR_PATH?.trim() ||
    path.join(path.dirname(STORE_PATH), 'runner-organizer-paper-cursor.txt')
  );
}
const HTML_PATH = path.join(__dirname, 'dashboard.html');
const VISITS_PATH = process.env.VISITS_PATH ?? '/tmp/dashboard-visits.jsonl';
const PAPER2_DIR = process.env.PAPER2_DIR ?? '/opt/solana-alpha/data/paper2';
/** Live Oscar JSONL for /api/paper2 first panel (W8.0-p4 dashboard); never scan from PAPER2_DIR. */
const DASHBOARD_LIVE_OSCAR_JSONL =
  process.env.DASHBOARD_LIVE_OSCAR_JSONL?.trim() ||
  path.resolve(PAPER2_DIR, '..', 'live', 'pt1-oscar-live.jsonl');
const HTML2_PATH = path.join(__dirname, 'dashboard-paper2.html');
const HTML_SMLOT_PATH = path.join(__dirname, 'dashboard-smart-lottery.html');
/** Paper Smart Lottery JSONL — excluded from `/api/paper2` scan; own `/api/smart-lottery`. */
const DASHBOARD_SMLOT_JSONL =
  process.env.DASHBOARD_SMLOT_JSONL?.trim() || path.join(PAPER2_DIR, 'pt1-smart-lottery.jsonl');
const POSITION_USD_DEFAULT = Number(process.env.POSITION_USD ?? 100);

/** VPS live-only: не сканировать paper2-журналы и не раздувать `/papertrader2` пустыми pt1-колонками. */
function dashboardPaper2LiveOscarOnly(): boolean {
  const v = (process.env.DASHBOARD_PAPER2_LIVE_OSCAR_ONLY ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

function listPaper2StrategyJournalPaths(): string[] {
  if (dashboardPaper2LiveOscarOnly()) return [];
  try {
    if (!fs.existsSync(PAPER2_DIR)) return [];
    return fs
      .readdirSync(PAPER2_DIR)
      .filter((f) => f.endsWith('.jsonl'))
      .filter((f) => f !== 'pt1-oscar-live.jsonl')
      .filter((f) => f !== 'pt1-smart-lottery.jsonl')
      .map((f) => path.join(PAPER2_DIR, f));
  } catch {
    return [];
  }
}

let pgSql: ReturnType<typeof postgres> | null = null;
function pgPool(): ReturnType<typeof postgres> {
  const url = process.env.SA_PG_DSN || process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'SA_PG_DSN or DATABASE_URL is required for /api/stream/health, /api/parser/health, /api/atlas/health',
    );
  }
  if (!pgSql) {
    pgSql = postgres(url, { max: 2, idle_timeout: 20 });
  }
  return pgSql;
}

interface OpenTrade {
  mint: string;
  symbol: string;
  entryTs: number;
  entryMcUsd: number;
  peakMcUsd: number;
  peakPnlPct: number;
  trailingArmed: boolean;
  entryMetrics?: any;
}
interface ClosedTrade extends OpenTrade {
  exitTs: number;
  exitMcUsd: number;
  exitReason: 'TP' | 'SL' | 'TRAIL' | 'TIMEOUT' | 'NO_DATA' | 'FAST_DUMP' | 'LIQ_DROP' | 'FLAT_LOSS';
  pnlPct: number;
  durationMin: number;
}

// ---------------------------------------------------------
// market cap cache (pump.fun frontend api)
// ---------------------------------------------------------
const mcCache = new Map<string, { mc: number; ts: number }>();
const MC_TTL_MS = 30_000;

async function getCurrentMc(mint: string): Promise<number | null> {
  const cached = mcCache.get(mint);
  if (cached && Date.now() - cached.ts < MC_TTL_MS) return cached.mc;
  try {
    const r = await fetch(`https://frontend-api-v3.pump.fun/coins/${mint}`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(4000),
    });
    if (!r.ok) return null;
    const j: any = await r.json();
    const mc = Number(j?.usd_market_cap ?? 0);
    if (mc > 0) {
      mcCache.set(mint, { mc, ts: Date.now() });
      return mc;
    }
  } catch {
    /* ignore */
  }
  return null;
}

// ---------------------------------------------------------
// live mcap fallback: read most recent row from *_pair_snapshots
// (used for AMM mints where pump.fun frontend returns nothing)
// ---------------------------------------------------------
const dexMcCache = new Map<string, { mc: number; ts: number }>();
const DEX_MC_TTL_MS = 30_000;
const DEX_SNAPSHOT_TABLES = [
  'raydium_pair_snapshots',
  'meteora_pair_snapshots',
  'orca_pair_snapshots',
  'moonshot_pair_snapshots',
  'pumpswap_pair_snapshots',
] as const;

/** W7.5 — align with paper-trader `PAPER_LIQ_WATCH_SNAPSHOT_MAX_AGE_MS` for live liq badge freshness. */
const PAPER2_LIQ_SNAPSHOT_MAX_AGE_MS = Number(process.env.PAPER_LIQ_WATCH_SNAPSHOT_MAX_AGE_MS ?? 120_000);

/**
 * Latest pool `liquidity_usd` for dashboard open rows (same tables as executor liq-watch).
 */
async function fetchPairLiquidityUsdFromPg(
  pairAddress: string | null | undefined,
  source: string | null | undefined,
): Promise<number | null> {
  const pa = pairAddress?.trim();
  if (!pa) return null;
  const src = (source || 'raydium').toLowerCase();
  let sqlPg: ReturnType<typeof postgres>;
  try {
    sqlPg = pgPool();
  } catch {
    return null;
  }
  const maxAge =
    Number.isFinite(PAPER2_LIQ_SNAPSHOT_MAX_AGE_MS) && PAPER2_LIQ_SNAPSHOT_MAX_AGE_MS > 0
      ? PAPER2_LIQ_SNAPSHOT_MAX_AGE_MS
      : 120_000;
  const now = Date.now();
  try {
    let row: { liquidity_usd: unknown; ts: Date } | undefined;
    if (src === 'raydium') {
      const rows = await sqlPg<{ liquidity_usd: unknown; ts: Date }[]>`
        SELECT liquidity_usd, ts FROM raydium_pair_snapshots
        WHERE pair_address = ${pa}
        ORDER BY ts DESC LIMIT 1
      `;
      row = rows[0];
    } else if (src === 'meteora') {
      const rows = await sqlPg<{ liquidity_usd: unknown; ts: Date }[]>`
        SELECT liquidity_usd, ts FROM meteora_pair_snapshots
        WHERE pair_address = ${pa}
        ORDER BY ts DESC LIMIT 1
      `;
      row = rows[0];
    } else if (src === 'orca') {
      const rows = await sqlPg<{ liquidity_usd: unknown; ts: Date }[]>`
        SELECT liquidity_usd, ts FROM orca_pair_snapshots
        WHERE pair_address = ${pa}
        ORDER BY ts DESC LIMIT 1
      `;
      row = rows[0];
    } else if (src === 'moonshot') {
      const rows = await sqlPg<{ liquidity_usd: unknown; ts: Date }[]>`
        SELECT liquidity_usd, ts FROM moonshot_pair_snapshots
        WHERE pair_address = ${pa}
        ORDER BY ts DESC LIMIT 1
      `;
      row = rows[0];
    } else if (src === 'pumpswap') {
      const rows = await sqlPg<{ liquidity_usd: unknown; ts: Date }[]>`
        SELECT liquidity_usd, ts FROM pumpswap_pair_snapshots
        WHERE pair_address = ${pa}
        ORDER BY ts DESC LIMIT 1
      `;
      row = rows[0];
    } else {
      return null;
    }
    if (!row) return null;
    const ageMs = Math.max(0, now - new Date(row.ts).getTime());
    if (ageMs > maxAge) return null;
    const liq = row.liquidity_usd != null ? Number(row.liquidity_usd) : NaN;
    return Number.isFinite(liq) && liq > 0 ? liq : null;
  } catch {
    return null;
  }
}

/** Solana base58 mint — safe single-quoted literal for raw SQL fragments. */
function sqlMintQuoted(mint: string): string | null {
  if (!mint || mint.length > 64) return null;
  if (!/^[1-9A-HJ-NP-Za-km-z]+$/.test(mint)) return null;
  return `'${mint.replace(/'/g, "''")}'`;
}

/** Pool row may index the traded mint as base or quote depending on collector/orientation. */
function sqlMintPoolMatch(mq: string): string {
  return `(base_mint = ${mq} OR quote_mint = ${mq})`;
}

const jupPxCache = new Map<string, { px: number; ts: number }>();
const JUP_PX_TTL_MS = 15_000;

/** Jupiter v3 — same family as v1-style dashboards when PG pair rows lag or miss the mint side. */
async function getJupiterTokenPriceUsd(mint: string): Promise<number | null> {
  if (!sqlMintQuoted(mint)) return null;
  const hit = jupPxCache.get(mint);
  if (hit && Date.now() - hit.ts < JUP_PX_TTL_MS) return hit.px;
  try {
    const r = await fetch(`https://lite-api.jup.ag/price/v3?ids=${encodeURIComponent(mint)}`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) return null;
    const j = (await r.json()) as Record<string, { usdPrice?: number }> & {
      data?: Record<string, { price?: number }>;
    };
    const px = Number(j[mint]?.usdPrice ?? j?.data?.[mint]?.price ?? 0);
    if (px > 0 && Number.isFinite(px)) {
      jupPxCache.set(mint, { px, ts: Date.now() });
      return px;
    }
  } catch {
    /* ignore */
  }
  return null;
}

function entryMcapFromOpenTimelineEvent(tl: TimelineEvent[]): number | null {
  const ev = tl.find((e) => e.kind === 'open');
  const n = Number(ev?.mcUsd ?? 0);
  return n > 0 && Number.isFinite(n) ? n : null;
}

function exitMcapFromCloseTimelineEvent(tl: TimelineEvent[]): number | null {
  const closes = tl.filter((e) => e.kind === 'close');
  const last = closes[closes.length - 1];
  const n = Number(last?.mcUsd ?? 0);
  return n > 0 && Number.isFinite(n) ? n : null;
}

async function resolveEntryMcapAtBuyUsd(
  mint: string,
  entryTs: number,
  timelineSorted: TimelineEvent[],
): Promise<number | null> {
  const fromTl = entryMcapFromOpenTimelineEvent(timelineSorted);
  if (fromTl != null) return fromTl;
  if (entryTs > 0) return await getDexMcapNearestBefore(mint, entryTs).catch(() => null);
  return null;
}

async function getDexLiveMc(mint: string): Promise<number | null> {
  const cached = dexMcCache.get(mint);
  if (cached && Date.now() - cached.ts < DEX_MC_TTL_MS) return cached.mc;
  const mq = sqlMintQuoted(mint);
  if (!mq) return null;
  let sql: ReturnType<typeof postgres>;
  try {
    sql = pgPool();
  } catch {
    return null;
  }
  // Same window as spot reads — collectors can be sparse on illiquid pools.
  const subqueries = DEX_SNAPSHOT_TABLES.map(
    (t) => `
      SELECT ts, market_cap_usd, fdv_usd FROM ${t}
      WHERE ${sqlMintPoolMatch(mq)} AND ts >= now() - interval '7 days'
        AND (COALESCE(market_cap_usd, 0) > 0 OR COALESCE(fdv_usd, 0) > 0)
      ORDER BY ts DESC LIMIT 1
    `,
  ).join(' UNION ALL ');
  try {
    const rows = await sql.unsafe(
      `SELECT ts, market_cap_usd, fdv_usd FROM (${subqueries}) sub ORDER BY ts DESC LIMIT 1`,
    );
    if (!rows.length) return null;
    const mc = Number(rows[0].market_cap_usd ?? rows[0].fdv_usd ?? 0);
    if (mc > 0) {
      dexMcCache.set(mint, { mc, ts: Date.now() });
      return mc;
    }
  } catch {
    /* table may be missing in some envs — silently ignore */
  }
  return null;
}

/** Per-(mint, event-second) cache for timeline mcap back-fill only. */
const timelineEventMcapCache = new Map<string, number | null | undefined>();
function getDexMcapNearestBeforeCached(mint: string, beforeMs: number): Promise<number | null> {
  const k = `${mint}\t${Math.floor(beforeMs / 1000)}`;
  if (timelineEventMcapCache.has(k)) return Promise.resolve(timelineEventMcapCache.get(k) ?? null);
  return getDexMcapNearestBefore(mint, beforeMs)
    .then((v) => {
      timelineEventMcapCache.set(k, v);
      return v;
    })
    .catch(() => {
      timelineEventMcapCache.set(k, null);
      return null;
    });
}

async function getDexMcapNearestBefore(mint: string, beforeMs: number): Promise<number | null> {
  const mq = sqlMintQuoted(mint);
  if (!mq) return null;
  const epochSec = Math.floor(beforeMs / 1000);
  if (!Number.isFinite(epochSec) || epochSec <= 0) return null;
  let sql: ReturnType<typeof postgres>;
  try {
    sql = pgPool();
  } catch {
    return null;
  }
  const subqueries = DEX_SNAPSHOT_TABLES.map(
    (t) => `
      SELECT ts, market_cap_usd, fdv_usd FROM ${t}
      WHERE ${sqlMintPoolMatch(mq)}
        AND extract(epoch from ts) <= ${epochSec}
        AND (COALESCE(market_cap_usd, 0) > 0 OR COALESCE(fdv_usd, 0) > 0)
      ORDER BY ts DESC LIMIT 1
    `,
  ).join(' UNION ALL ');
  try {
    const rows = await sql.unsafe(
      `SELECT ts, market_cap_usd, fdv_usd FROM (${subqueries}) sub ORDER BY ts DESC LIMIT 1`,
    );
    if (!rows.length) return null;
    const mc = Number(rows[0].market_cap_usd ?? rows[0].fdv_usd ?? 0);
    return mc > 0 ? mc : null;
  } catch {
    return null;
  }
}

/**
 * repair / same-ms JSONL: spurious dca_add right after open (same ts, +0% trigger, same notional) — drop from UI.
 */
export function filterSpuriousDcaOpenDuplicate(timeline: TimelineEvent[]): TimelineEvent[] {
  const out: TimelineEvent[] = [];
  for (const ev of timeline) {
    if (ev.kind === 'dca_add' && out.length) {
      const prev = out[out.length - 1]!;
      if (prev.kind === 'open' && ev.ts === prev.ts) {
        const lab = String(ev.label || '');
        if (/уровень\s*\+0%|уровень\s*0%|\+0%\s*\(от первой ноги\)/.test(lab)) {
          const a0 = Number(prev.amountUsd ?? 0);
          const a1 = Number(ev.amountUsd ?? 0);
          if (a0 > 0 && a1 > 0 && Math.abs(a0 - a1) / Math.max(a0, a1) < 0.02) {
            continue;
          }
        }
      }
    }
    out.push(ev);
  }
  return out;
}

export async function enrichTimelineMcapGaps(
  mint: string,
  timeline: TimelineEvent[],
  maxEvents = 32,
): Promise<TimelineEvent[]> {
  if (!mint?.trim()) return timeline;
  const n = Math.min(timeline.length, maxEvents);
  const head = await Promise.all(
    timeline.slice(0, n).map(async (ev) => {
      if (Number(ev.mcUsd) > 0) return ev;
      const mc = await getDexMcapNearestBeforeCached(mint, ev.ts);
      if (mc != null && mc > 0) return { ...ev, mcUsd: mc };
      return ev;
    }),
  );
  return n < timeline.length ? head.concat(timeline.slice(n)) : head;
}

const tokenSymbolByMint = new Map<string, { s: string; at: number }>();
const TOKEN_SYMBOL_TTL_MS = 6 * 3_600_000;

/** When journal has `?` (repair / missing metadata), resolve from DexScreener token API. */
async function resolveTokenSymbolForUi(mint: string, fromJournal: string | null | undefined): Promise<string> {
  const t0 = (fromJournal ?? '').trim();
  if (t0 && t0 !== '?' && t0.length > 0) return t0.slice(0, 32);
  const c = tokenSymbolByMint.get(mint);
  if (c && Date.now() - c.at < TOKEN_SYMBOL_TTL_MS) return c.s;
  try {
    const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(mint)}`, {
      signal: AbortSignal.timeout(7000),
    });
    if (!r.ok) return t0 || '?';
    const j = (await r.json()) as { pairs?: { baseToken?: { symbol?: string } }[] };
    const p = j?.pairs?.[0];
    const sym = String(p?.baseToken?.symbol || '').trim();
    if (sym) {
      tokenSymbolByMint.set(mint, { s: sym, at: Date.now() });
      return sym.slice(0, 32);
    }
  } catch {
    /* optional */
  }
  return t0 && t0 !== '?' ? t0 : '?';
}

async function getCurrentMcAny(mint: string): Promise<number | null> {
  const pump = await getCurrentMc(mint);
  if (pump != null) return pump;
  return await getDexLiveMc(mint);
}

/** Latest token USD spot price from DEX snapshots (AMM strategies use metricType=price). */
const dexPxCache = new Map<string, { px: number; ts: number }>();
const DEX_PX_TTL_MS = 30_000;

async function getDexLivePrice(mint: string, source: string | null): Promise<number | null> {
  const cacheKey = `${mint}|${source || 'any'}`;
  const cached = dexPxCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < DEX_PX_TTL_MS) return cached.px;
  const mq = sqlMintQuoted(mint);
  if (!mq) return null;
  let sql: ReturnType<typeof postgres>;
  try {
    sql = pgPool();
  } catch {
    return null;
  }
  const sources: readonly string[] = ['raydium', 'meteora', 'orca', 'moonshot', 'pumpswap'];
  const tableOrder =
    source && sources.includes(source) ? [`${source}_pair_snapshots`, ...sources.filter((s) => s !== source).map((s) => `${s}_pair_snapshots`)] : DEX_SNAPSHOT_TABLES.slice();
  /** Wider than mcap cache: pair collectors can lag; UI only needs a reasonable reference. */
  const subqueries = tableOrder.map(
    (t) => `
      SELECT ts, price_usd FROM ${t}
      WHERE ${sqlMintPoolMatch(mq)} AND ts >= now() - interval '7 days'
        AND price_usd IS NOT NULL AND price_usd > 0
      ORDER BY ts DESC LIMIT 1
    `,
  ).join(' UNION ALL ');
  try {
    const rows = await sql.unsafe(
      `SELECT ts, price_usd FROM (${subqueries}) sub ORDER BY ts DESC LIMIT 1`,
    );
    if (!rows.length) return null;
    const px = Number(rows[0].price_usd ?? 0);
    if (px > 0) {
      dexPxCache.set(cacheKey, { px, ts: Date.now() });
      return px;
    }
  } catch {
    /* swallow */
  }
  return null;
}

// ---------------------------------------------------------
// store reader
// ---------------------------------------------------------
function loadStore(): { open: OpenTrade[]; closed: ClosedTrade[]; firstTs: number; lastTs: number } {
  if (!fs.existsSync(STORE_PATH)) {
    return { open: [], closed: [], firstTs: Date.now(), lastTs: Date.now() };
  }
  const lines = fs.readFileSync(STORE_PATH, 'utf-8').split('\n').filter(Boolean);
  const openMap = new Map<string, OpenTrade>();
  const closed: ClosedTrade[] = [];
  let firstTs = Date.now();
  let lastTs = 0;

  for (const ln of lines) {
    let e: any;
    try {
      e = JSON.parse(ln);
    } catch {
      continue;
    }
    if (e.ts) {
      if (e.ts < firstTs) firstTs = e.ts;
      if (e.ts > lastTs) lastTs = e.ts;
    }
    if (e.kind === 'open') {
      openMap.set(e.mint, {
        mint: e.mint,
        symbol: e.symbol,
        entryTs: e.entryTs,
        entryMcUsd: e.entryMcUsd,
        peakMcUsd: e.entryMcUsd,
        peakPnlPct: 0,
        trailingArmed: false,
        entryMetrics: e.entryMetrics,
      });
    } else if (e.kind === 'peak' && openMap.has(e.mint)) {
      const ot = openMap.get(e.mint)!;
      ot.peakMcUsd = Math.max(ot.peakMcUsd, e.peakMcUsd ?? 0);
      ot.peakPnlPct = Math.max(ot.peakPnlPct, e.peakPnlPct ?? 0);
      ot.trailingArmed = ot.trailingArmed || !!e.trailingArmed;
    } else if (e.kind === 'close') {
      openMap.delete(e.mint);
      closed.push(e as ClosedTrade);
    }
  }
  return { open: [...openMap.values()], closed, firstTs, lastTs };
}

interface StoreMeta {
  storePath: string;
  exists: boolean;
  bytes: number;
  lineCount: number;
  mtimeIso: string | null;
  /** runner-organizer paper cursor (bigint id), only when journal is organizer-paper*.jsonl */
  paperCursorSignalId: string | null;
  /** Whether organizer cursor path applies to this STORE_PATH */
  organizerJournal: boolean;
  /** Count of JSONL rows by top-level `kind` (best-effort scan) */
  kindCounts: Record<string, number>;
  /** Short explanation: wired vs empty backlog vs waiting for signals */
  hint: string;
}

function computeStoreMeta(): StoreMeta {
  const storePath = path.resolve(STORE_PATH);
  const orgJournal = isOrganizerPaperStorePath(STORE_PATH);
  const out: StoreMeta = {
    storePath,
    exists: false,
    bytes: 0,
    lineCount: 0,
    mtimeIso: null,
    paperCursorSignalId: null,
    organizerJournal: orgJournal,
    kindCounts: {},
    hint: '',
  };
  const cursorPath = resolvedOrgCursorPath();
  try {
    if (cursorPath && fs.existsSync(cursorPath)) {
      const c = fs.readFileSync(cursorPath, 'utf8').trim();
      if (c && /^\d+$/.test(c)) out.paperCursorSignalId = c;
    }
  } catch {
    /* ignore */
  }

  try {
    if (!fs.existsSync(storePath)) {
      out.hint =
        'Файл журнала не найден по STORE_PATH — проверь путь или что бумажный PM2-процесс пишет в этот файл.';
      return out;
    }
    out.exists = true;
    const st = fs.statSync(storePath);
    out.bytes = st.size;
    out.mtimeIso = new Date(st.mtimeMs).toISOString();
    const raw = fs.readFileSync(storePath, 'utf8');
    const lines = raw.split('\n').filter((l) => l.trim().length > 0);
    out.lineCount = lines.length;
    for (const ln of lines) {
      try {
        const o = JSON.parse(ln) as { kind?: string };
        const k = typeof o.kind === 'string' ? o.kind : '_other';
        out.kindCounts[k] = (out.kindCounts[k] ?? 0) + 1;
      } catch {
        out.kindCounts._parse_error = (out.kindCounts._parse_error ?? 0) + 1;
      }
    }
    const opens = out.kindCounts.open ?? 0;
    const closes = out.kindCounts.close ?? 0;
    const evals = out.kindCounts.eval ?? 0;
    const evSkip =
      (out.kindCounts['eval-skip'] ?? 0) +
      (out.kindCounts['eval-skip-open'] ?? 0);

    if (out.lineCount === 0) {
      out.hint =
        'Журнал пуст — бумажный трейдер ещё не записал ни одной строки (или файл только что создан).';
    } else if (opens === 0 && closes === 0) {
      out.hint =
        orgJournal && out.paperCursorSignalId != null
          ? `Журнал живой (есть строки), но ещё не было paper open/close. Курсор организатора на сигнале id=${out.paperCursorSignalId}: обычно ждём новых строк в runner_organizer_signals с id выше курсора и прохождения гейтов (смотри eval / eval-skip в JSONL и лог PM2).`
          : 'Журнал живой, но ещё не было открытий/закрытий — возможны только eval/heartbeat; проверь фильтры PM2 и причины eval-skip.';
    } else {
      out.hint = `Журнал OK: открытий=${opens}, закрытий=${closes}, eval=${evals}.`;
    }
    if (orgJournal && evals + evSkip > 0 && opens === 0 && out.paperCursorSignalId) {
      out.hint += ` За кадром: eval=${evals}, eval-skip=${evSkip} — часть сигналов отфильтрована до входа.`;
    }
  } catch (e) {
    out.hint = `Ошибка чтения журнала: ${String(e)}`;
  }
  if (!out.hint) out.hint = 'Метаданные журнала без текста — см. lines/bytes.';
  return out;
}

// ---------------------------------------------------------
// metrics
// ---------------------------------------------------------
function computeMetrics(closed: ClosedTrade[]) {
  if (closed.length === 0) {
    return {
      total: 0, wins: 0, losses: 0, winRate: 0,
      sumPnl: 0, avgPnl: 0, avgPeak: 0, bestPnl: 0, worstPnl: 0,
      exits: { TP: 0, SL: 0, TRAIL: 0, TIMEOUT: 0, NO_DATA: 0, FAST_DUMP: 0, LIQ_DROP: 0, FLAT_LOSS: 0 },
      equityCurve: [] as { ts: number; cumPnl: number }[],
    };
  }
  const exits: Record<string, number> = { TP: 0, SL: 0, TRAIL: 0, TIMEOUT: 0, NO_DATA: 0, FAST_DUMP: 0, LIQ_DROP: 0, FLAT_LOSS: 0 };
  let sumPnl = 0;
  let sumPeak = 0;
  let wins = 0;
  let bestPnl = -Infinity;
  let worstPnl = Infinity;
  for (const c of closed) {
    sumPnl += c.pnlPct;
    sumPeak += c.peakPnlPct ?? 0;
    if (c.pnlPct > 0) wins++;
    if (c.pnlPct > bestPnl) bestPnl = c.pnlPct;
    if (c.pnlPct < worstPnl) worstPnl = c.pnlPct;
    exits[c.exitReason] = (exits[c.exitReason] ?? 0) + 1;
  }
  const sortedByExit = [...closed].sort((a, b) => a.exitTs - b.exitTs);
  let cum = 0;
  const equityCurve = sortedByExit.map(c => {
    cum += c.pnlPct;
    return { ts: c.exitTs, cumPnl: cum };
  });
  return {
    total: closed.length,
    wins,
    losses: closed.length - wins,
    winRate: (wins / closed.length) * 100,
    sumPnl,
    avgPnl: sumPnl / closed.length,
    avgPeak: sumPeak / closed.length,
    bestPnl,
    worstPnl,
    exits,
    equityCurve,
  };
}

// ---------------------------------------------------------
// fastify
// ---------------------------------------------------------
const app = Fastify({ logger: false });

// ---------------------------------------------------------
// HTTP Basic Auth (optional, opt-in via env)
//
// If DASHBOARD_BASIC_USER and DASHBOARD_BASIC_PASSWORD are set, every request
// except /api/health (used by external uptime monitors) requires correct
// HTTP Basic credentials. Empty / missing env disables auth (legacy behavior).
// ---------------------------------------------------------
const BASIC_USER = (process.env.DASHBOARD_BASIC_USER || '').trim();
const BASIC_PASS = (process.env.DASHBOARD_BASIC_PASSWORD || '').trim();
const BASIC_REALM = process.env.DASHBOARD_BASIC_REALM || 'Solana Alpha Dashboard';
const BASIC_AUTH_ENABLED = BASIC_USER.length > 0 && BASIC_PASS.length > 0;
const BASIC_AUTH_BYPASS = new Set<string>(['/api/health']);

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function parseBasicAuthHeader(header: string | undefined): { user: string; pass: string } | null {
  if (!header || !header.toLowerCase().startsWith('basic ')) return null;
  try {
    const decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8');
    const idx = decoded.indexOf(':');
    if (idx < 0) return null;
    return { user: decoded.slice(0, idx), pass: decoded.slice(idx + 1) };
  } catch {
    return null;
  }
}

/** После успешного входа — HttpOnly cookie; мобильные браузеры часто не прикрепляют Authorization к fetch(/api/…). */
const DASH_SESSION_COOKIE = 'sa_dash_sess';
const DASH_SESSION_MAX_AGE_SEC = 7 * 24 * 60 * 60;

function dashSessionSecret(): crypto.BinaryLike {
  const raw = (process.env.DASHBOARD_SESSION_SECRET || '').trim();
  if (raw.length >= 16) return raw;
  return crypto.createHash('sha256').update(`sa-dash-sess|${BASIC_USER}|${BASIC_PASS}`, 'utf8').digest();
}

function signDashSession(): string {
  const exp = Math.floor(Date.now() / 1000) + DASH_SESSION_MAX_AGE_SEC;
  const payload = `${BASIC_USER}:${exp}`;
  const mac = crypto.createHmac('sha256', dashSessionSecret()).update(payload).digest();
  const inner = `${payload}:${mac.toString('base64url')}`;
  return Buffer.from(inner, 'utf8').toString('base64url');
}

function verifyDashSession(token: string): boolean {
  try {
    const inner = Buffer.from(token, 'base64url').toString('utf8');
    const sigSep = inner.lastIndexOf(':');
    if (sigSep < 0) return false;
    const payload = inner.slice(0, sigSep);
    const sigStr = inner.slice(sigSep + 1);
    const userSep = payload.indexOf(':');
    if (userSep < 0) return false;
    const u = payload.slice(0, userSep);
    const exp = Number(payload.slice(userSep + 1));
    if (u !== BASIC_USER || !Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return false;
    const mac = crypto.createHmac('sha256', dashSessionSecret()).update(payload).digest();
    let sigBuf: Buffer;
    try {
      sigBuf = Buffer.from(sigStr, 'base64url');
    } catch {
      return false;
    }
    if (sigBuf.length !== mac.length) return false;
    return crypto.timingSafeEqual(sigBuf, mac);
  } catch {
    return false;
  }
}

function parseCookieHeader(h: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!h) return out;
  for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    let v = part.slice(i + 1).trim();
    if (k) {
      try {
        v = decodeURIComponent(v);
      } catch {
        /* keep raw */
      }
      out[k] = v;
    }
  }
  return out;
}

function dashCookieSecure(req: { headers: Record<string, unknown> }): boolean {
  if ((process.env.DASHBOARD_COOKIE_SECURE || '').trim() === '0') return false;
  const xf = String(req.headers['x-forwarded-proto'] ?? '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  if (xf === 'https') return true;
  return process.env.NODE_ENV === 'production';
}

function buildDashSetCookie(token: string, req: { headers: Record<string, unknown> }): string {
  const parts = [
    `${DASH_SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${DASH_SESSION_MAX_AGE_SEC}`,
  ];
  if (dashCookieSecure(req)) parts.push('Secure');
  return parts.join('; ');
}

if (BASIC_AUTH_ENABLED) {
  app.addHook('onRequest', async (req, reply) => {
    const url = (req.raw.url || '/').split('?')[0];
    if (BASIC_AUTH_BYPASS.has(url)) return;

    const cookies = parseCookieHeader(req.headers.cookie as string | undefined);
    const sessionTok = cookies[DASH_SESSION_COOKIE];
    const sessionOk = !!sessionTok && verifyDashSession(sessionTok);

    const creds = parseBasicAuthHeader(req.headers['authorization'] as string | undefined);
    const basicOk = !!creds && safeEqual(creds.user, BASIC_USER) && safeEqual(creds.pass, BASIC_PASS);

    if (sessionOk || basicOk) {
      reply.header('Set-Cookie', buildDashSetCookie(signDashSession(), req));
      return;
    }

    reply
      .header('WWW-Authenticate', `Basic realm="${BASIC_REALM.replace(/"/g, '')}", charset="UTF-8"`)
      .code(401)
      .send({ ok: false, error: 'unauthorized' });
  });
  console.log(
    `[dashboard] HTTP Basic Auth ENABLED (user=${BASIC_USER}, cookie=${DASH_SESSION_COOKIE}, bypass=${[...BASIC_AUTH_BYPASS].join(',')})`,
  );
} else {
  console.log('[dashboard] HTTP Basic Auth disabled (set DASHBOARD_BASIC_USER + DASHBOARD_BASIC_PASSWORD to enable)');
}

// ---------------------------------------------------------
// visit counter (privacy: store hashed IP prefix only)
// ---------------------------------------------------------
function hashIp(ip: string): string {
  const trimmed = ip.replace(/^::ffff:/, '').split(',')[0].trim();
  // оставляем только первые 2 октета IPv4 / первые 4 группы IPv6 + соль
  const trunc = trimmed.includes(':') ? trimmed.split(':').slice(0, 4).join(':') : trimmed.split('.').slice(0, 2).join('.');
  return crypto.createHash('sha256').update('laivy-salt|' + trunc).digest('hex').slice(0, 12);
}

interface VisitRow { ts: number; ip: string; ua: string; ref: string }

function loadVisits(): VisitRow[] {
  if (!fs.existsSync(VISITS_PATH)) return [];
  return fs.readFileSync(VISITS_PATH, 'utf-8').split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l) as VisitRow; } catch { return null; } })
    .filter(Boolean) as VisitRow[];
}

function recordVisit(ip: string, ua: string, ref: string): void {
  const row: VisitRow = { ts: Date.now(), ip: hashIp(ip), ua: (ua || '').slice(0, 120), ref: (ref || '').slice(0, 120) };
  try { fs.appendFileSync(VISITS_PATH, JSON.stringify(row) + '\n'); } catch {}
}

function visitStats() {
  const all = loadVisits();
  const now = Date.now();
  const hour = 3_600_000, day = 86_400_000;
  const uniqDay = new Set<string>();
  const uniqHour = new Set<string>();
  const uniq7d = new Set<string>();
  let pageviewsHour = 0, pageviewsDay = 0;
  for (const v of all) {
    const age = now - v.ts;
    if (age <= 7 * day) uniq7d.add(v.ip);
    if (age <= day) { uniqDay.add(v.ip); pageviewsDay++; }
    if (age <= hour) { uniqHour.add(v.ip); pageviewsHour++; }
  }
  return {
    total: all.length,
    pageviewsDay, pageviewsHour,
    uniqueDay: uniqDay.size,
    uniqueHour: uniqHour.size,
    unique7d: uniq7d.size,
  };
}

function getClientIp(req: any): string {
  return (req.headers['x-real-ip'] as string)
      || (req.headers['x-forwarded-for'] as string)
      || req.ip || req.socket?.remoteAddress || '0.0.0.0';
}

app.get('/', async (req, reply) => {
  recordVisit(getClientIp(req), req.headers['user-agent'] as string, req.headers['referer'] as string);
  const html = fs.readFileSync(HTML_PATH, 'utf-8');
  reply.header('content-type', 'text/html; charset=utf-8');
  return html;
});

app.get('/api/visits', async (_req, reply) => {
  reply.header('cache-control', 'no-store');
  return visitStats();
});

app.get('/api/state', async (_req, reply) => {
  const { open, closed, firstTs, lastTs } = loadStore();

  const enriched = await Promise.all(
    open.map(async ot => {
      const curMc = await getCurrentMc(ot.mint);
      const cur = curMc ?? ot.peakMcUsd;
      const pnlPct = curMc ? ((curMc / ot.entryMcUsd) - 1) * 100 : 0;
      const ageMin = (Date.now() - ot.entryTs) / 60_000;
      const peakReached = Math.max(ot.peakPnlPct, pnlPct);
      return {
        mint: ot.mint,
        symbol: ot.symbol,
        entryTs: ot.entryTs,
        entryMcUsd: ot.entryMcUsd,
        currentMcUsd: cur,
        peakMcUsd: Math.max(ot.peakMcUsd, cur),
        pnlPct,
        peakPnlPct: peakReached,
        ageMin,
        trailingArmed: ot.trailingArmed || pnlPct >= 50,
        hasLiveMc: !!curMc,
      };
    })
  );

  const metrics = computeMetrics(closed);
  const recentClosed = [...closed].sort((a, b) => b.exitTs - a.exitTs).slice(0, 30);
  const topWinners = [...closed].sort((a, b) => b.pnlPct - a.pnlPct).slice(0, 5);
  const topLosers = [...closed].sort((a, b) => a.pnlPct - b.pnlPct).slice(0, 5);

  reply.header('cache-control', 'no-store');
  const storeMeta = computeStoreMeta();
  return {
    now: Date.now(),
    firstTs,
    lastTs,
    hoursOfData: (lastTs - firstTs) / 3_600_000,
    storeMeta,
    metrics,
    open: enriched,
    recentClosed,
    topWinners,
    topLosers,
    config: {
      tp: 3.0,
      sl: 0.3,
      trailTrigger: 1.5,
      trailDrop: 0.4,
      timeoutHours: 12,
      windowStartMin: 2,
      decisionAgeMin: 7,
    },
  };
});

app.get('/api/health', async () => ({ ok: true, ts: Date.now() }));

app.get('/api/qn/usage', async (_req, reply) => {
  reply.header('cache-control', 'no-store');
  return qnUsageSnapshot();
});

function parserProgramId(): string {
  return (
    process.env.SA_PARSER_PROGRAM_ID?.trim() || '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'
  );
}

const ATLAS_CURSOR_NAME = 'swap-enrich';

app.get('/api/atlas/health', async (_req, reply) => {
  reply.header('cache-control', 'no-store');
  try {
    const sql = pgPool();
    const [row] = await sql`
      SELECT
        (SELECT count(*)::bigint FROM entity_wallets) AS ew_total,
        (SELECT count(*)::bigint FROM entity_wallets WHERE profile_updated_at > now() - interval '5 minutes') AS ew_m5,
        (SELECT count(*)::bigint FROM wallet_tags WHERE source = 'sa-atlas') AS atlas_tags_total,
        (SELECT count(*)::bigint FROM wallet_tags WHERE source = 'sa-atlas' AND added_at > now() - interval '5 minutes') AS atlas_tags_m5,
        (SELECT count(*)::bigint FROM money_flows WHERE observed_at > now() - interval '5 minutes' AND target_wallet LIKE 'pump:%') AS atlas_flows_m5,
        (SELECT last_swap_id FROM atlas_cursor WHERE name = ${ATLAS_CURSOR_NAME}) AS cursor_id,
        (SELECT count(*)::bigint FROM swaps WHERE id > coalesce((SELECT last_swap_id FROM atlas_cursor WHERE name = ${ATLAS_CURSOR_NAME}), 0)) AS lag_swaps
    `;
    return {
      ew_total: Number(row.ew_total),
      ew_m5: Number(row.ew_m5),
      atlas_tags_total: Number(row.atlas_tags_total),
      atlas_tags_m5: Number(row.atlas_tags_m5),
      atlas_flows_m5: Number(row.atlas_flows_m5),
      cursor_id: row.cursor_id != null ? String(row.cursor_id) : null,
      lag_swaps: Number(row.lag_swaps),
    };
  } catch (e) {
    reply.code(503);
    return { ok: false, error: String(e) };
  }
});

app.get('/api/parser/health', async (_req, reply) => {
  reply.header('cache-control', 'no-store');
  try {
    const sql = pgPool();
    const pid = parserProgramId();
    const [row] = await sql`
      SELECT
        (SELECT count(*)::bigint FROM swaps) AS swaps_total,
        (SELECT count(*)::bigint FROM swaps WHERE created_at > now() - interval '1 minute') AS m1,
        (SELECT count(*)::bigint FROM swaps WHERE created_at > now() - interval '5 minutes') AS m5,
        (SELECT max(block_time) FROM swaps) AS last_block_time,
        (SELECT max(created_at) FROM swaps) AS last_inserted_at,
        (SELECT last_event_id FROM parser_cursor WHERE program_id = ${pid}) AS cursor_id,
        (SELECT count(*)::bigint FROM stream_events
           WHERE program_id = ${pid}
             AND id > coalesce((SELECT last_event_id FROM parser_cursor WHERE program_id = ${pid}), 0)) AS lag_events
    `;
    return {
      swaps_total: Number(row.swaps_total),
      m1: Number(row.m1),
      m5: Number(row.m5),
      last_block_time: row.last_block_time,
      last_inserted_at: row.last_inserted_at,
      cursor_id: row.cursor_id != null ? String(row.cursor_id) : null,
      lag_events: Number(row.lag_events),
    };
  } catch (e) {
    reply.code(503);
    return { ok: false, error: String(e) };
  }
});

app.get('/api/stream/health', async (_req, reply) => {
  reply.header('cache-control', 'no-store');
  try {
    const sql = pgPool();
    const [row] = await sql`
      SELECT
        (SELECT count(*)::bigint FROM stream_events) AS total,
        (SELECT count(*)::bigint FROM stream_events WHERE received_at > now() - interval '1 minute') AS m1,
        (SELECT count(*)::bigint FROM stream_events WHERE received_at > now() - interval '5 minutes') AS m5,
        (SELECT max(received_at) FROM stream_events) AS last_event_at,
        (SELECT count(DISTINCT program_id)::bigint FROM stream_events) AS distinct_programs
    `;
    return {
      total: Number(row.total),
      m1: Number(row.m1),
      m5: Number(row.m5),
      last_event_at: row.last_event_at,
      distinct_programs: Number(row.distinct_programs),
    };
  } catch (e) {
    reply.code(503);
    return { ok: false, error: String(e) };
  }
});

const DEX_SOURCE_TABLES = {
  raydium: 'raydium_pair_snapshots',
  meteora: 'meteora_pair_snapshots',
  orca: 'orca_pair_snapshots',
  moonshot: 'moonshot_pair_snapshots',
  pumpswap: 'pumpswap_pair_snapshots',
} as const;

app.get<{ Params: { source: string } }>('/api/dex/:source/health', async (req, reply) => {
  reply.header('cache-control', 'no-store');
  const src = String(req.params.source || '').toLowerCase();
  const table = DEX_SOURCE_TABLES[src as keyof typeof DEX_SOURCE_TABLES];
  if (!table) {
    reply.code(404);
    return { ok: false, error: `unknown source: ${src}` };
  }
  try {
    const sql = pgPool();
    const [row] = await sql.unsafe(
      `SELECT
        (SELECT count(*)::bigint FROM ${table}) AS total,
        (SELECT count(*)::bigint FROM ${table} WHERE created_at > now() - interval '1 minute') AS m1,
        (SELECT count(*)::bigint FROM ${table} WHERE created_at > now() - interval '5 minutes') AS m5,
        (SELECT max(ts) FROM ${table}) AS last_bucket_ts,
        (SELECT max(created_at) FROM ${table}) AS last_inserted_at,
        (SELECT count(DISTINCT base_mint)::bigint FROM ${table} WHERE ts > now() - interval '1 hour') AS distinct_mints_h1`,
    );
    return {
      source: src,
      total: Number(row.total),
      m1: Number(row.m1),
      m5: Number(row.m5),
      last_bucket_ts: row.last_bucket_ts,
      last_inserted_at: row.last_inserted_at,
      distinct_mints_h1: Number(row.distinct_mints_h1),
    };
  } catch (e) {
    reply.code(503);
    return { ok: false, error: String(e) };
  }
});

app.get('/api/jupiter/health', async (_req, reply) => {
  reply.header('cache-control', 'no-store');
  try {
    const sql = pgPool();
    const [row] = await sql`
      SELECT
        (SELECT count(*)::bigint FROM jupiter_route_snapshots) AS total,
        (SELECT count(*)::bigint FROM jupiter_route_snapshots WHERE created_at > now() - interval '5 minutes') AS m5,
        (SELECT count(*)::bigint FROM jupiter_route_snapshots WHERE created_at > now() - interval '5 minutes' AND routeable = true) AS routeable_m5,
        (SELECT max(ts) FROM jupiter_route_snapshots) AS last_bucket_ts,
        (SELECT count(DISTINCT mint)::bigint FROM jupiter_route_snapshots WHERE ts > now() - interval '1 hour') AS distinct_mints_h1
    `;
    return {
      total: Number(row.total),
      m5: Number(row.m5),
      routeable_m5: Number(row.routeable_m5),
      last_bucket_ts: row.last_bucket_ts,
      distinct_mints_h1: Number(row.distinct_mints_h1),
    };
  } catch (e) {
    reply.code(503);
    return { ok: false, error: String(e) };
  }
});

app.get('/api/direct-lp/health', async (_req, reply) => {
  reply.header('cache-control', 'no-store');
  try {
    const sql = pgPool();
    const [row] = await sql`
      SELECT
        (SELECT count(*)::bigint FROM direct_lp_events) AS total,
        (SELECT count(*)::bigint FROM direct_lp_events WHERE created_at > now() - interval '1 hour') AS h1,
        (SELECT max(ts) FROM direct_lp_events) AS last_event_ts,
        (SELECT count(DISTINCT base_mint)::bigint FROM direct_lp_events WHERE ts > now() - interval '24 hours') AS distinct_mints_d1,
        (SELECT avg(confidence)::float FROM direct_lp_events WHERE ts > now() - interval '24 hours') AS avg_confidence_d1
    `;
    return {
      total: Number(row.total),
      h1: Number(row.h1),
      last_event_ts: row.last_event_ts,
      distinct_mints_d1: Number(row.distinct_mints_d1),
      avg_confidence_d1: row.avg_confidence_d1 != null ? Number(row.avg_confidence_d1) : null,
    };
  } catch (e) {
    reply.code(503);
    return { ok: false, error: String(e) };
  }
});

// ---------------------------------------------------------
// /api/paper2 — read every *.jsonl in PAPER2_DIR and aggregate.
// Uses W6.3c close.netPnlUsd directly (NOT pctToUsd(pnlPct)).
// ---------------------------------------------------------
export type Paper2OpenItem = {
  mint: string;
  symbol: string;
  entryTs: number;
  entryMcUsd: number;
  entryRealMcUsd: number | null;
  /** Entry spot USD/token from journal (`entryMarketPrice` / legs[0].marketPrice). Used when metricType=price. */
  baselinePriceUsd: number | null;
  openedAtIso: string | null;
  lane: string | null;
  source: string | null;
  metricType: string | null;
  features: unknown;
  btc: unknown;
  peakMcUsd: number;
  peakPnlPct: number;
  trailingArmed: boolean;
  totalInvestedUsd: number;
  /** W7.3 — per-tx network fee snapshot from journal `open.priorityFee.usd`. */
  entryPriorityFeeUsd: number | null;
  /** W7.4 — Jupiter pre-entry quote vs snapshot (open row only; carried to closed via journal map). */
  entryPriceVerifySlipPct: number | null;
  entryPriceVerifyImpactPct: number | null;
  entryPriceVerifySource: 'jupiter' | 'skipped' | 'blocked' | null;
  /** W7.5 — pool address from journal open row / features. */
  pairAddress: string | null;
  /** W7.5 — entry liquidity USD baseline. */
  entryLiqUsd: number | null;
  /**
   * Fraction of the position still held (from last `partial_sell.remainingFraction`, else 1).
   * DCA rows reset the live tracker position to 100% remainder — we mirror that via `dca_add` handling.
   */
  remainingFraction: number;
};

type Paper2ClosedRow = Record<string, unknown>;

type PriceVerifyDtoFromJsonl = {
  kind: 'ok' | 'blocked' | 'skipped';
  slipPct?: number;
  priceImpactPct?: number;
};

function priceVerifyUiFields(pv: unknown): {
  entryPriceVerifySlipPct: number | null;
  entryPriceVerifyImpactPct: number | null;
  entryPriceVerifySource: 'jupiter' | 'skipped' | 'blocked' | null;
} {
  if (!pv || typeof pv !== 'object') {
    return {
      entryPriceVerifySlipPct: null,
      entryPriceVerifyImpactPct: null,
      entryPriceVerifySource: null,
    };
  }
  const p = pv as PriceVerifyDtoFromJsonl;
  const entryPriceVerifySlipPct =
    p.kind !== 'skipped' && Number.isFinite(p.slipPct) ? +Number(p.slipPct).toFixed(2) : null;
  const entryPriceVerifyImpactPct =
    p.kind !== 'skipped' && Number.isFinite(p.priceImpactPct)
      ? +Number(p.priceImpactPct).toFixed(2)
      : null;
  const entryPriceVerifySource: 'jupiter' | 'skipped' | 'blocked' | null =
    p.kind === 'ok' ? 'jupiter' : p.kind === 'blocked' ? 'blocked' : p.kind === 'skipped' ? 'skipped' : null;
  return { entryPriceVerifySlipPct, entryPriceVerifyImpactPct, entryPriceVerifySource };
}

const PAPER2_PRICE_VERIFY_AGG_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Fixed column order on `/papertrader2` — see W8.0-p4 § «Дашборд». */
/** Фиксированные плитки на `/papertrader2` (пятая — Oscar + TP regime fork). */
export const DASHBOARD_PANEL_ORDER = [
  'live-oscar',
  'pt1-oscar',
  'pt1-oscar-regime',
  'pt1-diprunner',
  'pt1-dno',
] as const;

export type DashboardPaper2StrategyRow = {
  strategyId: string;
  file: string;
  openCount: number;
  closedCount: number;
  startedAt: number;
  lastTs: number;
  hoursOfData: number;
  sumPnlUsd: number;
  realizedPnlUsd: number;
  unrealizedPnlUsd: number;
  totalPnlUsd: number;
  winRate: number;
  avgPnl: number;
  avgPeak: number;
  bestPnlUsd: number;
  worstPnlUsd: number;
  unrealizedUsd: number;
  exits: Record<string, number>;
  exitsBreakdown: Record<string, { count: number; sumPct: number; sumUsd: number; avgPct: number }>;
  evals1h: number;
  passed1h: number;
  failReasons: Array<{ reason: string; count: number }>;
  open: unknown[];
  recentClosed: unknown[];
  priorityFeeUsdTotal: number;
  priceVerify: {
    okCount: number;
    blockedCount: number;
    skippedCount: number;
    avgSlipPct: number | null;
    p90SlipPct: number | null;
  };
  liqDrain: { exits: number; avgDropPct: number | null; p90DropPct: number | null };
  /** Last boot reconcile fields from `heartbeat` (live-oscar / Phase 7). */
  liveReconcileBoot?: {
    status?: string;
    skipReason?: string;
    divergentCount?: number;
    chainOnlyCount?: number;
    journalTruncated?: boolean;
  };
  /** Last structured row from `live_reconcile_report` (`liveSchema: 2`). */
  liveReconcileReport?: {
    ts: number;
    ok: boolean;
    reconcileStatus: string;
    txAnchorMissing?: number;
    txAnchorRpcErrors?: number;
  };
};

function aggregatePriceVerifyFromJsonl(filePath: string, windowMs: number): {
  okCount: number;
  blockedCount: number;
  skippedCount: number;
  avgSlipPct: number | null;
  p90SlipPct: number | null;
} {
  const slips: number[] = [];
  let blocked = 0;
  let skipped = 0;
  if (!fs.existsSync(filePath)) {
    return { okCount: 0, blockedCount: 0, skippedCount: 0, avgSlipPct: null, p90SlipPct: null };
  }
  const cutoff = Date.now() - windowMs;
  const lines = fs.readFileSync(filePath, 'utf-8').split('\n').filter(Boolean);
  for (const ln of lines) {
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(ln) as Record<string, unknown>;
    } catch {
      continue;
    }
    const ts = typeof ev.ts === 'number' ? ev.ts : 0;
    if (ts < cutoff) continue;
    if (ev.kind === 'open' && ev.priceVerify && typeof ev.priceVerify === 'object') {
      const pv = ev.priceVerify as { kind?: string; slipPct?: number };
      if (pv.kind === 'ok') {
        const s = Number(pv.slipPct);
        if (Number.isFinite(s)) slips.push(s);
      } else if (pv.kind === 'blocked') blocked += 1;
      else if (pv.kind === 'skipped') skipped += 1;
    } else if (
      ev.kind === 'eval-skip-open' &&
      typeof ev.reason === 'string' &&
      ev.reason.startsWith('price_verify:')
    ) {
      blocked += 1;
    }
  }
  const sortedSlips = [...slips].sort((a, b) => a - b);
  const avgSlipPct =
    slips.length > 0 ? +((slips.reduce((a, b) => a + b, 0) / slips.length).toFixed(3)) : null;
  const p90SlipPct =
    slips.length > 0
      ? sortedSlips[Math.min(sortedSlips.length - 1, Math.floor(sortedSlips.length * 0.9))]
      : null;
  return {
    okCount: slips.length,
    blockedCount: blocked,
    skippedCount: skipped,
    avgSlipPct,
    p90SlipPct,
  };
}

function priceVerifyStatsEndpointSlice(filePath: string, windowMs: number): {
  okCount: number;
  blockedCount: number;
  skippedCount: number;
  avgSlipPct: number | null;
  p90SlipPct: number | null;
  avgImpactPct: number | null;
} {
  const slips: number[] = [];
  const impacts: number[] = [];
  let blocked = 0;
  let skipped = 0;
  if (!fs.existsSync(filePath)) {
    return {
      okCount: 0,
      blockedCount: 0,
      skippedCount: 0,
      avgSlipPct: null,
      p90SlipPct: null,
      avgImpactPct: null,
    };
  }
  const cutoff = Date.now() - windowMs;
  const lines = fs.readFileSync(filePath, 'utf-8').split('\n').filter(Boolean);
  for (const ln of lines) {
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(ln) as Record<string, unknown>;
    } catch {
      continue;
    }
    const ts = typeof ev.ts === 'number' ? ev.ts : 0;
    if (ts < cutoff) continue;
    if (ev.kind === 'open' && ev.priceVerify && typeof ev.priceVerify === 'object') {
      const pv = ev.priceVerify as { kind?: string; slipPct?: number; priceImpactPct?: number };
      if (pv.kind === 'ok') {
        if (Number.isFinite(pv.slipPct)) slips.push(Number(pv.slipPct));
        if (Number.isFinite(pv.priceImpactPct)) impacts.push(Number(pv.priceImpactPct));
      } else if (pv.kind === 'blocked') {
        blocked += 1;
      } else if (pv.kind === 'skipped') {
        skipped += 1;
      }
    } else if (
      ev.kind === 'eval-skip-open' &&
      typeof ev.reason === 'string' &&
      ev.reason.startsWith('price_verify:')
    ) {
      blocked += 1;
    }
  }
  const sorted = [...slips].sort((a, b) => a - b);
  const avgSlipPct =
    slips.length > 0 ? +((slips.reduce((a, b) => a + b, 0) / slips.length).toFixed(3)) : null;
  const p90SlipPct =
    slips.length > 0 ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))] : null;
  const avgImpactPct =
    impacts.length > 0
      ? +((impacts.reduce((a, b) => a + b, 0) / impacts.length).toFixed(3))
      : null;
  return {
    okCount: slips.length,
    blockedCount: blocked,
    skippedCount: skipped,
    avgSlipPct,
    p90SlipPct,
    avgImpactPct,
  };
}

/**
 * Per-position audit timeline derived from jsonl events.
 * mcUsd is USD market cap when known (only when metricType === 'mc'),
 * null otherwise (so the UI can render "mcap n/a" exactly like the spec).
 */
export type TimelineEvent = {
  ts: number;
  kind: 'open' | 'dca_add' | 'scale_in_add' | 'partial_sell' | 'close';
  label: string;
  mcUsd: number | null;
  /** Spot USD/token at event time when strategy tracks price not mcap */
  spotPxUsd: number | null;
  /** % of base position (DCA) or % of remaining position (partial_sell). */
  sizePct: number | null;
  pnlPct: number | null;
  pnlUsd: number | null;
  reason: string | null;
  remainingFraction: number | null;
  /**
   * Trade-flow USD for dashboard: buys (open / DCA); partial_sell = gross proceeds;
   * close = cost basis of closed slice. Not mark-to-market.
   */
  amountUsd: number | null;
  /** Set when live journal correlates an on-chain swap (`execution_result.txSignature`). */
  txSignature?: string | null;
  /** Доп. строки: TP-regime (paper), режим выхода A/B (live) — см. IDEALIZED_OSCAR_STACK_SPEC. */
  contextNote?: string | null;
};

/** Solana mainnet explorer link for a transaction signature. */
export function solscanTxUrl(signature: string): string {
  const s = String(signature ?? '').trim();
  return `https://solscan.io/tx/${encodeURIComponent(s)}`;
}

/** Open row shape returned by `/api/paper2` after live enrichment. */
export type Paper2ApiEnrichedOpen = {
  mint: string;
  symbol: string;
  entryTs: number;
  entryMcUsd: number;
  entryRealMcUsd: number | null;
  entryMcapAtBuyUsd: number | null;
  baselinePriceUsd: number | null;
  metricType: string | null;
  openedAtIso: string | null;
  lane: string | null;
  source: string | null;
  currentMcUsd: number;
  livePriceUsd: number | null;
  peakMcUsd: number;
  peakPnlPct: number;
  trailingArmed: boolean;
  pnlPct: number | null;
  pnlUsd: number | null;
  ageMin: number;
  hasLiveMc: boolean;
  hasLivePrice: boolean;
  livePriceStale: boolean;
  livePxProvenance: 'snapshots' | 'jupiter' | 'journal' | null;
  liveMcProvenance: 'snapshots' | 'pump.fun' | null;
  timeline: TimelineEvent[];
  entryPriorityFeeUsd: number | null;
  entryPriceVerifySlipPct: number | null;
  entryPriceVerifyImpactPct: number | null;
  entryPriceVerifySource: 'jupiter' | 'skipped' | 'blocked' | null;
  entryLiqUsd: number | null;
  currentLiqUsd: number | null;
  liqDropPct: number | null;
  remainingCostBasisUsd: number;
};

const TIMELINE_SPOT_FALLBACK_MAX_AGE_MS = 48 * 3600 * 1000;

/**
 * Last known journal spot px (DCA / ladder / close) when pair_snapshots miss the mint.
 * IMPORTANT: skip the `open` event itself — its spot equals the entry price by construction,
 * which would yield pnlPct ≡ 0 and mask the real unrealized PnL.
 */
function latestTimelineSpotUsd(timeline: TimelineEvent[], maxAgeMs: number): number | null {
  const now = Date.now();
  for (let i = timeline.length - 1; i >= 0; i--) {
    const ev = timeline[i];
    if (ev.kind === 'open') continue;
    const p = Number(ev.spotPxUsd ?? 0);
    if (!(p > 0)) continue;
    if (now - ev.ts <= maxAgeMs) return p;
  }
  return null;
}

function fmtSignedPct(p: number | null | undefined): string {
  if (p == null || !Number.isFinite(p)) return '';
  const sign = p >= 0 ? '+' : '';
  return `${sign}${p.toFixed(0)}%`;
}

/** Человекочитаемое пояснение к классу пути до входа (журнал `tpRegime`). */
function tpRegimeRu(tp: unknown): string | null {
  const raw = typeof tp === 'string' ? tp.trim().toLowerCase() : '';
  if (!raw) return null;
  const map: Record<string, string> = {
    down: 'вниз',
    up: 'вверх',
    sideways: 'флэт',
    unknown: 'не классифицирован',
  };
  return map[raw] ?? raw;
}

/** Контекст для строк таймлайна open/close (paper + live). */
function timelineContextNoteFromJournal(e: Record<string, unknown>): string | null {
  const parts: string[] = [];
  const tpRu = tpRegimeRu(e.tpRegime);
  if (tpRu) parts.push(`Класс пути до входа (TP-regime): ${tpRu} (${String(e.tpRegime)})`);
  const mode = e.liveExitProfileMode;
  if (mode === 'A')
    parts.push('Режим выхода A/B: A — до второй ноги входа или до DCA');
  else if (mode === 'B')
    parts.push('Режим выхода A/B: B — после второй ноги или DCA (профиль B)');
  return parts.length ? parts.join('\n') : null;
}

export function buildTimelineEvent(
  e: Record<string, unknown>,
  metricType: string | null,
  entryRealMcUsd: number | null,
): TimelineEvent | null {
  const ts = Number(e.ts ?? 0);
  if (!ts) return null;
  const kind = String(e.kind || '');
  const isMcMetric = metricType === 'mc';
  const marketPrice = Number(e.marketPrice ?? 0);
  /** W7.2+ stamped mcap snapshot on each ledger row — takes precedence. */
  const mcFromJournal = (): number | null => {
    const j = Number(e.mcUsdLive ?? 0);
    return Number.isFinite(j) && j > 0 ? j : null;
  };

  const liveMc = (): number | null => mcFromJournal() ?? (isMcMetric && marketPrice > 0 ? marketPrice : null);
  const spotPxFromMetric = (): number | null =>
    mcFromJournal() != null ? null : !isMcMetric && marketPrice > 0 ? marketPrice : null;

  if (kind === 'open') {
    const openMc =
      entryRealMcUsd && entryRealMcUsd > 0
        ? entryRealMcUsd
        : mcFromJournal() ??
          (isMcMetric && Number(e.entryMcUsd ?? 0) > 0 ? Number(e.entryMcUsd) : null);
    const legs = Array.isArray(e.legs) ? (e.legs as Record<string, unknown>[]) : [];
    const legMp = legs[0] ? Number(legs[0].marketPrice ?? 0) : 0;
    const entryMp = Number(e.entryMarketPrice ?? 0);
    const spotPx = entryMp > 0 ? entryMp : legMp > 0 ? legMp : null;
    let amountOpen = Number(e.totalInvestedUsd ?? e.total_invested_usd ?? 0);
    if (!(amountOpen > 0) && legs.length) {
      amountOpen = legs.reduce((s, l) => s + Number(l.sizeUsd ?? l.size_usd ?? 0), 0);
    }
    const ruOpen =
      typeof e.timelineOpenLabelRu === 'string' && e.timelineOpenLabelRu.trim().length
        ? String(e.timelineOpenLabelRu).trim()
        : null;
    const openLabel = ruOpen ?? 'Open';
    const ctxOpen = timelineContextNoteFromJournal(e);
    return {
      ts,
      kind: 'open',
      label: openLabel,
      mcUsd: openMc,
      spotPxUsd: spotPx != null && spotPx > 0 ? spotPx : null,
      sizePct: null,
      pnlPct: null,
      pnlUsd: null,
      reason: null,
      remainingFraction: 1,
      amountUsd: amountOpen > 0 ? amountOpen : null,
      ...(ctxOpen ? { contextNote: ctxOpen } : {}),
    };
  }
  if (kind === 'scale_in_add') {
    const fracFull = Number(e.secondLegFractionOfFull ?? 0);
    const pct =
      fracFull > 0 && fracFull <= 1 ? Math.round(fracFull * 100) : Number(e.scaleInPctRounded ?? NaN);
    const ru =
      typeof e.timelineLabelRu === 'string' && e.timelineLabelRu.trim().length
        ? String(e.timelineLabelRu).trim()
        : Number.isFinite(pct) && pct > 0
          ? `Докупка ${pct}% позиции`
          : 'Докупка второй ноги входа';
    const sizeUsd = Number(e.sizeUsd ?? e.size_usd ?? 0);
    const ctxScale = timelineContextNoteFromJournal(e);
    return {
      ts,
      kind: 'scale_in_add',
      label: ru,
      mcUsd: liveMc(),
      spotPxUsd: spotPxFromMetric(),
      sizePct: null,
      pnlPct: null,
      pnlUsd: null,
      reason: 'scale_in',
      remainingFraction: null,
      amountUsd: sizeUsd > 0 ? sizeUsd : null,
      ...(ctxScale ? { contextNote: ctxScale } : {}),
    };
  }
  if (kind === 'dca_add') {
    const triggerPct = Number(e.triggerPct ?? 0) * 100; // -7%, -15%, ...
    const sizeUsd = Number(e.sizeUsd ?? e.size_usd ?? 0);
    const addUsd =
      sizeUsd > 0 ? sizeUsd : Number(e.addUsd ?? e.add_usd ?? e.dcaUsd ?? e.dca_usd ?? 0);
    const sz = addUsd > 0 ? addUsd : sizeUsd;
    const dcaStep = Number(e.dcaStepIndex ?? NaN);
    const dcaTot = Number(e.dcaLevelsTotal ?? NaN);
    let stepPart = '';
    if (Number.isFinite(dcaStep) && dcaStep >= 0) {
      stepPart =
        Number.isFinite(dcaTot) && dcaTot > 0
          ? ` · шаг ${Math.floor(dcaStep) + 1}/${Math.floor(dcaTot)}`
          : ` · шаг ${Math.floor(dcaStep) + 1}`;
    }
    const ruDca =
      typeof e.timelineLabelRu === 'string' && e.timelineLabelRu.trim().length
        ? String(e.timelineLabelRu).trim()
        : null;
    const label = ruDca ?? `DCA${stepPart} · уровень ${fmtSignedPct(triggerPct)} (от первой ноги)`;
    const ctxDca = timelineContextNoteFromJournal(e);
    return {
      ts,
      kind: 'dca_add',
      label,
      mcUsd: liveMc(),
      spotPxUsd: spotPxFromMetric(),
      sizePct: null,
      pnlPct: null,
      pnlUsd: null,
      reason: 'dca',
      remainingFraction: null,
      amountUsd: sz > 0 ? sz : null,
      ...(ctxDca ? { contextNote: ctxDca } : {}),
    };
  }
  if (kind === 'partial_sell') {
    const sellFraction = Number(e.sellFraction ?? 0);
    const ladderPnlPct = Number(e.ladderPnlPct ?? 0) * 100;
    const reason = String(e.reason || 'partial_sell');
    const sellPct = Math.round(sellFraction * 100);
    const isTpGrid = e.tpGrid === true || e.tpGrid === 'true';
    const niceReason =
      reason === 'TP_LADDER'
        ? isTpGrid
          ? 'Сетка TP (Oscar)'
          : 'Лестница TP'
        : reason.toLowerCase().replace(/_/g, ' ');
    const pnlUsd = Number(e.pnlUsd ?? 0);
    const proceedsUsd = Number(e.proceedsUsd ?? 0);
    const ladderPctPlain =
      Number.isFinite(ladderPnlPct) && ladderPnlPct !== 0
        ? `${ladderPnlPct < 0 ? '−' : ''}${Math.abs(ladderPnlPct).toFixed(0)}%`
        : '';
    const stepIdxRaw = Number(e.ladderStepIndex ?? NaN);
    const rungsTotal = Number(e.ladderRungsTotal ?? NaN);
    const stepLabel = isTpGrid
      ? Number.isFinite(stepIdxRaw) && stepIdxRaw >= 0
        ? `ступень сетки ${Math.floor(stepIdxRaw) + 1} (+${ladderPctPlain} к среднему)`
        : ''
      : reason === 'TP_LADDER' && Number.isFinite(stepIdxRaw) && stepIdxRaw >= 0
        ? Number.isFinite(rungsTotal) && rungsTotal > 0
          ? `шаг ${Math.floor(stepIdxRaw) + 1}/${Math.floor(rungsTotal)}`
          : `шаг ${Math.floor(stepIdxRaw) + 1}`
        : '';
    const label =
      isTpGrid && stepLabel
        ? `${niceReason} · ${stepLabel}: ${sellPct}% от остатка`
        : stepLabel && ladderPctPlain
          ? `${niceReason} · ${stepLabel}: ${sellPct}% остатка при +${ladderPctPlain} к среднему (порог ладдера)`
          : ladderPctPlain
            ? `${niceReason} · ${sellPct}% остатка при +${ladderPctPlain} к среднему (порог ладдера)`
            : `${niceReason} · ${sellPct}% остатка`;
    return {
      ts,
      kind: 'partial_sell',
      label,
      mcUsd: liveMc(),
      spotPxUsd: spotPxFromMetric(),
      sizePct: sellFraction,
      pnlPct: ladderPnlPct,
      pnlUsd: Number.isFinite(pnlUsd) ? pnlUsd : null,
      reason,
      remainingFraction: Number(e.remainingFraction ?? null),
      amountUsd: proceedsUsd > 0 && Number.isFinite(proceedsUsd) ? proceedsUsd : null,
    };
  }
  if (kind === 'close') {
    const exitReason = String(e.exitReason || 'CLOSE');
    const closeLabel =
      exitReason === 'CAPITAL_ROTATE'
        ? 'Close · CAPITAL_ROTATE — ротация капитала Phase 5 (ожидаемо, не сбой)'
        : `Close · ${exitReason}`;
    const exitMc = Number(e.exitMcUsd ?? 0);
    const exitMarketPrice = Number(e.exit_market_price ?? 0);
    const closeMcFromMetric =
      isMcMetric && exitMarketPrice > 0
        ? exitMarketPrice
        : isMcMetric && exitMc > 0
          ? exitMc
          : null;
    const closeMc = mcFromJournal() ?? closeMcFromMetric;
    const closeSpot =
      mcFromJournal() != null ? null : !isMcMetric && exitMarketPrice > 0 ? exitMarketPrice : null;
    const pnlPct = Number(e.pnlPct ?? 0);
    const netPnlUsd = Number(e.netPnlUsd ?? 0);
    const tiuClose = Number(e.totalInvestedUsd ?? e.total_invested_usd ?? 0);
    const rfClose = Number(e.remainingFraction ?? 0);
    const closeSoldCost =
      tiuClose > 0 && Number.isFinite(rfClose) && rfClose > 0 ? tiuClose * rfClose : null;
    const ctxClose = timelineContextNoteFromJournal(e);
    return {
      ts,
      kind: 'close',
      label: closeLabel,
      mcUsd: closeMc,
      spotPxUsd: closeSpot,
      sizePct: null,
      pnlPct: Number.isFinite(pnlPct) ? pnlPct : null,
      pnlUsd: Number.isFinite(netPnlUsd) ? netPnlUsd : null,
      reason: exitReason,
      remainingFraction: 0,
      amountUsd: closeSoldCost,
      ...(ctxClose ? { contextNote: ctxClose } : {}),
    };
  }
  return null;
}

function normalizeTimelineLabelForUsdParse(label: string): string {
  return label
    .replace(/\uFF04/g, '$')
    .replace(/\uFF0B/g, '+')
    .replace(/\u2212/g, '-')
    .replace(/\u00A0/g, ' ');
}

/** Back-fill amountUsd from human-readable labels (legacy rows, odd journals). */
function enrichTimelineAmountUsd(ev: TimelineEvent): TimelineEvent {
  const cur = Number(ev.amountUsd ?? NaN);
  if (Number.isFinite(cur) && cur > 0) return ev;
  const lab = normalizeTimelineLabelForUsdParse(ev.label ?? '');
  const patch = (n: number): TimelineEvent => ({ ...ev, amountUsd: n });

  if (ev.kind === 'dca_add') {
    const m =
      lab.match(/\+\s*\$\s*([\d.]+)/) ||
      lab.match(/докупка\s+\$\s*([\d.]+)/i) ||
      lab.match(/\badd\s+\$\s*([\d.]+)/i);
    if (m) {
      const v = Number(m[1]);
      if (v > 0) return patch(v);
    }
  }
  if (ev.kind === 'open') {
    const mk = lab.match(/куплено\s+\$\s*([\d.]+)\s*k\b/i);
    if (mk) {
      const v = Number(mk[1]) * 1000;
      if (v > 0) return patch(v);
    }
    const m = lab.match(/куплено\s+\$\s*([\d.]+)\b/i);
    if (m) {
      const v = Number(m[1]);
      if (v > 0) return patch(v);
    }
  }
  if (ev.kind === 'partial_sell') {
    const mk = lab.match(/продано\s+\$\s*([\d.]+)\s*k\b/i);
    if (mk) {
      const v = Number(mk[1]) * 1000;
      if (v > 0) return patch(v);
    }
    const m = lab.match(/продано\s+\$\s*([\d.]+)\b/i);
    if (m) {
      const v = Number(m[1]);
      if (v > 0) return patch(v);
    }
  }
  if (ev.kind === 'close') {
    const mk = lab.match(/выход\s+\$\s*([\d.]+)\s*k\b/i);
    if (mk) {
      const v = Number(mk[1]) * 1000;
      if (v > 0) return patch(v);
    }
    const m = lab.match(/выход\s+\$\s*([\d.]+)\b/i);
    if (m) {
      const v = Number(m[1]);
      if (v > 0) return patch(v);
    }
  }
  return ev;
}

export function finalizeTimelineForApi(timeline: TimelineEvent[]): TimelineEvent[] {
  return timeline.map(enrichTimelineAmountUsd);
}

export function loadPaper2File(filePath: string): {
  open: Paper2OpenItem[];
  closed: Paper2ClosedRow[];
  firstTs: number;
  lastTs: number;
  resetTs: number;
  evals1h: number;
  passed1h: number;
  failReasons: Array<{ reason: string; count: number }>;
  /** Per-position timeline keyed by mint (open positions). */
  openTimelines: Map<string, TimelineEvent[]>;
} {
  if (!fs.existsSync(filePath)) {
    return {
      open: [],
      closed: [],
      firstTs: Date.now(),
      lastTs: Date.now(),
      resetTs: 0,
      evals1h: 0,
      passed1h: 0,
      failReasons: [],
      openTimelines: new Map(),
    };
  }
  const lines = fs.readFileSync(filePath, 'utf-8').split('\n').filter(Boolean);
  const om = new Map<string, Paper2OpenItem>();
  const cl: Paper2ClosedRow[] = [];
  let f = Date.now();
  let l = 0;
  let resetTs = 0;
  let evals1h = 0;
  let passed1h = 0;
  const failReasonsCount = new Map<string, number>();
  const since1h = Date.now() - 3_600_000;
  // Build per-position timelines. Keyed by mint while the position is open;
  // on close we attach the collected events to the close row and clear the
  // bucket so the next re-open of the same mint starts fresh.
  const liveTimelines = new Map<string, TimelineEvent[]>();
  // Cache of (mint -> { metricType, entryRealMcUsd }) so dca_add / partial_sell /
  // close events know how to interpret marketPrice (mcap vs token price).
  const liveMeta = new Map<string, { metricType: string | null; entryRealMcUsd: number | null }>();
  /** W7.4 — stamp at `open`, joined onto `close` for dashboard rows. */
  const entryPriceVerifyByMint = new Map<
    string,
    {
      entryPriceVerifySlipPct: number | null;
      entryPriceVerifyImpactPct: number | null;
      entryPriceVerifySource: 'jupiter' | 'skipped' | 'blocked' | null;
    }
  >();

  for (const ln of lines) {
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(ln) as Record<string, unknown>;
    } catch {
      continue;
    }
    const ts = typeof e.ts === 'number' ? e.ts : 0;
    if (ts) {
      if (ts < f) f = ts;
      if (ts > l) l = ts;
    }
    if (e.kind === 'reset') {
      resetTs = typeof e.ts === 'number' ? e.ts : 0;
      continue;
    }
    if (e.kind === 'eval' && ts >= since1h) {
      evals1h++;
      if (e.pass === true) passed1h++;
      else {
        const reasons = Array.isArray(e.reasons) ? e.reasons : [];
        for (const r of reasons) {
          const key = String(r);
          failReasonsCount.set(key, (failReasonsCount.get(key) || 0) + 1);
        }
      }
    }
    const mint = String(e.mint ?? '');
    if (e.kind === 'open') {
      const feat = e.features as Record<string, unknown> | undefined;
      const featMc =
        feat && ((typeof feat.market_cap_usd === 'number' ? feat.market_cap_usd : 0) ||
          (typeof feat.fdv_usd === 'number' ? feat.fdv_usd : 0));
      const metricType = e.metricType != null ? String(e.metricType) : null;
      const entryRealMcUsd = featMc ? Number(featMc) : null;
      const legsArr = Array.isArray(e.legs) ? (e.legs as Record<string, unknown>[]) : [];
      const legMp = legsArr[0] ? Number(legsArr[0].marketPrice ?? 0) : 0;
      const emp = Number(e.entryMarketPrice ?? 0);
      const baselinePriceUsd =
        emp > 0 ? emp : legMp > 0 ? legMp : null;
      const pfOpen = e.priorityFee as { usd?: number } | undefined;
      const pfOpenUsd = Number(pfOpen?.usd ?? 0);
      const entryPriorityFeeUsd =
        Number.isFinite(pfOpenUsd) && pfOpenUsd > 0 ? pfOpenUsd : null;
      const pvUi = priceVerifyUiFields(e.priceVerify);
      entryPriceVerifyByMint.set(mint, pvUi);
      const entryLiqFromEv =
        typeof e.entryLiqUsd === 'number' && Number(e.entryLiqUsd) > 0 ? Number(e.entryLiqUsd) : null;
      const featLiq =
        feat && typeof feat.liq_usd === 'number' && Number(feat.liq_usd) > 0 ? Number(feat.liq_usd) : null;
      const entryLiqUsd = entryLiqFromEv ?? featLiq;
      const pairFromEv =
        e.pairAddress != null && String(e.pairAddress).trim() ? String(e.pairAddress).trim() : null;
      const featPair =
        feat?.pair_address != null && String(feat.pair_address).trim()
          ? String(feat.pair_address).trim()
          : null;
      const pairAddress = pairFromEv ?? featPair;
      om.set(mint, {
        mint,
        symbol: String(e.symbol ?? ''),
        entryTs: Number(e.entryTs ?? 0),
        entryMcUsd: Number(e.entryMcUsd ?? 0),
        entryRealMcUsd,
        baselinePriceUsd,
        openedAtIso: e.entryTs ? new Date(Number(e.entryTs)).toISOString() : null,
        lane: e.lane != null ? String(e.lane) : null,
        source: e.source != null ? String(e.source) : null,
        metricType,
        features: e.features ?? null,
        btc: e.btc ?? null,
        peakMcUsd: Number(e.entryMcUsd ?? 0),
        peakPnlPct: 0,
        trailingArmed: false,
        // NOTE: never fall back to entryMcUsd here — that's the market cap
        // (millions $), not the position size. 0 means "use POSITION_USD_DEFAULT".
        totalInvestedUsd: Number(e.totalInvestedUsd ?? 0),
        entryPriorityFeeUsd,
        pairAddress,
        entryLiqUsd,
        remainingFraction: 1,
        ...pvUi,
      });
      liveMeta.set(mint, { metricType, entryRealMcUsd });
      const tev = buildTimelineEvent(e, metricType, entryRealMcUsd);
      liveTimelines.set(mint, tev ? [tev] : []);
    } else if (e.kind === 'peak') {
      const o = om.get(mint);
      if (o) {
        o.peakMcUsd = Math.max(o.peakMcUsd, Number(e.peakMcUsd ?? 0));
        o.peakPnlPct = Math.max(o.peakPnlPct, Number(e.peakPnlPct ?? 0));
        o.trailingArmed = o.trailingArmed || Boolean(e.trailingArmed);
      }
    } else if (e.kind === 'dca_add') {
      const o = om.get(mint);
      if (o) {
        const tiu = Number(e.totalInvestedUsd ?? 0);
        if (tiu > 0) o.totalInvestedUsd = tiu;
        o.remainingFraction = 1;
      }
      const meta = liveMeta.get(mint) ?? { metricType: null, entryRealMcUsd: null };
      const tev = buildTimelineEvent(e, meta.metricType, meta.entryRealMcUsd);
      if (tev) {
        const arr = liveTimelines.get(mint) ?? [];
        arr.push(tev);
        liveTimelines.set(mint, arr);
      }
    } else if (e.kind === 'partial_sell') {
      const o = om.get(mint);
      if (o) {
        const rf = Number(e.remainingFraction ?? NaN);
        if (Number.isFinite(rf) && rf >= 0 && rf <= 1) o.remainingFraction = rf;
      }
      const meta = liveMeta.get(mint) ?? { metricType: null, entryRealMcUsd: null };
      const tev = buildTimelineEvent(e, meta.metricType, meta.entryRealMcUsd);
      if (tev) {
        const arr = liveTimelines.get(mint) ?? [];
        arr.push(tev);
        liveTimelines.set(mint, arr);
      }
    } else if (e.kind === 'close') {
      const meta = liveMeta.get(mint) ?? { metricType: null, entryRealMcUsd: null };
      const tev = buildTimelineEvent(e, meta.metricType, meta.entryRealMcUsd);
      const arr = liveTimelines.get(mint) ?? [];
      if (tev) arr.push(tev);
      const pvEntry = entryPriceVerifyByMint.get(mint) ?? {
        entryPriceVerifySlipPct: null,
        entryPriceVerifyImpactPct: null,
        entryPriceVerifySource: null,
      };
      entryPriceVerifyByMint.delete(mint);
      const closedRow: Paper2ClosedRow = { ...e, ...pvEntry, __timeline: arr };
      cl.push(closedRow);
      om.delete(mint);
      liveMeta.delete(mint);
      liveTimelines.delete(mint);
    }
  }
  const failReasons = [...failReasonsCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([reason, count]) => ({ reason, count }));
  /** Последняя строка `reset` в журнале — дашборд считает только закрытия с exitTs ≥ reset.ts (jsonl не режем). */
  const closedVisible =
    resetTs > 0 ? cl.filter((c) => Number((c as { exitTs?: unknown }).exitTs ?? 0) >= resetTs) : cl;
  return {
    open: [...om.values()],
    closed: closedVisible,
    firstTs: f,
    lastTs: l,
    resetTs,
    evals1h,
    passed1h,
    failReasons,
    openTimelines: liveTimelines,
  };
}

export type Paper2FileLoad = ReturnType<typeof loadPaper2File>;

type LiveOscarPaper2Extras = {
  liveReconcileBoot?: DashboardPaper2StrategyRow['liveReconcileBoot'];
  liveReconcileReport?: DashboardPaper2StrategyRow['liveReconcileReport'];
};

export type LiveOscarPaper2Load = Paper2FileLoad & {
  hbOpen: number;
  hbClosed: number;
  liveExtras?: LiveOscarPaper2Extras;
};

function entryRealMcFromLiveOpenTrade(ot: Record<string, unknown>): number | null {
  const em = ot.entryMetrics as Record<string, unknown> | undefined;
  if (!em || typeof em !== 'object') return null;
  const mc = Number(em.market_cap_usd ?? em.fdv_usd ?? 0);
  return Number.isFinite(mc) && mc > 0 ? mc : null;
}

function emptyLiveOscarPaper2Load(): LiveOscarPaper2Load {
  const z = Date.now();
  return {
    open: [],
    closed: [],
    firstTs: z,
    lastTs: z,
    resetTs: 0,
    evals1h: 0,
    passed1h: 0,
    failReasons: [],
    openTimelines: new Map(),
    hbOpen: 0,
    hbClosed: 0,
  };
}

/**
 * Parse `live-oscar` JSONL (`channel: live`) into the same shapes as `loadPaper2File`,
 * including per-mint timelines with optional `txSignature` (from `execution_result` correlation).
 */
export function loadLiveOscarJsonlAsPaper2(filePath: string): LiveOscarPaper2Load {
  if (!fs.existsSync(filePath)) return emptyLiveOscarPaper2Load();

  const om = new Map<string, Paper2OpenItem>();
  const cl: Paper2ClosedRow[] = [];
  let f = Date.now();
  let l = 0;
  let resetTs = 0;
  const failReasonsCount = new Map<string, number>();
  const since1h = Date.now() - 3_600_000;
  let evals1h = 0;
  let passed1h = 0;
  let hbOpen = 0;
  let hbClosed = 0;
  let liveReconcileBoot: LiveOscarPaper2Extras['liveReconcileBoot'];
  let liveReconcileReport: LiveOscarPaper2Extras['liveReconcileReport'];

  const liveTimelines = new Map<string, TimelineEvent[]>();
  const liveMeta = new Map<string, { metricType: string | null; entryRealMcUsd: number | null }>();

  const intentToMint = new Map<string, string>();
  const sigQueues = new Map<string, string[]>();

  const enqueueSig = (mint: string, sig: string) => {
    const q = sigQueues.get(mint) ?? [];
    q.push(sig);
    sigQueues.set(mint, q);
  };
  const dequeueSig = (mint: string): string | undefined => {
    const q = sigQueues.get(mint);
    if (!q?.length) return undefined;
    const s = q.shift()!;
    if (!q.length) sigQueues.delete(mint);
    else sigQueues.set(mint, q);
    return s;
  };

  const attachSig = (mint: string, ev: TimelineEvent | null): TimelineEvent | null => {
    if (!ev) return null;
    const sig = dequeueSig(mint);
    if (!sig) return ev;
    return { ...ev, txSignature: sig };
  };

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return emptyLiveOscarPaper2Load();
  }

  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(t) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (o.channel !== 'live') continue;

    const ts = typeof o.ts === 'number' ? o.ts : 0;
    if (ts) {
      if (ts < f) f = ts;
      if (ts > l) l = ts;
    }

    const kind = o.kind;

    if (kind === 'reset') {
      resetTs = ts;
      continue;
    }

    if (kind === 'heartbeat') {
      hbOpen = Number(o.openPositions ?? 0);
      hbClosed = Number(o.closedTotal ?? 0);
      const st = o.reconcileBootStatus;
      if (typeof st === 'string' && st) {
        const div = o.reconcileMintsDivergent;
        const chain = o.reconcileChainOnlyMints;
        liveReconcileBoot = {
          status: st,
          skipReason: typeof o.reconcileBootSkipReason === 'string' ? o.reconcileBootSkipReason : undefined,
          divergentCount: Array.isArray(div) ? div.length : undefined,
          chainOnlyCount: Array.isArray(chain) ? chain.length : undefined,
          journalTruncated: typeof o.journalReplayTruncated === 'boolean' ? o.journalReplayTruncated : undefined,
        };
      }
      continue;
    }

    if (kind === 'live_reconcile_report') {
      const ta = o.txAnchorSample as { notFound?: unknown[]; rpcErrors?: unknown } | undefined;
      liveReconcileReport = {
        ts,
        ok: Boolean(o.ok),
        reconcileStatus: String(o.reconcileStatus ?? ''),
        txAnchorMissing: Array.isArray(ta?.notFound) ? ta.notFound.length : undefined,
        txAnchorRpcErrors: typeof ta?.rpcErrors === 'number' ? ta.rpcErrors : undefined,
      };
      continue;
    }

    if (kind === 'execution_attempt') {
      if (ts >= since1h) evals1h += 1;
      const id = String(o.intentId ?? '');
      const m = String(o.mint ?? '');
      if (id && m) intentToMint.set(id, m);
      continue;
    }

    if (kind === 'execution_result') {
      const id = String(o.intentId ?? '');
      const mint = intentToMint.get(id);
      const sigRaw = o.txSignature;
      const status = String(o.status ?? '');
      if (mint && typeof sigRaw === 'string') {
        const sig = sigRaw.trim();
        if (sig.length >= 64) enqueueSig(mint, sig);
      }
      intentToMint.delete(id);
      if (ts >= since1h && (status === 'sim_ok' || status === 'confirmed')) passed1h += 1;
      continue;
    }

    if (kind === 'execution_skip' && typeof o.reason === 'string' && o.reason) {
      failReasonsCount.set(o.reason, (failReasonsCount.get(o.reason) ?? 0) + 1);
      continue;
    }

    const mint = String(o.mint ?? '');
    if (!mint) continue;

    if (kind === 'live_position_open') {
      const ot = (o.openTrade ?? {}) as Record<string, unknown>;
      const metricType = ot.metricType != null ? String(ot.metricType) : null;
      const entryRealMcUsd = entryRealMcFromLiveOpenTrade(ot);
      const legsArr = Array.isArray(ot.legs) ? (ot.legs as Record<string, unknown>[]) : [];
      const legMp = legsArr[0] ? Number(legsArr[0].marketPrice ?? 0) : 0;
      const emp = Number(ot.avgEntryMarket ?? 0);
      const baselinePriceUsd = emp > 0 ? emp : legMp > 0 ? legMp : null;

      om.set(mint, {
        mint,
        symbol: String(ot.symbol ?? ''),
        entryTs: Number(ot.entryTs ?? 0),
        entryMcUsd: Number(ot.entryMcUsd ?? 0),
        entryRealMcUsd,
        baselinePriceUsd,
        openedAtIso: ot.entryTs ? new Date(Number(ot.entryTs)).toISOString() : null,
        lane: ot.lane != null ? String(ot.lane) : null,
        source: ot.source != null ? String(ot.source) : null,
        metricType,
        features: null,
        btc: null,
        peakMcUsd: Number(ot.peakMcUsd ?? 0),
        peakPnlPct: Number(ot.peakPnlPct ?? 0),
        trailingArmed: Boolean(ot.trailingArmed),
        totalInvestedUsd: Number(ot.totalInvestedUsd ?? 0),
        entryPriorityFeeUsd: null,
        entryPriceVerifySlipPct: null,
        entryPriceVerifyImpactPct: null,
        entryPriceVerifySource: null,
        pairAddress: ot.pairAddress != null ? String(ot.pairAddress).trim() || null : null,
        entryLiqUsd: typeof ot.entryLiqUsd === 'number' && ot.entryLiqUsd > 0 ? ot.entryLiqUsd : null,
        remainingFraction: Number(ot.remainingFraction ?? 1),
      });
      liveMeta.set(mint, { metricType, entryRealMcUsd });

      const emMc0 = entryRealMcFromLiveOpenTrade(ot);
      const syn: Record<string, unknown> = {
        kind: 'open',
        ts,
        mint,
        symbol: ot.symbol,
        lane: ot.lane,
        source: ot.source,
        dex: ot.dex,
        entryTs: ot.entryTs,
        entryMcUsd: ot.entryMcUsd,
        entryMarketPrice: legsArr[0] ? legsArr[0].marketPrice ?? ot.entryMcUsd : ot.entryMcUsd,
        legs: ot.legs,
        totalInvestedUsd: ot.totalInvestedUsd,
        metricType,
        ...(emMc0 != null && emMc0 > 0 ? { mcUsdLive: emMc0 } : {}),
        ...(typeof o.timelineOpenLabelRu === 'string' && o.timelineOpenLabelRu.trim()
          ? { timelineOpenLabelRu: o.timelineOpenLabelRu.trim() }
          : {}),
        ...(typeof ot.tpRegime === 'string' && ot.tpRegime.trim() ? { tpRegime: ot.tpRegime } : {}),
        ...(ot.liveExitProfileMode === 'A' || ot.liveExitProfileMode === 'B'
          ? { liveExitProfileMode: ot.liveExitProfileMode }
          : {}),
      };
      const tev = attachSig(mint, buildTimelineEvent(syn, metricType, entryRealMcUsd));
      liveTimelines.set(mint, tev ? [tev] : []);
      continue;
    }

    if (kind === 'live_position_scale_in') {
      const ot = (o.openTrade ?? {}) as Record<string, unknown>;
      const meta = liveMeta.get(mint) ?? { metricType: null, entryRealMcUsd: null };
      const legsArr = Array.isArray(ot.legs) ? (ot.legs as Record<string, unknown>[]) : [];
      const lastLeg = legsArr[legsArr.length - 1];
      if (!lastLeg || String(lastLeg.reason ?? '') !== 'scale_in') continue;
      const posUsd = Number(ot.totalInvestedUsd ?? 0);
      const legUsd = Number(lastLeg.sizeUsd ?? 0);
      const fracFull = posUsd > 0 && legUsd > 0 ? legUsd / posUsd : 0;

      const baseLab =
        fracFull > 0 ? `Докупка ${Math.round(fracFull * 100)}% позиции` : 'Докупка второй ноги входа';
      const syn: Record<string, unknown> = {
        kind: 'scale_in_add',
        ts,
        mint,
        marketPrice: Number(lastLeg.marketPrice ?? lastLeg.price ?? 0),
        sizeUsd: legUsd,
        secondLegFractionOfFull: fracFull > 0 ? +fracFull.toFixed(6) : undefined,
        timelineLabelRu:
          ot.liveExitProfileMode === 'B' ? `${baseLab} · режим выхода B` : baseLab,
        totalInvestedUsd: ot.totalInvestedUsd,
        mcUsdLive: undefined,
        ...(ot.liveExitProfileMode === 'A' || ot.liveExitProfileMode === 'B'
          ? { liveExitProfileMode: ot.liveExitProfileMode }
          : {}),
      };
      const tev = attachSig(mint, buildTimelineEvent(syn, meta.metricType, meta.entryRealMcUsd));
      if (tev) {
        const arr = liveTimelines.get(mint) ?? [];
        arr.push(tev);
        liveTimelines.set(mint, arr);
      }
      const cur = om.get(mint);
      if (cur) {
        const tiu = Number(ot.totalInvestedUsd ?? 0);
        if (tiu > 0) cur.totalInvestedUsd = tiu;
        cur.remainingFraction = 1;
      }
      continue;
    }

    if (kind === 'live_position_dca') {
      const ot = (o.openTrade ?? {}) as Record<string, unknown>;
      const meta = liveMeta.get(mint) ?? { metricType: null, entryRealMcUsd: null };
      const legsArr = Array.isArray(ot.legs) ? (ot.legs as Record<string, unknown>[]) : [];
      const lastLeg = legsArr[legsArr.length - 1];
      if (!lastLeg) continue;
      const usedIdx = Array.isArray(ot.dcaUsedIndices) ? (ot.dcaUsedIndices as number[]) : [];
      const dcaStepIndex = usedIdx.length ? usedIdx[usedIdx.length - 1]! : Math.max(0, legsArr.length - 2);
      const dcaLevelsTotal =
        Array.isArray(ot.dcaUsedLevels) && ot.dcaUsedLevels.length > 0 ? ot.dcaUsedLevels.length : 1;

      const trig = Number(lastLeg.triggerPct ?? 0);
      const syn: Record<string, unknown> = {
        kind: 'dca_add',
        ts,
        mint,
        marketPrice: Number(lastLeg.marketPrice ?? lastLeg.price ?? 0),
        sizeUsd: Number(lastLeg.sizeUsd ?? 0),
        triggerPct: trig,
        dcaStepIndex,
        dcaLevelsTotal,
        totalInvestedUsd: ot.totalInvestedUsd,
        mcUsdLive: undefined,
        ...(ot.liveExitProfileMode === 'B'
          ? {
              timelineLabelRu: `DCA шаг ${dcaStepIndex + 1}/${dcaLevelsTotal} (${(trig * 100).toFixed(0)}%) · режим выхода B`,
              liveExitProfileMode: 'B',
            }
          : ot.liveExitProfileMode === 'A'
            ? { liveExitProfileMode: 'A' }
            : {}),
      };
      const tev = attachSig(mint, buildTimelineEvent(syn, meta.metricType, meta.entryRealMcUsd));
      if (tev) {
        const arr = liveTimelines.get(mint) ?? [];
        arr.push(tev);
        liveTimelines.set(mint, arr);
      }
      const cur = om.get(mint);
      if (cur) {
        const tiu = Number(ot.totalInvestedUsd ?? 0);
        if (tiu > 0) cur.totalInvestedUsd = tiu;
        cur.remainingFraction = 1;
      }
      continue;
    }

    if (kind === 'live_position_partial_sell') {
      const ot = (o.openTrade ?? {}) as Record<string, unknown>;
      const meta = liveMeta.get(mint) ?? { metricType: null, entryRealMcUsd: null };
      const partials = Array.isArray(ot.partialSells) ? (ot.partialSells as Record<string, unknown>[]) : [];
      const ps = partials[partials.length - 1];
      if (!ps) continue;
      const ladderUsed = Array.isArray(ot.ladderUsedIndices) ? (ot.ladderUsedIndices as number[]) : [];
      const stepIdx = ladderUsed.length ? ladderUsed[ladderUsed.length - 1]! : 0;
      const lvlArr = Array.isArray(ot.ladderUsedLevels) ? (ot.ladderUsedLevels as number[]) : [];
      const ladderRungsTotal = lvlArr.length > 0 ? lvlArr.length : 2;
      const ladderPnlPctRaw =
        lvlArr.length > stepIdx ? lvlArr[stepIdx] : lvlArr.length ? lvlArr[lvlArr.length - 1] : 0;

      const syn: Record<string, unknown> = {
        kind: 'partial_sell',
        ts,
        mint,
        marketPrice: Number(ps.marketPrice ?? ps.price ?? 0),
        sellFraction: Number(ps.sellFraction ?? 0),
        ladderStepIndex: stepIdx,
        ladderRungsTotal,
        ladderPnlPct: Number(ladderPnlPctRaw ?? 0),
        reason: String(ps.reason ?? 'partial_sell'),
        proceedsUsd: Number(ps.proceedsUsd ?? 0),
        pnlUsd: Number(ps.pnlUsd ?? 0),
        remainingFraction: Number(ot.remainingFraction ?? 0),
        mcUsdLive: undefined,
      };
      const tev = attachSig(mint, buildTimelineEvent(syn, meta.metricType, meta.entryRealMcUsd));
      if (tev) {
        const arr = liveTimelines.get(mint) ?? [];
        arr.push(tev);
        liveTimelines.set(mint, arr);
      }
      const op = om.get(mint);
      if (op) {
        const rf = Number(ot.remainingFraction ?? NaN);
        if (Number.isFinite(rf) && rf >= 0 && rf <= 1) op.remainingFraction = rf;
      }
      continue;
    }

    if (kind === 'live_position_close') {
      const ct = (o.closedTrade ?? {}) as Record<string, unknown>;
      const meta = liveMeta.get(mint) ?? { metricType: null, entryRealMcUsd: null };
      const syn: Record<string, unknown> = {
        kind: 'close',
        ts,
        mint,
        exitTs: ct.exitTs,
        exitMcUsd: ct.exitMcUsd,
        exit_market_price:
          Number(ct.theoretical_exit_price ?? ct.effective_exit_price ?? ct.exitMcUsd ?? 0) || undefined,
        pnlPct: ct.pnlPct,
        netPnlUsd: ct.netPnlUsd,
        exitReason: ct.exitReason,
        remainingFraction: 0,
        totalInvestedUsd: ct.totalInvestedUsd,
        ...(typeof ct.tpRegime === 'string' && ct.tpRegime.trim() ? { tpRegime: ct.tpRegime } : {}),
        ...(ct.liveExitProfileMode === 'A' || ct.liveExitProfileMode === 'B'
          ? { liveExitProfileMode: ct.liveExitProfileMode }
          : {}),
      };
      const tev = attachSig(mint, buildTimelineEvent(syn, meta.metricType, meta.entryRealMcUsd));
      const arr = liveTimelines.get(mint) ?? [];
      if (tev) arr.push(tev);

      const closedRow: Paper2ClosedRow = {
        ...ct,
        mint,
        symbol: ct.symbol ?? om.get(mint)?.symbol ?? '',
        __timeline: arr,
      };
      cl.push(closedRow);
      om.delete(mint);
      liveMeta.delete(mint);
      liveTimelines.delete(mint);
    }
  }

  const failReasons = [...failReasonsCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([reason, count]) => ({ reason, count }));

  const closedVisible =
    resetTs > 0 ? cl.filter((c) => Number((c as { exitTs?: unknown }).exitTs ?? 0) >= resetTs) : cl;

  const extras: LiveOscarPaper2Extras | undefined =
    liveReconcileBoot || liveReconcileReport
      ? { ...(liveReconcileBoot ? { liveReconcileBoot } : {}), ...(liveReconcileReport ? { liveReconcileReport } : {}) }
      : undefined;

  return {
    open: [...om.values()],
    closed: closedVisible,
    firstTs: f,
    lastTs: l,
    resetTs,
    evals1h,
    passed1h,
    failReasons,
    openTimelines: liveTimelines,
    hbOpen,
    hbClosed,
    ...(extras ? { liveExtras: extras } : {}),
  };
}

function paper2Metrics(closed: Paper2ClosedRow[]): {
  total: number;
  wins: number;
  winRate: number;
  sumPnlUsd: number;
  avgPnl: number;
  avgPeak: number;
  bestPnlUsd: number;
  worstPnlUsd: number;
  exits: Record<string, number>;
  exitsBreakdown: Record<string, { count: number; sumPct: number; sumUsd: number; avgPct: number }>;
} {
  const exitKinds = [
    'TP',
    'SL',
    'TRAIL',
    'TIMEOUT',
    'NO_DATA',
    'KILLSTOP',
    'LIQ_DRAIN',
    'RECONCILE_ORPHAN',
    'PERIODIC_HEAL',
    'CAPITAL_ROTATE',
  ] as const;
  const exits: Record<string, number> = Object.fromEntries(exitKinds.map((k) => [k, 0]));
  const breakdown: Record<string, { count: number; sumPct: number; sumUsd: number; avgPct: number }> =
    Object.fromEntries(exitKinds.map((k) => [k, { count: 0, sumPct: 0, sumUsd: 0, avgPct: 0 }]));
  if (!closed.length) {
    return {
      total: 0,
      wins: 0,
      winRate: 0,
      sumPnlUsd: 0,
      avgPnl: 0,
      avgPeak: 0,
      bestPnlUsd: 0,
      worstPnlUsd: 0,
      exits,
      exitsBreakdown: breakdown,
    };
  }
  let sumPct = 0;
  let sumPeak = 0;
  let wins = 0;
  let bestUsd = -Infinity;
  let worstUsd = Infinity;
  let sumUsd = 0;
  for (const c of closed) {
    const pnlPct = Number(c.pnlPct ?? 0);
    const netUsd = c.netPnlUsd;
    const pnlUsd =
      typeof netUsd === 'number' && Number.isFinite(netUsd)
        ? netUsd
        : (POSITION_USD_DEFAULT * pnlPct) / 100;
    sumPct += pnlPct;
    sumUsd += pnlUsd;
    sumPeak += Number(c.peakPnlPct ?? c['peak_pnl_pct'] ?? 0);
    if (pnlPct > 0) wins++;
    if (pnlUsd > bestUsd) bestUsd = pnlUsd;
    if (pnlUsd < worstUsd) worstUsd = pnlUsd;
    const r = String(c.exitReason ?? 'NO_DATA');
    if (exits[r] != null) exits[r]++;
    if (breakdown[r]) {
      breakdown[r].count++;
      breakdown[r].sumPct += pnlPct;
      breakdown[r].sumUsd += pnlUsd;
    }
  }
  for (const k of Object.keys(breakdown)) {
    breakdown[k].avgPct = breakdown[k].count ? breakdown[k].sumPct / breakdown[k].count : 0;
  }
  return {
    total: closed.length,
    wins,
    winRate: (wins / closed.length) * 100,
    sumPnlUsd: sumUsd,
    avgPnl: sumPct / closed.length,
    avgPeak: sumPeak / closed.length,
    bestPnlUsd: bestUsd === -Infinity ? 0 : bestUsd,
    worstPnlUsd: worstUsd === Infinity ? 0 : worstUsd,
    exits,
    exitsBreakdown: breakdown,
  };
}

function makeEmptyDashboardStrategyRow(strategyId: string, file: string): DashboardPaper2StrategyRow {
  const m = paper2Metrics([]);
  return {
    strategyId,
    file,
    openCount: 0,
    closedCount: 0,
    startedAt: Date.now(),
    lastTs: 0,
    hoursOfData: 0,
    sumPnlUsd: m.sumPnlUsd,
    realizedPnlUsd: 0,
    unrealizedPnlUsd: 0,
    totalPnlUsd: 0,
    winRate: m.winRate,
    avgPnl: m.avgPnl,
    avgPeak: m.avgPeak,
    bestPnlUsd: m.bestPnlUsd,
    worstPnlUsd: m.worstPnlUsd,
    unrealizedUsd: 0,
    exits: m.exits,
    exitsBreakdown: m.exitsBreakdown,
    evals1h: 0,
    passed1h: 0,
    failReasons: [],
    open: [],
    recentClosed: [],
    priorityFeeUsdTotal: 0,
    priceVerify: { okCount: 0, blockedCount: 0, skippedCount: 0, avgSlipPct: null, p90SlipPct: null },
    liqDrain: { exits: 0, avgDropPct: null, p90DropPct: null },
  };
}

/**
 * Summarize live-oscar JSONL for tests and lightweight callers (no PG/Jupiter enrichment).
 * Full `/api/paper2` row uses `loadLiveOscarJsonlAsPaper2` + `buildPaper2StrategyRowFromLoad`.
 */
export function aggregateLiveOscarJsonlForDashboard(filePath: string): DashboardPaper2StrategyRow {
  const fallback = (): DashboardPaper2StrategyRow => makeEmptyDashboardStrategyRow('live-oscar', filePath);
  if (!fs.existsSync(filePath)) return fallback();

  const ll = loadLiveOscarJsonlAsPaper2(filePath);
  const m = paper2Metrics(ll.closed);
  const startedAt = ll.resetTs || ll.firstTs;
  const now = Date.now();

  return {
    strategyId: 'live-oscar',
    file: filePath,
    openCount: Math.max(ll.open.length, ll.hbOpen),
    closedCount: Math.max(ll.closed.length, ll.hbClosed),
    startedAt,
    lastTs: ll.lastTs > 0 ? ll.lastTs : startedAt,
    hoursOfData: (now - startedAt) / 3_600_000,
    sumPnlUsd: m.sumPnlUsd,
    realizedPnlUsd: 0,
    unrealizedPnlUsd: 0,
    totalPnlUsd: 0,
    winRate: m.winRate,
    avgPnl: m.avgPnl,
    avgPeak: m.avgPeak,
    bestPnlUsd: m.bestPnlUsd,
    worstPnlUsd: m.worstPnlUsd,
    unrealizedUsd: 0,
    exits: m.exits,
    exitsBreakdown: m.exitsBreakdown,
    evals1h: ll.evals1h,
    passed1h: ll.passed1h,
    failReasons: ll.failReasons,
    open: [],
    recentClosed: [],
    priorityFeeUsdTotal: 0,
    priceVerify: { okCount: 0, blockedCount: 0, skippedCount: 0, avgSlipPct: null, p90SlipPct: null },
    liqDrain: { exits: 0, avgDropPct: null, p90DropPct: null },
    ...(ll.liveExtras ?? {}),
  };
}

/** Enforce fixed four columns: Live Oscar, Paper Oscar, Deep Runner, Dno. */
export function mergeDashboardStrategyPanels(rows: DashboardPaper2StrategyRow[]): DashboardPaper2StrategyRow[] {
  const byId = new Map(rows.map((r) => [r.strategyId, r]));
  return DASHBOARD_PANEL_ORDER.map((id) => byId.get(id) ?? makeEmptyDashboardStrategyRow(id, '—'));
}

app.get('/papertrader2', async (_req, reply) => {
  reply.header('content-type', 'text/html; charset=utf-8');
  return fs.readFileSync(HTML2_PATH, 'utf-8');
});

app.get('/smart-lottery', async (_req, reply) => {
  reply.header('content-type', 'text/html; charset=utf-8');
  return fs.readFileSync(HTML_SMLOT_PATH, 'utf-8');
});

app.get('/SmartLottery', async (_req, reply) => {
  reply.header('content-type', 'text/html; charset=utf-8');
  return fs.readFileSync(HTML_SMLOT_PATH, 'utf-8');
});

app.get('/api/paper2/priority-fee', async (_req, reply) => {
  reply.header('cache-control', 'no-store');
  const solUsd = Number(process.env.DASHBOARD_SOL_USD ?? 160);
  const targetCu = Number(process.env.PAPER_PRIORITY_FEE_TARGET_CU ?? 200_000);
  const payload = buildPriorityFeeMonitorApiPayload({
    solUsd: Number.isFinite(solUsd) && solUsd > 0 ? solUsd : 160,
    targetCu: Number.isFinite(targetCu) && targetCu > 0 ? targetCu : 200_000,
  });
  if (payload.ok !== true) {
    reply.code(503);
    return payload;
  }
  return payload;
});

// ---------------------------------------------------------
// PaperTrader2 header: BTC spot · wallet SOL (RPC) · SOL spot — % vs 30m / 1h / 4h / 12h for spots (CoinGecko)
// ---------------------------------------------------------
const CRYPTO_TICKER_SPOT_SPECS = [
  { coingeckoId: 'bitcoin', symbol: 'BTC' },
  { coingeckoId: 'solana', symbol: 'SOL' },
] as const;

interface CryptoTickerAssetRow {
  id: string;
  symbol: string;
  /** Middle panel: native SOL balance via getBalance (not CoinGecko). */
  rowKind?: 'coingecko' | 'wallet_sol';
  balanceSol?: number | null;
  walletPubkeyShort?: string | null;
  priceUsd: number | null;
  chg30mPct: number | null;
  chg1hPct: number | null;
  chg4hPct: number | null;
  chg12hPct: number | null;
}

interface CryptoTickerApiPayload {
  ok: boolean;
  updatedAt: number;
  source: 'coingecko';
  assets: CryptoTickerAssetRow[];
  error?: string;
}

function cgApiBaseAndHeaders(): { base: string; headers: Record<string, string> } {
  const key = (process.env.COINGECKO_API_KEY || '').trim();
  if (key) {
    return {
      base: 'https://pro-api.coingecko.com/api/v3',
      headers: { 'x-cg-pro-api-key': key },
    };
  }
  return { base: 'https://api.coingecko.com/api/v3', headers: {} };
}

/** Last sample at or before target time (chart series is sorted asc by ms). */
function priceAtOrBefore(series: [number, number][], targetMs: number): number | null {
  if (!Array.isArray(series) || series.length === 0) return null;
  let lo = 0;
  let hi = series.length - 1;
  let bestIdx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const ts = series[mid][0];
    if (ts <= targetMs) {
      bestIdx = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (bestIdx < 0) return null;
  const px = Number(series[bestIdx][1]);
  return Number.isFinite(px) && px > 0 ? px : null;
}

function pctChangeVsPast(current: number | null, past: number | null): number | null {
  if (current == null || past == null || past <= 0 || current <= 0) return null;
  return +(((current - past) / past) * 100).toFixed(4);
}

let cryptoTickerCache: { at: number; payload: CryptoTickerApiPayload } | null = null;

async function fetchWalletSolTickerRow(signal: AbortSignal): Promise<CryptoTickerAssetRow> {
  const pk = (process.env.LIVE_WALLET_PUBKEY || process.env.HOURLY_WALLET_PUBKEY || '').trim();
  const rpc = (process.env.HOURLY_RPC_URL || process.env.SA_RPC_HTTP_URL || process.env.SA_RPC_URL || '').trim();
  const base: CryptoTickerAssetRow = {
    id: 'wallet_sol',
    symbol: 'Wallet',
    rowKind: 'wallet_sol',
    priceUsd: null,
    balanceSol: null,
    walletPubkeyShort: pk ? `${pk.slice(0, 4)}…${pk.slice(-4)}` : null,
    chg30mPct: null,
    chg1hPct: null,
    chg4hPct: null,
    chg12hPct: null,
  };
  if (!pk || !rpc) return base;
  try {
    const res = await fetch(rpc, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getBalance',
        params: [pk, { commitment: 'confirmed' }],
      }),
      signal,
    });
    const j = (await res.json()) as { result?: unknown; error?: { message?: string } };
    if (j.error) return { ...base, balanceSol: null };
    const lamports = lamportsFromGetBalanceResult(j.result);
    if (lamports == null) return base;
    const sol = Number(lamports) / 1e9;
    return { ...base, balanceSol: Number.isFinite(sol) ? sol : null };
  } catch {
    return base;
  }
}

async function fetchCryptoTickerPayload(): Promise<CryptoTickerApiPayload> {
  const now = Date.now();
  const cached = cryptoTickerCache;
  const ttlMs = cached?.payload.ok === false ? 20_000 : 60_000;
  if (cached && now - cached.at < ttlMs) return cached.payload;

  const { base, headers } = cgApiBaseAndHeaders();
  const ids = CRYPTO_TICKER_SPOT_SPECS.map((s) => s.coingeckoId).join(',');
  const signal = AbortSignal.timeout(14_000);

  const emptySpotRows = (): CryptoTickerAssetRow[] =>
    CRYPTO_TICKER_SPOT_SPECS.map((s) => ({
      id: s.coingeckoId,
      symbol: s.symbol,
      priceUsd: null,
      chg30mPct: null,
      chg1hPct: null,
      chg4hPct: null,
      chg12hPct: null,
    }));

  try {
    const walletRowPromise = fetchWalletSolTickerRow(signal);

    const simpleUrl = `${base}/simple/price?ids=${encodeURIComponent(ids)}&vs_currencies=usd`;
    const simpleRes = await fetch(simpleUrl, { headers, signal });
    if (!simpleRes.ok) {
      const spot = emptySpotRows();
      const walletRow = await walletRowPromise;
      const errPayload: CryptoTickerApiPayload = {
        ok: false,
        updatedAt: now,
        source: 'coingecko',
        assets: [spot[0]!, walletRow, spot[1]!],
        error: `simple/price HTTP ${simpleRes.status}`,
      };
      cryptoTickerCache = { at: now, payload: errPayload };
      return errPayload;
    }
    const simpleJson = (await simpleRes.json()) as Record<string, { usd?: number } | undefined>;

    const chartPromises = CRYPTO_TICKER_SPOT_SPECS.map(async (spec) => {
      const url = `${base}/coins/${spec.coingeckoId}/market_chart?vs_currency=usd&days=1`;
      try {
        const r = await fetch(url, { headers, signal });
        if (!r.ok) return { id: spec.coingeckoId, prices: null as [number, number][] | null };
        const j = (await r.json()) as { prices?: [number, number][] };
        return { id: spec.coingeckoId, prices: Array.isArray(j.prices) ? j.prices : null };
      } catch {
        return { id: spec.coingeckoId, prices: null };
      }
    });

    const [charts, walletRow] = await Promise.all([Promise.all(chartPromises), walletRowPromise]);
    const chartById = new Map(charts.map((c) => [c.id, c.prices]));

    const t30 = now - 30 * 60 * 1000;
    const t1h = now - 60 * 60 * 1000;
    const t4h = now - 4 * 60 * 60 * 1000;
    const t12h = now - 12 * 60 * 60 * 1000;

    const spotAssets: CryptoTickerAssetRow[] = CRYPTO_TICKER_SPOT_SPECS.map((spec) => {
      const row = simpleJson[spec.coingeckoId];
      let priceUsd =
        row && typeof row.usd === 'number' && Number.isFinite(row.usd) && row.usd > 0 ? row.usd : null;

      const series = chartById.get(spec.coingeckoId);
      if (priceUsd == null && series?.length) {
        const last = series[series.length - 1];
        const lp = Number(last[1]);
        if (Number.isFinite(lp) && lp > 0) priceUsd = lp;
      }

      const p30 = series ? priceAtOrBefore(series, t30) : null;
      const p1h = series ? priceAtOrBefore(series, t1h) : null;
      const p4h = series ? priceAtOrBefore(series, t4h) : null;
      const p12 = series ? priceAtOrBefore(series, t12h) : null;

      return {
        id: spec.coingeckoId,
        symbol: spec.symbol,
        priceUsd,
        chg30mPct: pctChangeVsPast(priceUsd, p30),
        chg1hPct: pctChangeVsPast(priceUsd, p1h),
        chg4hPct: pctChangeVsPast(priceUsd, p4h),
        chg12hPct: pctChangeVsPast(priceUsd, p12),
      };
    });

    const assets: CryptoTickerAssetRow[] = [spotAssets[0]!, walletRow, spotAssets[1]!];

    const anyPrice = spotAssets.some((a) => a.priceUsd != null);
    const payload: CryptoTickerApiPayload = {
      ok: anyPrice,
      updatedAt: now,
      source: 'coingecko',
      assets,
      ...(anyPrice ? {} : { error: 'no_prices' }),
    };
    cryptoTickerCache = { at: Date.now(), payload };
    return payload;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const spot = emptySpotRows();
    let walletRow: CryptoTickerAssetRow;
    try {
      walletRow = await fetchWalletSolTickerRow(signal);
    } catch {
      walletRow = {
        id: 'wallet_sol',
        symbol: 'Wallet',
        rowKind: 'wallet_sol',
        priceUsd: null,
        balanceSol: null,
        walletPubkeyShort: null,
        chg30mPct: null,
        chg1hPct: null,
        chg4hPct: null,
        chg12hPct: null,
      };
    }
    const errPayload: CryptoTickerApiPayload = {
      ok: false,
      updatedAt: now,
      source: 'coingecko',
      assets: [spot[0]!, walletRow, spot[1]!],
      error: msg,
    };
    cryptoTickerCache = { at: now, payload: errPayload };
    return errPayload;
  }
}

async function buildPaper2StrategyRowFromLoad(
  fp: string,
  sid: string,
  loaded: Paper2FileLoad,
  hb?: { hbOpen?: number; hbClosed?: number; reconcileExtras?: LiveOscarPaper2Extras },
): Promise<DashboardPaper2StrategyRow & { open: Paper2ApiEnrichedOpen[] }> {
  const { open, closed, firstTs, lastTs, resetTs, evals1h, passed1h, failReasons, openTimelines } = loaded;
  const m = paper2Metrics(closed);
  const startedAt = resetTs || firstTs;
  const closedWithUsd = (
    await Promise.all(
      closed.map(async (c) => {
        const pnlPct = Number(c.pnlPct ?? 0);
        const netUsd = c.netPnlUsd;
        const pnlUsd =
          typeof netUsd === 'number' && Number.isFinite(netUsd)
            ? netUsd
            : (POSITION_USD_DEFAULT * pnlPct) / 100;
        const costs = c.costs as Record<string, unknown> | undefined;
        const timelineRaw = Array.isArray(c.__timeline) ? (c.__timeline as TimelineEvent[]) : [];
        const timelineSorted = timelineRaw.slice().sort((a, b) => a.ts - b.ts);
        const entryTs = Number(c.entryTs ?? 0);
        const entryMcapAtBuyUsd = await resolveEntryMcapAtBuyUsd(String(c.mint), entryTs, timelineSorted);
        const exitMcapUsd = exitMcapFromCloseTimelineEvent(timelineSorted);
        const exitPfUsd = Number((c as { priorityFee?: { usd?: number } }).priorityFee?.usd ?? 0);
        const exitPriorityFeeUsd =
          Number.isFinite(exitPfUsd) && exitPfUsd > 0 ? exitPfUsd : null;
        let tlOut = timelineSorted.map((ev: TimelineEvent) => ({ ...ev }));
        tlOut = filterSpuriousDcaOpenDuplicate(tlOut);
        if (
          tlOut.length &&
          tlOut[0].kind === 'open' &&
          entryMcapAtBuyUsd != null &&
          entryMcapAtBuyUsd > 0 &&
          (!(Number(tlOut[0].mcUsd) > 0) || tlOut[0].mcUsd == null)
        ) {
          tlOut[0] = { ...tlOut[0], mcUsd: entryMcapAtBuyUsd };
        }
        tlOut = await enrichTimelineMcapGaps(String(c.mint), tlOut);
        tlOut = finalizeTimelineForApi(tlOut);
        const closedDisplaySymbol = await resolveTokenSymbolForUi(String(c.mint), c.symbol);
        const entryPriceVerifySlipPct =
          typeof c.entryPriceVerifySlipPct === 'number' ? c.entryPriceVerifySlipPct : null;
        const entryPriceVerifyImpactPct =
          typeof c.entryPriceVerifyImpactPct === 'number' ? c.entryPriceVerifyImpactPct : null;
        const entryPriceVerifySource =
          c.entryPriceVerifySource === 'jupiter' ||
          c.entryPriceVerifySource === 'skipped' ||
          c.entryPriceVerifySource === 'blocked'
            ? c.entryPriceVerifySource
            : null;
        const lw = c.liqWatch as { currentLiqUsd?: unknown; dropPct?: unknown } | undefined;
        const exitLiqUsd =
          lw != null && Number.isFinite(Number(lw.currentLiqUsd)) && Number(lw.currentLiqUsd) > 0
            ? Number(lw.currentLiqUsd)
            : null;
        const exitLiqDropPct =
          lw != null && Number.isFinite(Number(lw.dropPct)) ? +Number(lw.dropPct).toFixed(2) : null;
        const exitContext = (c as { exitContext?: unknown }).exitContext ?? null;
        return {
          mint: c.mint,
          symbol: closedDisplaySymbol,
          exitTs: c.exitTs,
          entryTs: c.entryTs,
          exitReason: c.exitReason,
          pnlPct,
          pnlUsd,
          durationMin: Number(c.durationMin ?? 0),
          dex: costs && costs.dex,
          entryMcapAtBuyUsd,
          exitMcapUsd: exitMcapUsd != null && exitMcapUsd > 0 ? exitMcapUsd : null,
          exitPriorityFeeUsd,
          entryPriceVerifySlipPct,
          entryPriceVerifyImpactPct,
          entryPriceVerifySource,
          exitLiqUsd,
          exitLiqDropPct,
          exitContext,
          timeline: tlOut,
        };
      }),
    )
  )
    .sort((a, b) => Number(b.exitTs ?? 0) - Number(a.exitTs ?? 0))
    .slice(0, 20);

  // Enrich open positions with a live mcap (pump.fun -> DEX snapshot fallback),
  // recompute pnl% and pnl$ when possible. Capped to 30 rows for sanity.
  //
  // IMPORTANT: entryMcUsd in legacy jsonl is NOT a USD market cap — it's
  // a tiny per-token-price-like number (e.g. 0.003) that cannot be compared
  // with USD live mcap. Only entryRealMcUsd (taken from features.market_cap_usd
  // or features.fdv_usd at open-time) is a legitimate USD baseline.
  // We also clamp pnlPct to ±100000% to guard against absurd numbers if a
  // future jsonl row has a misclassified baseline.
  const PNL_PCT_CLAMP = 100_000; // 1000x
  const enrichedOpen: Paper2ApiEnrichedOpen[] = await Promise.all(
    open.slice(0, 30).map(async (ot): Promise<Paper2ApiEnrichedOpen> => {
      const timelineSorted = (openTimelines.get(ot.mint) ?? []).slice().sort((a, b) => a.ts - b.ts);
      const isMcMetric = ot.metricType === 'mc';
      /** pump.fun → DEX; used for mcap-based PnL only when metricType=mc. */
      const liveMcForPnl = isMcMetric ? await getCurrentMcAny(ot.mint).catch(() => null) : null;
      /** DEX snapshots often have mcap even for price-tracked (post-migration) pools — show in UI. */
      const dexMcDisplay =
        liveMcForPnl != null && liveMcForPnl > 0
          ? null
          : await getDexLiveMc(ot.mint).catch(() => null);
      let displayLiveMc: number | null =
        liveMcForPnl != null && liveMcForPnl > 0
          ? liveMcForPnl
          : dexMcDisplay != null && dexMcDisplay > 0
            ? dexMcDisplay
            : null;
      let liveMcProvenance: 'snapshots' | 'pump.fun' | null = null;
      if (displayLiveMc != null && displayLiveMc > 0) {
        liveMcProvenance = 'snapshots';
      } else {
        const pumpOnly = await getCurrentMc(ot.mint).catch(() => null);
        if (pumpOnly != null && pumpOnly > 0) {
          displayLiveMc = pumpOnly;
          liveMcProvenance = 'pump.fun';
        }
      }
      const hasLiveMc = displayLiveMc != null;

      const basePx = ot.baselinePriceUsd != null && ot.baselinePriceUsd > 0 ? ot.baselinePriceUsd : null;
      /**
       * Snapshots → Jupiter → journal spot.
       * Journal fallback must stay last: after partial TP the last timeline spot is the sell print,
       * not the current market — using it before Jupiter made UI PnL match «stuck at last TP» while
       * the tracker still uses PG/Jupiter for decisions (misleading «live mcap» / token row).
       */
      let livePx: number | null = null;
      let livePxProvenance: 'snapshots' | 'jupiter' | 'journal' | null = null;
      if (basePx) {
        livePx = await getDexLivePrice(ot.mint, ot.source).catch(() => null);
        if (livePx) livePxProvenance = 'snapshots';
      }
      let livePriceStale = false;
      if (!livePx && basePx) {
        const jpx = await getJupiterTokenPriceUsd(ot.mint).catch(() => null);
        if (jpx != null && jpx > 0) {
          livePx = jpx;
          livePriceStale = false;
          livePxProvenance = 'jupiter';
        }
      }
      if (!livePx && basePx) {
        const st = latestTimelineSpotUsd(timelineSorted, TIMELINE_SPOT_FALLBACK_MAX_AGE_MS);
        if (st != null) {
          livePx = st;
          livePriceStale = true;
          livePxProvenance = 'journal';
        }
      }
      const hasLivePrice = livePx != null && livePx > 0;

      const baseEntryUsd =
        ot.entryRealMcUsd != null && ot.entryRealMcUsd > 0 ? ot.entryRealMcUsd : null;

      let entryMcapAtBuyUsd =
        ot.entryRealMcUsd != null && ot.entryRealMcUsd > 0 ? ot.entryRealMcUsd : null;
      if (entryMcapAtBuyUsd == null) {
        entryMcapAtBuyUsd = await resolveEntryMcapAtBuyUsd(ot.mint, ot.entryTs, timelineSorted);
      }

      let timelineOut = timelineSorted.map((ev: TimelineEvent) => ({ ...ev }));
      timelineOut = filterSpuriousDcaOpenDuplicate(timelineOut);
      if (
        timelineOut.length &&
        timelineOut[0].kind === 'open' &&
        (timelineOut[0].mcUsd == null || !(Number(timelineOut[0].mcUsd) > 0)) &&
        entryMcapAtBuyUsd != null &&
        entryMcapAtBuyUsd > 0
      ) {
        timelineOut[0] = { ...timelineOut[0], mcUsd: entryMcapAtBuyUsd };
      }
      timelineOut = await enrichTimelineMcapGaps(ot.mint, timelineOut);
      timelineOut = finalizeTimelineForApi(timelineOut);

      const displaySymbol = await resolveTokenSymbolForUi(ot.mint, ot.symbol);

      const currentMcUsd = hasLiveMc ? (displayLiveMc as number) : isMcMetric ? (baseEntryUsd ?? 0) : 0;
      const livePriceUsd = hasLivePrice ? livePx : null;

      let pnlPct: number | null = null;
      let pnlUsd: number | null = null;

      const investedFor = (): number => {
        const investedRaw = ot.totalInvestedUsd;
        return investedRaw > 0 && investedRaw <= 10_000 ? investedRaw : POSITION_USD_DEFAULT;
      };
      const tryByMcap = (): boolean => {
        /**
         * Mcap-based unrealized PnL. We use entryMcapAtBuyUsd (real USD mcap at buy,
         * possibly back-filled from snapshots) rather than the legacy `entryMcUsd` which
         * for price-tracked strategies stores a per-token price and is NOT a market cap.
         */
        const entryMc = entryMcapAtBuyUsd;
        if (!(entryMc && entryMc > 0)) return false;
        if (!(displayLiveMc && displayLiveMc > 0)) return false;
        const p = ((displayLiveMc as number) / entryMc - 1) * 100;
        if (!Number.isFinite(p) || Math.abs(p) > PNL_PCT_CLAMP) return false;
        pnlPct = p;
        pnlUsd = (investedFor() * p) / 100;
        return true;
      };
      const tryByPrice = (): boolean => {
        if (!(basePx && basePx > 0 && hasLivePrice && livePx && livePx > 0)) return false;
        /**
         * If our only "live" price is the journal-derived spot equal to the entry, this is
         * a stale pseudo-price (e.g. position has no DCA/partial events yet). Bail so the
         * mcap path can produce a real PnL number.
         */
        if (livePxProvenance === 'journal' && Math.abs((livePx as number) - basePx) / basePx < 1e-6) {
          return false;
        }
        const p = ((livePx as number) / basePx - 1) * 100;
        if (!Number.isFinite(p) || Math.abs(p) > PNL_PCT_CLAMP) return false;
        pnlPct = p;
        pnlUsd = (investedFor() * p) / 100;
        return true;
      };

      /**
       * mc-strategies prefer mcap, price-strategies prefer price; in either case fall
       * through to the other so we always render a number when either signal is alive.
       */
      if (isMcMetric) {
        if (!tryByMcap()) tryByPrice();
      } else {
        if (!tryByPrice()) tryByMcap();
      }

      const entryLiqUsdVal = ot.entryLiqUsd ?? null;
      const currentLiqUsdVal = await fetchPairLiquidityUsdFromPg(ot.pairAddress, ot.source).catch(
        () => null,
      );
      const liqDropPct =
        entryLiqUsdVal != null &&
        entryLiqUsdVal > 0 &&
        currentLiqUsdVal != null &&
        Number.isFinite(currentLiqUsdVal)
          ? +(((entryLiqUsdVal - currentLiqUsdVal) / entryLiqUsdVal) * 100).toFixed(2)
          : null;

      const remainingCostBasisUsd =
        ot.totalInvestedUsd > 0 ? ot.totalInvestedUsd * Math.max(0, ot.remainingFraction) : 0;

      return {
        mint: ot.mint,
        symbol: displaySymbol,
        entryTs: ot.entryTs,
        entryMcUsd: ot.entryMcUsd,
        entryRealMcUsd: ot.entryRealMcUsd,
        entryMcapAtBuyUsd,
        baselinePriceUsd: ot.baselinePriceUsd,
        metricType: ot.metricType,
        openedAtIso: ot.openedAtIso,
        lane: ot.lane,
        source: ot.source,
        currentMcUsd,
        livePriceUsd,
        peakMcUsd: ot.peakMcUsd,
        peakPnlPct: ot.peakPnlPct,
        trailingArmed: ot.trailingArmed,
        pnlPct,
        pnlUsd,
        ageMin: (Date.now() - (ot.entryTs || Date.now())) / 60_000,
        hasLiveMc,
        hasLivePrice,
        livePriceStale,
        livePxProvenance,
        liveMcProvenance,
        timeline: timelineOut,
        entryPriorityFeeUsd: ot.entryPriorityFeeUsd ?? null,
        entryPriceVerifySlipPct: ot.entryPriceVerifySlipPct ?? null,
        entryPriceVerifyImpactPct: ot.entryPriceVerifyImpactPct ?? null,
        entryPriceVerifySource: ot.entryPriceVerifySource ?? null,
        entryLiqUsd: entryLiqUsdVal,
        currentLiqUsd: currentLiqUsdVal,
        liqDropPct,
        remainingCostBasisUsd,
      };
    }),
  );

  enrichedOpen.sort((a, b) => (b.entryTs || 0) - (a.entryTs || 0));

  const unrealizedUsd = enrichedOpen.reduce((acc, o) => acc + (o.pnlUsd ?? 0), 0);
  const realizedPnlUsd = m.sumPnlUsd;
  const totalPnlUsd = realizedPnlUsd + unrealizedUsd;

  const priorityFeeUsdTotal = closed.reduce((acc, row) => {
    const pf = Number((row as { priorityFee?: { usd?: number } }).priorityFee?.usd ?? 0);
    return acc + (pf > 0 ? pf : 0);
  }, 0);

  const priceVerify = aggregatePriceVerifyFromJsonl(fp, PAPER2_PRICE_VERIFY_AGG_WINDOW_MS);

  const liqDrain = (() => {
    let exits = 0;
    const drops: number[] = [];
    for (const r of closed) {
      if (String(r.exitReason) !== 'LIQ_DRAIN') continue;
      exits += 1;
      const d = Number((r as { liqWatch?: { dropPct?: number } }).liqWatch?.dropPct ?? NaN);
      if (Number.isFinite(d)) drops.push(d);
    }
    const sorted = [...drops].sort((a, b) => a - b);
    return {
      exits,
      avgDropPct: drops.length ? +((drops.reduce((a, b) => a + b, 0) / drops.length).toFixed(2)) : null,
      p90DropPct: drops.length
        ? sorted[Math.min(sorted.length - 1, Math.floor(drops.length * 0.9))]
        : null,
    };
  })();

  return {
    strategyId: sid,
    file: fp,
    openCount: Math.max(open.length, hb?.hbOpen ?? 0),
    closedCount: Math.max(closed.length, hb?.hbClosed ?? 0),
    startedAt,
    lastTs,
    hoursOfData: (Date.now() - startedAt) / 3_600_000,
    sumPnlUsd: m.sumPnlUsd,
    realizedPnlUsd,
    unrealizedPnlUsd: unrealizedUsd,
    totalPnlUsd,
    winRate: m.winRate,
    avgPnl: m.avgPnl,
    avgPeak: m.avgPeak,
    bestPnlUsd: m.bestPnlUsd,
    worstPnlUsd: m.worstPnlUsd,
    unrealizedUsd,
    exits: m.exits,
    exitsBreakdown: m.exitsBreakdown,
    evals1h,
    passed1h,
    failReasons,
    open: enrichedOpen,
    recentClosed: closedWithUsd,
    priorityFeeUsdTotal,
    priceVerify,
    liqDrain,
    ...(hb?.reconcileExtras ?? {}),
  };
}

app.get('/api/smart-lottery', async (_req, reply) => {
  reply.header('cache-control', 'no-store');
  const fp = DASHBOARD_SMLOT_JSONL;
  const sid = path.basename(fp, '.jsonl');
  const row = await buildPaper2StrategyRowFromLoad(fp, sid, loadPaper2File(fp));
  const totals = {
    strategies: 1,
    open: row.openCount,
    closed: row.closedCount,
    sumPnlUsd: row.sumPnlUsd,
    realizedPnlUsd: row.realizedPnlUsd,
    unrealizedPnlUsd: row.unrealizedPnlUsd,
    totalPnlUsd: row.totalPnlUsd,
  };
  return {
    now: Date.now(),
    paper2Dir: PAPER2_DIR,
    smartLotteryJsonl: fp,
    totals,
    strategies: [row],
  };
});

app.get('/api/paper2/crypto-ticker', async (_req, reply) => {
  reply.header('cache-control', 'no-store');
  return fetchCryptoTickerPayload();
});

app.get('/api/paper2', async (_req, reply) => {
  reply.header('cache-control', 'no-store');
  const files = listPaper2StrategyJournalPaths();

  const strategies: Array<DashboardPaper2StrategyRow & { open: Paper2ApiEnrichedOpen[] }> = [];
  for (const fp of files) {
    const sid = path.basename(fp, '.jsonl');
    strategies.push(await buildPaper2StrategyRowFromLoad(fp, sid, loadPaper2File(fp)));
  }

  const ll = loadLiveOscarJsonlAsPaper2(DASHBOARD_LIVE_OSCAR_JSONL);
  const { hbOpen, hbClosed, liveExtras, ...liveLoaded } = ll;
  const liveRow = await buildPaper2StrategyRowFromLoad(DASHBOARD_LIVE_OSCAR_JSONL, 'live-oscar', liveLoaded, {
    hbOpen,
    hbClosed,
    reconcileExtras: liveExtras,
  });
  const merged = dashboardPaper2LiveOscarOnly()
    ? [liveRow]
    : mergeDashboardStrategyPanels([liveRow, ...strategies]);

  const totals = merged.reduce(
    (acc, s) => {
      acc.strategies += 1;
      acc.open += s.openCount;
      acc.closed += s.closedCount;
      acc.sumPnlUsd += s.sumPnlUsd;
      acc.realizedPnlUsd += s.realizedPnlUsd;
      acc.unrealizedPnlUsd += s.unrealizedPnlUsd;
      acc.totalPnlUsd += s.totalPnlUsd;
      return acc;
    },
    {
      strategies: 0,
      open: 0,
      closed: 0,
      sumPnlUsd: 0,
      realizedPnlUsd: 0,
      unrealizedPnlUsd: 0,
      totalPnlUsd: 0,
    },
  );

  return {
    now: Date.now(),
    paper2Dir: PAPER2_DIR,
    liveOscarJsonl: DASHBOARD_LIVE_OSCAR_JSONL,
    panelOrder: dashboardPaper2LiveOscarOnly() ? (['live-oscar'] as const) : DASHBOARD_PANEL_ORDER,
    totals,
    strategies: merged,
  };
});

app.get('/api/paper2/price-verify-stats', async (req, reply) => {
  reply.header('cache-control', 'no-store');
  let files: string[] = [];
  if (dashboardPaper2LiveOscarOnly()) {
    files = fs.existsSync(DASHBOARD_LIVE_OSCAR_JSONL) ? [DASHBOARD_LIVE_OSCAR_JSONL] : [];
  } else {
    try {
      if (fs.existsSync(PAPER2_DIR)) {
        files = fs
          .readdirSync(PAPER2_DIR)
          .filter((f) => f.endsWith('.jsonl'))
          .map((f) => path.join(PAPER2_DIR, f));
      }
    } catch {
      /* ignore */
    }
  }
  const rawMin = Number((req.query as { windowMin?: string })?.windowMin);
  const windowMin = Math.max(5, Math.min(7 * 24 * 60, Number.isFinite(rawMin) && rawMin > 0 ? rawMin : 1440));
  const windowMs = windowMin * 60 * 1000;
  const perStrategy: Record<string, unknown> = {};
  let okGlobal = 0;
  let blockedGlobal = 0;
  let skippedGlobal = 0;
  for (const fp of files) {
    const sid = dashboardPaper2LiveOscarOnly() ? 'live-oscar' : path.basename(fp, '.jsonl');
    const slice = priceVerifyStatsEndpointSlice(fp, windowMs);
    perStrategy[sid] = slice;
    okGlobal += slice.okCount;
    blockedGlobal += slice.blockedCount;
    skippedGlobal += slice.skippedCount;
  }
  return {
    windowMin,
    perStrategy,
    global: {
      okCount: okGlobal,
      blockedCount: blockedGlobal,
      skippedCount: skippedGlobal,
      blockedRate:
        okGlobal + blockedGlobal > 0 ? +(blockedGlobal / (okGlobal + blockedGlobal)).toFixed(4) : 0,
    },
  };
});

function aggregateLiqWatchEndpointSlice(filePath: string, windowMs: number): {
  liqDrainExits: number;
  avgDropPct: number | null;
  p90DropPct: number | null;
  rpcFallbackUsedCount: number;
  snapshotMissCount: number;
} {
  const drops: number[] = [];
  let exits = 0;
  let rpcFallbackUsedCount = 0;
  let snapshotMissCount = 0;
  if (!fs.existsSync(filePath)) {
    return {
      liqDrainExits: 0,
      avgDropPct: null,
      p90DropPct: null,
      rpcFallbackUsedCount: 0,
      snapshotMissCount: 0,
    };
  }
  const cutoff = Date.now() - windowMs;
  const lines = fs.readFileSync(filePath, 'utf-8').split('\n').filter(Boolean);
  for (const ln of lines) {
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(ln) as Record<string, unknown>;
    } catch {
      continue;
    }
    const ts = typeof ev.ts === 'number' ? ev.ts : 0;
    if (ts < cutoff) continue;
    if (ev.kind !== 'close') continue;
    if (ev.exitReason !== 'LIQ_DRAIN') continue;
    exits += 1;
    const lw = ev.liqWatch as { dropPct?: unknown; source?: unknown } | undefined;
    const d = Number(lw?.dropPct ?? NaN);
    if (Number.isFinite(d)) drops.push(d);
    if (lw?.source === 'rpc') rpcFallbackUsedCount += 1;
    if (lw?.source === 'none') snapshotMissCount += 1;
  }
  const sorted = [...drops].sort((a, b) => a - b);
  return {
    liqDrainExits: exits,
    avgDropPct: drops.length ? +((drops.reduce((a, b) => a + b, 0) / drops.length).toFixed(2)) : null,
    p90DropPct: drops.length
      ? sorted[Math.min(sorted.length - 1, Math.floor(drops.length * 0.9))]
      : null,
    rpcFallbackUsedCount,
    snapshotMissCount,
  };
}

app.get('/api/paper2/liq-watch-stats', async (req, reply) => {
  reply.header('cache-control', 'no-store');
  let files: string[] = [];
  if (dashboardPaper2LiveOscarOnly()) {
    files = fs.existsSync(DASHBOARD_LIVE_OSCAR_JSONL) ? [DASHBOARD_LIVE_OSCAR_JSONL] : [];
  } else {
    try {
      if (fs.existsSync(PAPER2_DIR)) {
        files = fs
          .readdirSync(PAPER2_DIR)
          .filter((f) => f.endsWith('.jsonl'))
          .map((f) => path.join(PAPER2_DIR, f));
      }
    } catch {
      /* ignore */
    }
  }
  const rawMin = Number((req.query as { windowMin?: string })?.windowMin);
  const windowMin = Math.max(
    5,
    Math.min(7 * 24 * 60, Number.isFinite(rawMin) && rawMin > 0 ? rawMin : 1440),
  );
  const windowMs = windowMin * 60 * 1000;
  const perStrategy: Record<string, unknown> = {};
  for (const fp of files) {
    const sid = dashboardPaper2LiveOscarOnly() ? 'live-oscar' : path.basename(fp, '.jsonl');
    perStrategy[sid] = aggregateLiqWatchEndpointSlice(fp, windowMs);
  }
  return { windowMin, perStrategy };
});

if (process.env.DASHBOARD_NO_LISTEN !== '1') {
  app.listen({ port: PORT, host: HOST }).then(() => {
    console.log(`[dashboard] listening on http://${HOST}:${PORT}`);
    console.log(`[dashboard] reading store from ${path.resolve(STORE_PATH)}`);
    const cp = resolvedOrgCursorPath();
    console.log(`[dashboard] organizer cursor file: ${cp ?? '(n/a — not organizer journal)'}`);
    startQuickNodeUsageReporting();
  });
}
