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
import { qnUsageSnapshot } from '../src/core/rpc/qn-client.js';
import { buildPriorityFeeMonitorApiPayload } from '../src/papertrader/pricing/priority-fee.js';

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
const HTML2_PATH = path.join(__dirname, 'dashboard-paper2.html');
const POSITION_USD_DEFAULT = Number(process.env.POSITION_USD ?? 100);

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
] as const;

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

/** Latest snapshot mcap at or before entry time (for legacy jsonl without features.market_cap_usd). */
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
  const sources: readonly string[] = ['raydium', 'meteora', 'orca', 'moonshot'];
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

if (BASIC_AUTH_ENABLED) {
  app.addHook('onRequest', async (req, reply) => {
    const url = (req.raw.url || '/').split('?')[0];
    if (BASIC_AUTH_BYPASS.has(url)) return;
    const creds = parseBasicAuthHeader(req.headers['authorization'] as string | undefined);
    const ok = !!creds && safeEqual(creds.user, BASIC_USER) && safeEqual(creds.pass, BASIC_PASS);
    if (!ok) {
      reply
        .header('WWW-Authenticate', `Basic realm="${BASIC_REALM.replace(/"/g, '')}", charset="UTF-8"`)
        .code(401)
        .send({ ok: false, error: 'unauthorized' });
    }
  });
  console.log(`[dashboard] HTTP Basic Auth ENABLED (user=${BASIC_USER}, bypass=${[...BASIC_AUTH_BYPASS].join(',')})`);
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
type Paper2OpenItem = {
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
};

type Paper2ClosedRow = Record<string, unknown>;

/**
 * Per-position audit timeline derived from jsonl events.
 * mcUsd is USD market cap when known (only when metricType === 'mc'),
 * null otherwise (so the UI can render "mcap n/a" exactly like the spec).
 */
type TimelineEvent = {
  ts: number;
  kind: 'open' | 'dca_add' | 'partial_sell' | 'close';
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

function buildTimelineEvent(
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
    return {
      ts,
      kind: 'open',
      label: 'Open',
      mcUsd: openMc,
      spotPxUsd: spotPx != null && spotPx > 0 ? spotPx : null,
      sizePct: null,
      pnlPct: null,
      pnlUsd: null,
      reason: null,
      remainingFraction: 1,
    };
  }
  if (kind === 'dca_add') {
    const triggerPct = Number(e.triggerPct ?? 0) * 100; // -7%, -15%, ...
    const sizeUsd = Number(e.sizeUsd ?? 0);
    const label = `DCA add · +$${sizeUsd.toFixed(0)} @ ${fmtSignedPct(triggerPct)}`;
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
    };
  }
  if (kind === 'partial_sell') {
    const sellFraction = Number(e.sellFraction ?? 0);
    const ladderPnlPct = Number(e.ladderPnlPct ?? 0) * 100;
    const reason = String(e.reason || 'partial_sell');
    const sellPct = Math.round(sellFraction * 100);
    const niceReason =
      reason === 'TP_LADDER' ? 'Ladder (take profit)' : reason.toLowerCase().replace(/_/g, ' ');
    const label = `${niceReason} · sell ${sellPct}% of remaining @ ${fmtSignedPct(ladderPnlPct)}`;
    const pnlUsd = Number(e.pnlUsd ?? 0);
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
    };
  }
  if (kind === 'close') {
    const exitReason = String(e.exitReason || 'CLOSE');
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
    return {
      ts,
      kind: 'close',
      label: `Close · ${exitReason}`,
      mcUsd: closeMc,
      spotPxUsd: closeSpot,
      sizePct: null,
      pnlPct: Number.isFinite(pnlPct) ? pnlPct : null,
      pnlUsd: Number.isFinite(netPnlUsd) ? netPnlUsd : null,
      reason: exitReason,
      remainingFraction: 0,
    };
  }
  return null;
}

function loadPaper2File(filePath: string): {
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
    } else if (e.kind === 'dca_add' || e.kind === 'partial_sell') {
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
      const closedRow: Paper2ClosedRow = { ...e, __timeline: arr };
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
  return {
    open: [...om.values()],
    closed: cl,
    firstTs: f,
    lastTs: l,
    resetTs,
    evals1h,
    passed1h,
    failReasons,
    openTimelines: liveTimelines,
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
  const exitKinds = ['TP', 'SL', 'TRAIL', 'TIMEOUT', 'NO_DATA', 'KILLSTOP'] as const;
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

app.get('/papertrader2', async (_req, reply) => {
  reply.header('content-type', 'text/html; charset=utf-8');
  return fs.readFileSync(HTML2_PATH, 'utf-8');
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

app.get('/api/paper2', async (_req, reply) => {
  reply.header('cache-control', 'no-store');
  let files: string[] = [];
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

  type EnrichedOpen = {
    mint: string;
    symbol: string;
    entryTs: number;
    entryMcUsd: number;
    entryRealMcUsd: number | null;
    /** Journal mcap at buy, else last-resort DEX snapshot at/before entryTs. */
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
    /** When true, spot for unrealized came from journal timeline (no DEX row). */
    livePriceStale: boolean;
    /** Where live price for PnL came from (Jupiter when snapshots miss the mint side). */
    livePxProvenance: 'snapshots' | 'jupiter' | 'journal' | null;
    /** Extra mcap source when pair_snapshots are empty (pump.fun). */
    liveMcProvenance: 'snapshots' | 'pump.fun' | null;
    timeline: TimelineEvent[];
    entryPriorityFeeUsd: number | null;
  };

  type StrategyRow = {
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
    open: EnrichedOpen[];
    recentClosed: Array<Record<string, unknown>>;
    /** W7.3 — sum of `priorityFee.usd` on journal close rows (stamp at exit). */
    priorityFeeUsdTotal: number;
  };

  const strategies: StrategyRow[] = [];

  for (const fp of files) {
    const sid = path.basename(fp, '.jsonl');
    const { open, closed, firstTs, lastTs, resetTs, evals1h, passed1h, failReasons, openTimelines } = loadPaper2File(fp);
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
          const tlOut = timelineSorted.map((ev: TimelineEvent) => ({ ...ev }));
          if (
            tlOut.length &&
            tlOut[0].kind === 'open' &&
            entryMcapAtBuyUsd != null &&
            entryMcapAtBuyUsd > 0 &&
            (!(Number(tlOut[0].mcUsd) > 0) || tlOut[0].mcUsd == null)
          ) {
            tlOut[0] = { ...tlOut[0], mcUsd: entryMcapAtBuyUsd };
          }
          return {
            mint: c.mint,
            symbol: c.symbol,
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
    const enrichedOpen: EnrichedOpen[] = await Promise.all(
      open.slice(0, 30).map(async (ot): Promise<EnrichedOpen> => {
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
        /** Snapshots → journal spot → Jupiter (v1-style off-chain quote when PG misses the mint). */
        let livePx: number | null = null;
        let livePxProvenance: 'snapshots' | 'jupiter' | 'journal' | null = null;
        if (basePx) {
          livePx = await getDexLivePrice(ot.mint, ot.source).catch(() => null);
          if (livePx) livePxProvenance = 'snapshots';
        }
        let livePriceStale = false;
        if (!livePx && basePx) {
          const st = latestTimelineSpotUsd(timelineSorted, TIMELINE_SPOT_FALLBACK_MAX_AGE_MS);
          if (st != null) {
            livePx = st;
            livePriceStale = true;
            livePxProvenance = 'journal';
          }
        }
        if (!livePx && basePx) {
          const jpx = await getJupiterTokenPriceUsd(ot.mint).catch(() => null);
          if (jpx != null && jpx > 0) {
            livePx = jpx;
            livePriceStale = false;
            livePxProvenance = 'jupiter';
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

        const timelineOut = timelineSorted.map((ev: TimelineEvent) => ({ ...ev }));
        if (
          timelineOut.length &&
          timelineOut[0].kind === 'open' &&
          (timelineOut[0].mcUsd == null || !(Number(timelineOut[0].mcUsd) > 0)) &&
          entryMcapAtBuyUsd != null &&
          entryMcapAtBuyUsd > 0
        ) {
          timelineOut[0] = { ...timelineOut[0], mcUsd: entryMcapAtBuyUsd };
        }

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

        return {
          mint: ot.mint,
          symbol: ot.symbol,
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

    strategies.push({
      strategyId: sid,
      file: fp,
      openCount: open.length,
      closedCount: closed.length,
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
    });
  }
  strategies.sort((a, b) => b.totalPnlUsd - a.totalPnlUsd);

  const totals = strategies.reduce(
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

  return { now: Date.now(), paper2Dir: PAPER2_DIR, totals, strategies };
});

app.listen({ port: PORT, host: HOST }).then(() => {
  console.log(`[dashboard] listening on http://${HOST}:${PORT}`);
  console.log(`[dashboard] reading store from ${path.resolve(STORE_PATH)}`);
  const cp = resolvedOrgCursorPath();
  console.log(`[dashboard] organizer cursor file: ${cp ?? '(n/a — not organizer journal)'}`);
});
