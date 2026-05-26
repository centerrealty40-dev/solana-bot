import 'dotenv/config';
/**
 * Live Oscar — MFE (maximum favorable excursion) по **закрытым** сделкам из live JSONL.
 *
 * Берёт максимум той же метрики, что и трекер (`metricType`: `price` → `price_usd`,
 * `mc` → `COALESCE(market_cap_usd, fdv_usd)`), из Postgres `*_pair_snapshots` за окно
 * [entryTs, exitTs] и опционально post-exit окно для ответа «ушла ли цена вверх после выхода».
 *
 * Не требует платного RPC; нужен только `DATABASE_URL` (как у live-oscar на VPS).
 * Опционально `--birdeye` подтянет high по OHLCV (нужен `BIRDEYE_API_KEY` в `.env`).
 *
 * Пример (на сервере):
 *   cd /opt/solana-alpha && set -a && . ./.env && set +a && npx tsx scripts/live-oscar-closed-mfe-audit.ts \
 *     --journal data/live/pt1-oscar-live.jsonl --extend-post-exit-hours 12 --tsv-out data/live/mfe-audit.tsv
 *
 * `--max-closes N` — остановиться после N **первых** закрытий в файле (по умолчанию 0 = все закрытия, полный проход JSONL).
 * В append-only журнале это **самые старые** N закрытий; для «последних» закрытий не задавайте `--max-closes` или срежьте хвост файла в отдельный JSONL.
 */
import fs from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';
import postgres from 'postgres';

const SNAPSHOT_TABLES = [
  'raydium_pair_snapshots',
  'meteora_pair_snapshots',
  'orca_pair_snapshots',
  'moonshot_pair_snapshots',
  'pumpswap_pair_snapshots',
] as const;

type MetricType = 'mc' | 'price';

type ClosedRow = {
  mint: string;
  symbol: string;
  source: string | null;
  dex: string;
  metricType: MetricType;
  entryTs: number;
  exitTs: number;
  avgEntry: number;
  exitReason: string;
  pnlPct: number;
  netPnlUsd: number;
  peakPnlPct: number | null;
  closePnlPct: number | null;
  trailDrop: number | null;
  trailTriggerX: number | null;
  trailMode: string | null;
  trailingArmed: boolean | null;
  peakMcUsd: number | null;
};

type RowAgg = Record<string, unknown>;

let pgClient: ReturnType<typeof postgres> | null = null;

function getPg(): ReturnType<typeof postgres> {
  if (!pgClient) {
    const url = process.env.DATABASE_URL?.trim();
    if (!url) throw new Error('DATABASE_URL missing');
    pgClient = postgres(url, { max: 4, idle_timeout: 20, connect_timeout: 15, prepare: false });
  }
  return pgClient;
}

async function pgEnd(): Promise<void> {
  if (pgClient) {
    const c = pgClient;
    pgClient = null;
    await c.end({ timeout: 5 });
  }
}

async function queryUnsafe(fullSql: string): Promise<RowAgg[]> {
  const rows = await getPg().unsafe(fullSql);
  return Array.isArray(rows) ? (rows as RowAgg[]) : [];
}

function firstRow(rows: RowAgg[]): RowAgg {
  return rows[0] ?? {};
}

function argStr(name: string, def: string): string {
  const i = process.argv.indexOf(name);
  if (i === -1 || !process.argv[i + 1]) return def;
  return process.argv[i + 1]!;
}

function argNum(name: string, def: number): number {
  const i = process.argv.indexOf(name);
  if (i === -1 || !process.argv[i + 1]) return def;
  const n = Number(process.argv[i + 1]);
  return Number.isFinite(n) ? n : def;
}

function sqlQuoteIdent(ident: string): string | null {
  if (!/^[a-z0-9_]+$/.test(ident)) return null;
  return ident;
}

function sqlQuoteStr(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

function sourceToTable(source: string | null | undefined): string | null {
  if (!source) return null;
  const t = `${source}_pair_snapshots`;
  return SNAPSHOT_TABLES.includes(t as (typeof SNAPSHOT_TABLES)[number]) ? t : null;
}

function metricExpr(metricType: MetricType): string {
  if (metricType === 'mc') {
    return `NULLIF(GREATEST(COALESCE(market_cap_usd, 0), COALESCE(fdv_usd, 0)), 0)`;
  }
  return `NULLIF(COALESCE(price_usd, 0), 0)`;
}

function mintOk(m: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,48}$/.test(m);
}

async function loadCloses(journalPath: string, maxCloses: number): Promise<ClosedRow[]> {
  const out: ClosedRow[] = [];
  const abs = path.resolve(journalPath);
  if (!fs.existsSync(abs)) {
    console.error('journal missing:', abs);
    process.exit(1);
  }
  const rl = readline.createInterface({
    input: fs.createReadStream(abs, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line.trim() || line[0] !== '{') continue;
    let j: Record<string, unknown>;
    try {
      j = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (j.kind !== 'live_position_close') continue;
    const ct = j.closedTrade as Record<string, unknown> | undefined;
    if (!ct || typeof ct.mint !== 'string') continue;

    const exitCtx = (ct.exitContext ?? {}) as Record<string, unknown>;
    const cfgSnap = (exitCtx.cfgSnapshot ?? {}) as Record<string, unknown>;

    const metricRaw = ct.metricType;
    const metricType: MetricType = metricRaw === 'mc' ? 'mc' : 'price';

    out.push({
      mint: ct.mint,
      symbol: String(ct.symbol ?? ''),
      source: typeof ct.source === 'string' ? ct.source : null,
      dex: String(ct.dex ?? ''),
      metricType,
      entryTs: Number(ct.entryTs),
      exitTs: Number(ct.exitTs),
      avgEntry: Number(ct.avgEntry ?? ct.effective_entry_price ?? 0),
      exitReason: String(ct.exitReason ?? ''),
      pnlPct: Number(ct.pnlPct ?? 0),
      netPnlUsd: Number(ct.netPnlUsd ?? 0),
      peakPnlPct: typeof exitCtx.peakPnlPct === 'number' ? exitCtx.peakPnlPct : null,
      closePnlPct: typeof exitCtx.closePnlPct === 'number' ? exitCtx.closePnlPct : null,
      trailDrop: typeof cfgSnap.trailDrop === 'number' ? cfgSnap.trailDrop : null,
      trailTriggerX: typeof cfgSnap.trailTriggerX === 'number' ? cfgSnap.trailTriggerX : null,
      trailMode: typeof cfgSnap.trailMode === 'string' ? cfgSnap.trailMode : null,
      trailingArmed: typeof exitCtx.trailingArmed === 'boolean' ? exitCtx.trailingArmed : null,
      peakMcUsd: typeof ct.peakMcUsd === 'number' ? ct.peakMcUsd : null,
    });
    if (maxCloses > 0 && out.length >= maxCloses) break;
  }
  return out;
}

type PgAgg = {
  maxHold: number | null;
  minHold: number | null;
  samplesHold: number;
  maxPost: number | null;
  samplesPost: number;
};

async function queryPgRange(args: {
  table: string;
  mint: string;
  t0Iso: string;
  t1Iso: string;
  metricType: MetricType;
  postEndIso?: string;
}): Promise<PgAgg> {
  const tbl = sqlQuoteIdent(args.table);
  if (!tbl) throw new Error('bad table');
  const mx = metricExpr(args.metricType);
  const mintSql = sqlQuoteStr(args.mint);

  const holdSql = `
    SELECT
      MAX(${mx})::float AS max_hold,
      MIN(${mx})::float AS min_hold,
      COUNT(*)::int AS n_hold
    FROM ${tbl}
    WHERE base_mint = ${mintSql}
      AND ts >= ${sqlQuoteStr(args.t0Iso)}::timestamptz
      AND ts <= ${sqlQuoteStr(args.t1Iso)}::timestamptz
  `;

  const holdRow = firstRow(await queryUnsafe(holdSql));

  let maxPost: number | null = null;
  let samplesPost = 0;
  if (args.postEndIso && args.postEndIso > args.t1Iso) {
    const postSql = `
      SELECT
        MAX(${mx})::float AS max_post,
        COUNT(*)::int AS n_post
      FROM ${tbl}
      WHERE base_mint = ${mintSql}
        AND ts > ${sqlQuoteStr(args.t1Iso)}::timestamptz
        AND ts <= ${sqlQuoteStr(args.postEndIso)}::timestamptz
    `;
    const postRow = firstRow(await queryUnsafe(postSql));
    maxPost = postRow.max_post != null ? Number(postRow.max_post) : null;
    samplesPost = Number(postRow.n_post ?? 0) || 0;
  }

  return {
    maxHold: holdRow.max_hold != null ? Number(holdRow.max_hold) : null,
    minHold: holdRow.min_hold != null ? Number(holdRow.min_hold) : null,
    samplesHold: Number(holdRow.n_hold ?? 0) || 0,
    maxPost,
    samplesPost,
  };
}

async function queryPgUnion(args: {
  mint: string;
  t0Iso: string;
  t1Iso: string;
  metricType: MetricType;
  postEndIso?: string;
}): Promise<PgAgg> {
  const mx = metricExpr(args.metricType);
  const mintSql = sqlQuoteStr(args.mint);

  const parts = SNAPSHOT_TABLES.map(
    (t) =>
      `SELECT MAX(${mx})::float AS mx, MIN(${mx})::float AS mn, COUNT(*)::bigint AS n FROM ${t}
       WHERE base_mint = ${mintSql}
         AND ts >= ${sqlQuoteStr(args.t0Iso)}::timestamptz
         AND ts <= ${sqlQuoteStr(args.t1Iso)}::timestamptz`,
  );
  const holdSql = `SELECT MAX(mx) AS max_hold, MIN(mn) AS min_hold, SUM(n)::int AS samples_hold FROM (${parts.join(' UNION ALL ')}) u`;

  const holdRow = firstRow(await queryUnsafe(holdSql));

  let maxPost: number | null = null;
  let samplesPost = 0;
  if (args.postEndIso && args.postEndIso > args.t1Iso) {
    const postParts = SNAPSHOT_TABLES.map(
      (t) =>
        `SELECT MAX(${mx})::float AS mx, COUNT(*)::bigint AS n FROM ${t}
         WHERE base_mint = ${mintSql}
           AND ts > ${sqlQuoteStr(args.t1Iso)}::timestamptz
           AND ts <= ${sqlQuoteStr(args.postEndIso)}::timestamptz`,
    );
    const postSql = `SELECT MAX(mx) AS max_post, SUM(n)::int AS samples_post FROM (${postParts.join(' UNION ALL ')}) u`;
    const postRow = firstRow(await queryUnsafe(postSql));
    maxPost = postRow.max_post != null ? Number(postRow.max_post) : null;
    samplesPost = Number(postRow.samples_post ?? 0) || 0;
  }

  return {
    maxHold: holdRow.max_hold != null ? Number(holdRow.max_hold) : null,
    minHold: holdRow.min_hold != null ? Number(holdRow.min_hold) : null,
    samplesHold: Number(holdRow.samples_hold ?? 0) || 0,
    maxPost,
    samplesPost,
  };
}

function pnlPctFromAvg(avg: number, px: number | null): number | null {
  if (!(avg > 0) || px == null || !(px > 0) || !Number.isFinite(px)) return null;
  return (px / avg - 1) * 100;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

async function birdeyeMaxHighUsd(args: {
  mint: string;
  fromSec: number;
  toSec: number;
  interval: string;
  apiKey: string;
}): Promise<{ maxH: number | null; n: number }> {
  const u = new URL('https://public-api.birdeye.so/defi/v3/ohlcv');
  u.searchParams.set('address', args.mint);
  u.searchParams.set('type', args.interval);
  u.searchParams.set('currency', 'usd');
  u.searchParams.set('time_from', String(args.fromSec));
  u.searchParams.set('time_to', String(args.toSec));
  const r = await fetch(u.toString(), {
    headers: {
      'X-API-KEY': args.apiKey,
      'x-chain': 'solana',
      Accept: 'application/json',
    },
  });
  const text = await r.text();
  let json: { success?: boolean; data?: { items?: Array<{ h?: number; unix_time?: number }> } };
  try {
    json = JSON.parse(text) as typeof json;
  } catch {
    return { maxH: null, n: 0 };
  }
  if (!r.ok || !json?.success) return { maxH: null, n: 0 };
  const items = json.data?.items;
  if (!Array.isArray(items) || !items.length) return { maxH: null, n: 0 };
  let maxH = -Infinity;
  for (const c of items) {
    if (
      c.unix_time != null &&
      c.unix_time >= args.fromSec &&
      c.unix_time <= args.toSec &&
      Number.isFinite(c.h)
    ) {
      maxH = Math.max(maxH, c.h!);
    }
  }
  return { maxH: maxH === -Infinity ? null : maxH, n: items.length };
}

function median(nums: number[]): number | null {
  const a = nums.filter((x) => Number.isFinite(x)).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m]! : (a[m - 1]! + a[m]!) / 2;
}

function mean(nums: number[]): number | null {
  const a = nums.filter((x) => Number.isFinite(x));
  return a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
}

type OutRow = {
  r: ClosedRow;
  agg: PgAgg;
  mfePctPg: number | null;
  diffPg: number | null;
  postExitMaxPct: number | null;
  birdeyeMfePct: number | null;
};

async function main(): Promise<void> {
  const journal = argStr('--journal', 'data/live/pt1-oscar-live.jsonl');
  /** 0 = все `live_position_close` в журнале (скан файла целиком). */
  const maxCloses = argNum('--max-closes', 0);
  const extendH = argNum('--extend-post-exit-hours', 0);
  const sleepMs = argNum('--sleep-ms', 0);
  const tsvOut = process.argv.includes('--tsv-out') ? argStr('--tsv-out', '') : '';
  const useBirdeye = process.argv.includes('--birdeye');
  const birdeyeInterval = argStr('--birdeye-interval', '1m');

  const rows = await loadCloses(journal, maxCloses);
  if (!rows.length) {
    console.error('No live_position_close rows in journal (or empty).');
    process.exit(1);
  }

  if (!process.env.DATABASE_URL?.trim()) {
    console.error('DATABASE_URL is required (load .env from repo root).');
    process.exit(1);
  }

  const birdeyeKey = (process.env.BIRDEYE_API_KEY ?? '').trim();
  if (useBirdeye && !birdeyeKey) {
    console.error('--birdeye requires BIRDEYE_API_KEY');
    process.exit(1);
  }

  try {
  const header = [
    'mint',
    'symbol',
    'exitReason',
    'pnlPct',
    'netPnlUsd',
    'peakPnlPct_journal',
    'trailDrop',
    'trailMode',
    'trailingArmed',
    'metricType',
    'source',
    'pg_samples_hold',
    'mfePct_pg',
    'mfeMinusClose_pg',
    'postExitMaxPct_pg',
    'birdeye_mfePct',
  ].join('\t');

  const outRows: OutRow[] = [];
  const mfeMinusClose: number[] = [];
  const byReason = new Map<string, { n: number; sumDiff: number }>();
  let skippedAggStats = 0;

  console.log(
    JSON.stringify(
      {
        journal: path.resolve(journal),
        closes: rows.length,
        maxCloses: maxCloses || null,
        extendPostExitHours: extendH,
        birdeye: useBirdeye,
      },
      null,
      2,
    ),
  );

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    if (!mintOk(r.mint)) continue;
    const t0 = new Date(r.entryTs).toISOString();
    const t1 = new Date(r.exitTs).toISOString();
    const postEnd =
      extendH > 0 ? new Date(r.exitTs + extendH * 3_600_000).toISOString() : undefined;

    const table = sourceToTable(r.source);
    let agg: PgAgg;
    try {
      if (table) {
        agg = await queryPgRange({
          table,
          mint: r.mint,
          t0Iso: t0,
          t1Iso: t1,
          metricType: r.metricType,
          postEndIso: postEnd,
        });
      } else {
        agg = await queryPgUnion({
          mint: r.mint,
          t0Iso: t0,
          t1Iso: t1,
          metricType: r.metricType,
          postEndIso: postEnd,
        });
      }
    } catch (e) {
      console.error('PG error', r.mint, e);
      agg = { maxHold: null, minHold: null, samplesHold: 0, maxPost: null, samplesPost: 0 };
    }

    const mfePctPg = pnlPctFromAvg(r.avgEntry, agg.maxHold);
    const closePct = r.closePnlPct ?? r.pnlPct;
    const diff = mfePctPg != null && Number.isFinite(closePct) ? mfePctPg - closePct : null;
    const robust =
      diff != null &&
      Number.isFinite(diff) &&
      Math.abs(diff) <= 300 &&
      agg.samplesHold >= 3;
    if (diff != null && Number.isFinite(diff)) {
      if (robust) {
        mfeMinusClose.push(diff);
        const cur = byReason.get(r.exitReason) ?? { n: 0, sumDiff: 0 };
        cur.n += 1;
        cur.sumDiff += diff;
        byReason.set(r.exitReason, cur);
      } else {
        skippedAggStats += 1;
      }
    }

    let postExitMaxPct: number | null = null;
    if (agg.maxPost != null && r.avgEntry > 0) {
      postExitMaxPct = pnlPctFromAvg(r.avgEntry, agg.maxPost);
    }

    let birdeyeMfe: number | null = null;
    if (useBirdeye && r.metricType === 'price') {
      const fromS = Math.floor(r.entryTs / 1000);
      const toS = Math.floor(r.exitTs / 1000);
      const bh = await birdeyeMaxHighUsd({
        mint: r.mint,
        fromSec: fromS,
        toSec: toS,
        interval: birdeyeInterval,
        apiKey: birdeyeKey,
      });
      birdeyeMfe = pnlPctFromAvg(r.avgEntry, bh.maxH);
      await sleep(220);
    }

    outRows.push({ r, agg, mfePctPg, diffPg: diff, postExitMaxPct, birdeyeMfePct: birdeyeMfe });

    if (sleepMs > 0) await sleep(sleepMs);
  }

  const lines = [header];
  for (const o of outRows) {
    const { r, agg, mfePctPg, diffPg, postExitMaxPct, birdeyeMfePct } = o;
    lines.push(
      [
        r.mint,
        r.symbol.replace(/\t/g, ' '),
        r.exitReason,
        r.pnlPct.toFixed(4),
        r.netPnlUsd.toFixed(4),
        r.peakPnlPct != null ? r.peakPnlPct.toFixed(4) : '',
        r.trailDrop != null ? String(r.trailDrop) : '',
        r.trailMode ?? '',
        r.trailingArmed === null ? '' : r.trailingArmed ? '1' : '0',
        r.metricType,
        r.source ?? '',
        String(agg.samplesHold),
        mfePctPg != null ? mfePctPg.toFixed(4) : '',
        diffPg != null ? diffPg.toFixed(4) : '',
        postExitMaxPct != null ? postExitMaxPct.toFixed(4) : '',
        birdeyeMfePct != null ? birdeyeMfePct.toFixed(4) : '',
      ].join('\t'),
    );
  }

  if (tsvOut) {
    const p = path.resolve(tsvOut);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, lines.join('\n') + '\n', 'utf8');
    console.log('wrote', p);
  }

  console.log(
    JSON.stringify(
      {
        summary: {
          closesAnalyzed: outRows.length,
          skippedFromSummaryLowQuality: skippedAggStats,
          mfeMinusClosePg_medianPct: median(mfeMinusClose),
          mfeMinusClosePg_meanPct: mean(mfeMinusClose),
        },
        byExitReason_avgMfeMinusClosePg: Object.fromEntries(
          [...byReason.entries()].map(([k, v]) => [k, v.n ? +(v.sumDiff / v.n).toFixed(3) : null]),
        ),
        caveats: [
          'mfePct_pg is limited by collector snapshot cadence (not tick-level).',
          'For metricType mc, uses max(COALESCE(market_cap_usd), COALESCE(fdv_usd)) in snapshots vs avgEntry.',
          'Rows used for mean/median: |mfeMinusClose_pg|<=300 and pg_samples_hold>=3 (see skippedFromSummaryLowQuality).',
          'Use --birdeye for finer candle highs on price metric (rate limits; slower).',
        ],
      },
      null,
      2,
    ),
  );

  } finally {
    await pgEnd();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
