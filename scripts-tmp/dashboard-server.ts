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
import Fastify from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetch } from 'undici';
import postgres from 'postgres';

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
// visit counter (privacy: store hashed IP prefix only)
// ---------------------------------------------------------
import crypto from 'node:crypto';
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

app.listen({ port: PORT, host: HOST }).then(() => {
  console.log(`[dashboard] listening on http://${HOST}:${PORT}`);
  console.log(`[dashboard] reading store from ${path.resolve(STORE_PATH)}`);
  const cp = resolvedOrgCursorPath();
  console.log(`[dashboard] organizer cursor file: ${cp ?? '(n/a — not organizer journal)'}`);
});
