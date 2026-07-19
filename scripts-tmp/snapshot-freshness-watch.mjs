/**
 * PG snapshot freshness — transition alerts [ALERT][snapshot_stale] / recovery.
 * PM2: sa-snapshot-freshness-watch (poll every SNAPSHOT_FRESHNESS_POLL_MS, default 5 min).
 */
import 'dotenv/config';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { sendTagged } from '../scripts/lib/telegram.mjs';

const { Pool } = pg;

const POLL_MS = Number(process.env.SNAPSHOT_FRESHNESS_POLL_MS || 300_000);
const MAX_AGE_SEC = Number(process.env.SNAPSHOT_FRESHNESS_MAX_AGE_SEC || 600);
const STATE_PATH =
  process.env.SNAPSHOT_FRESHNESS_STATE_PATH ||
  path.join('data', 'snapshot-freshness-watch-state.json');
const DRY_RUN = ['1', 'true', 'yes'].includes(
  String(process.env.SNAPSHOT_FRESHNESS_DRY_RUN ?? '0').toLowerCase(),
);
const TELEGRAM_ON = !['0', 'false', 'no'].includes(
  String(process.env.SNAPSHOT_FRESHNESS_TELEGRAM ?? '1').toLowerCase(),
);
const ALERT_HOST =
  process.env.SNAPSHOT_FRESHNESS_ALERT_HOST?.trim() ||
  process.env.COLLECTOR_HEALTH_PRODUCT_LABEL?.trim() ||
  os.hostname();

/** sa-orca off since 1.11.279 (runaway CPU); live-oscar uses pumpswap lane. */
const ALL_TABLES = [
  { source: 'pumpswap', table: 'pumpswap_pair_snapshots' },
  { source: 'raydium', table: 'raydium_pair_snapshots' },
  { source: 'meteora', table: 'meteora_pair_snapshots' },
  { source: 'orca', table: 'orca_pair_snapshots' },
  { source: 'moonshot', table: 'moonshot_pair_snapshots' },
];
const SKIP_SOURCES = new Set(
  String(process.env.SNAPSHOT_FRESHNESS_SKIP_SOURCES ?? 'orca')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
);
const TABLES = ALL_TABLES.filter(({ source }) => !SKIP_SOURCES.has(source));

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return { stale: false, lastAlertTs: 0 };
  }
}

function saveState(st) {
  const dir = path.dirname(STATE_PATH);
  if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(st, null, 2), 'utf8');
}

function classifyRow(r) {
  if (r.error) return 'pg_error';
  if (r.ageSec == null || !Number.isFinite(r.ageSec)) return 'pg_error';
  if (r.ageSec > MAX_AGE_SEC) return 'stale';
  return 'ok';
}

function rowAlertFlag(r) {
  const kind = classifyRow(r);
  if (kind === 'pg_error') return 'PG_ERR';
  if (kind === 'stale') return 'STALE';
  return 'OK';
}

async function fetchRows(pool) {
  const out = [];
  for (const { source, table } of TABLES) {
    try {
      const r = await pool.query(
        `SELECT MAX(ts) AS ts, EXTRACT(EPOCH FROM (now() - MAX(ts)))::int AS age_sec FROM ${table}`,
      );
      const ts = r.rows[0]?.ts ?? null;
      const ageSec = r.rows[0]?.age_sec != null ? Number(r.rows[0].age_sec) : null;
      const ok =
        ts != null && ageSec != null && Number.isFinite(ageSec) && ageSec >= 0 && ageSec <= MAX_AGE_SEC;
      out.push({ source, table, ts, ageSec, ok });
    } catch (e) {
      out.push({
        source,
        table,
        ts: null,
        ageSec: null,
        ok: false,
        error: String(e?.message || e),
      });
    }
  }
  return out;
}

function buildStaleBody(rows) {
  const maxMin = Math.round(MAX_AGE_SEC / 60);
  const lines = [
    `host=${ALERT_HOST}`,
    `🚨 PG snapshots STALE (порог ${maxMin} мин) — discovery и TG dips/pumps слепы.`,
    'Действие: pm2 restart sa-pumpswap sa-raydium sa-meteora sa-moonshot',
  ];
  for (const r of rows) {
    const ageMin = r.ageSec != null ? Math.round(r.ageSec / 60) : '?';
    lines.push(
      `• ${r.source}: ${rowAlertFlag(r)} age=${ageMin}m latest=${r.ts ? new Date(r.ts).toISOString() : 'null'}`,
    );
  }
  return lines.join('\n');
}

function buildRecoveryBody(rows) {
  const parts = rows.map((r) => {
    const ageMin = r.ageSec != null ? Math.round(r.ageSec / 60) : '?';
    return `${r.source}=${ageMin}m`;
  });
  return `host=${ALERT_HOST}\n✅ PG snapshots снова свежие (worst ≤ ${Math.round(MAX_AGE_SEC / 60)} мин): ${parts.join(' ')}`;
}

async function tick(pool) {
  const rows = await fetchRows(pool);
  const kinds = rows.map(classifyRow);
  const pgErrorAll = kinds.every((k) => k === 'pg_error');
  const staleNow = kinds.some((k) => k === 'stale');
  const st = loadState();
  const wasStale = st.stale === true;
  const needTicks = Math.max(1, Number(process.env.SNAPSHOT_FRESHNESS_STALE_CONFIRM_TICKS || 2));

  if (pgErrorAll) {
    st.staleConfirmTicks = 0;
    saveState(st);
    console.log(
      JSON.stringify({
        ts: new Date().toISOString(),
        msg: 'snapshot-freshness-watch tick',
        stale: false,
        staleNow: false,
        pgErrorAll: true,
        host: ALERT_HOST,
        maxAgeSec: MAX_AGE_SEC,
        rows: rows.map((r) => ({
          source: r.source,
          kind: classifyRow(r),
          error: r.error ?? null,
        })),
      }),
    );
    return;
  }

  st.staleConfirmTicks = staleNow ? (Number(st.staleConfirmTicks) || 0) + 1 : 0;
  const stale = st.staleConfirmTicks >= needTicks;
  saveState(st);

  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      msg: 'snapshot-freshness-watch tick',
      stale,
      staleNow,
      staleConfirmTicks: st.staleConfirmTicks,
      host: ALERT_HOST,
      maxAgeSec: MAX_AGE_SEC,
      rows: rows.map((r) => ({
        source: r.source,
        kind: classifyRow(r),
        ageSec: r.ageSec,
      })),
    }),
  );

  if (!TELEGRAM_ON) return;

  if (stale && !wasStale) {
    st.stale = true;
    st.lastAlertTs = Date.now();
    saveState(st);
    const body = buildStaleBody(rows);
    if (!DRY_RUN) await sendTagged('ALERT', 'snapshot_stale', body);
    return;
  }

  if (stale && wasStale) {
    const repeatMs = Number(process.env.SNAPSHOT_FRESHNESS_REPEAT_ALERT_MS || 3_600_000);
    if (Date.now() - (st.lastAlertTs ?? 0) >= repeatMs) {
      if (kinds.some((k) => k === 'pg_error')) {
        console.log(
          JSON.stringify({
            ts: new Date().toISOString(),
            msg: 'snapshot-freshness-watch repeat skipped (pg_error rows present)',
            host: ALERT_HOST,
          }),
        );
        return;
      }
      st.lastAlertTs = Date.now();
      saveState(st);
      if (!DRY_RUN) await sendTagged('ALERT', 'snapshot_stale', buildStaleBody(rows));
    }
    return;
  }

  if (!stale && wasStale) {
    st.stale = false;
    st.staleConfirmTicks = 0;
    st.lastRecoveryAt = Date.now();
    saveState(st);
    if (!DRY_RUN) await sendTagged('ALERT', 'snapshot_stale', buildRecoveryBody(rows));
  }
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('[snapshot-freshness-watch] DATABASE_URL required');
    process.exit(1);
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      msg: 'snapshot-freshness-watch start',
      pollMs: POLL_MS,
      maxAgeSec: MAX_AGE_SEC,
      host: ALERT_HOST,
      telegramOn: TELEGRAM_ON,
      statePath: STATE_PATH,
      dryRun: DRY_RUN,
    }),
  );
  await tick(pool);
  setInterval(() => void tick(pool).catch((e) => console.error(e)), POLL_MS);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
