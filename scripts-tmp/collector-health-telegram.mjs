/**
 * Unified Oscar collector health → Telegram status + immediate blind alerts.
 *
 * PM2: sa-collector-health-telegram
 *
 * Env:
 *   COLLECTOR_HEALTH_TELEGRAM — `0` stdout only (default `1`)
 *   COLLECTOR_HEALTH_POLL_MS — poll interval (default 120000 = 2 min)
 *   COLLECTOR_HEALTH_STATUS_INTERVAL_MS — periodic OK report (default 1800000 = 30 min)
 *   COLLECTOR_HEALTH_ALERT_REPEAT_MS — repeat blind alert while degraded (default 900000 = 15 min)
 *   COLLECTOR_HEALTH_TICK_STALE_MS — no collector tick → blind (default 180000 = 3 min)
 *   COLLECTOR_HEALTH_TICK_STALE_BY_COLLECTOR — per-collector overrides, e.g. pumpswap=240000
 *   COLLECTOR_HEALTH_DISCOVERY_MAX_AGE_MS — stale live-discovery-health.json (default 120000)
 *   COLLECTOR_HEALTH_SHYFT_MAX_STALE_MS — no shyft status event (default 120000)
 *   COLLECTOR_HEALTH_LIVE_JSONL — tail path for Shyft status (default data/live/pt1-oscar-live.jsonl)
 *   COLLECTOR_HEALTH_JSONL_TAIL_BYTES — tail read size (default 524288)
 *   SNAPSHOT_FRESHNESS_MAX_AGE_SEC / SNAPSHOT_FRESHNESS_SKIP_SOURCES — PG freshness
 *   TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID
 */
import 'dotenv/config';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import pg from 'pg';
import { sendTagged } from '../scripts/lib/telegram.mjs';
import {
  DEFAULT_DEX_COLLECTORS,
  DEFAULT_PM2_COLLECTORS,
  DEFAULT_SNAPSHOT_SOURCES,
  assessBirdeyeConfig,
  assessCollectorTickAges,
  assessDexscreenerGate,
  assessDiscoveryHealthFile,
  assessNullRates,
  assessPm2Processes,
  assessShyftStatus,
  assessSnapshotRows,
  assessStrategyHeartbeats,
  buildCollectorHealthBody,
  indexPm2Apps,
  parseLastShyftStatusFromJsonlTail,
  parseSkipSources,
  parseCollectorTickStaleOverrides,
  shouldSendBlindAlert,
  shouldSendStatusReport,
} from './collector-health-lib.mjs';

const { Pool } = pg;

const POLL_MS = Math.max(30_000, Number(process.env.COLLECTOR_HEALTH_POLL_MS || 120_000));
const STATUS_INTERVAL_MS = Math.max(
  POLL_MS,
  Number(process.env.COLLECTOR_HEALTH_STATUS_INTERVAL_MS || 30 * 60_000),
);
const ALERT_REPEAT_MS = Math.max(
  POLL_MS,
  Number(process.env.COLLECTOR_HEALTH_ALERT_REPEAT_MS || 15 * 60_000),
);
const TICK_STALE_MS = Math.max(30_000, Number(process.env.COLLECTOR_HEALTH_TICK_STALE_MS || 180_000));
const TICK_STALE_BY_COLLECTOR = parseCollectorTickStaleOverrides(
  process.env.COLLECTOR_HEALTH_TICK_STALE_BY_COLLECTOR,
);
const DISCOVERY_MAX_AGE_MS = Math.max(
  30_000,
  Number(process.env.COLLECTOR_HEALTH_DISCOVERY_MAX_AGE_MS || 120_000),
);
const SHYFT_MAX_STALE_MS = Math.max(
  30_000,
  Number(process.env.COLLECTOR_HEALTH_SHYFT_MAX_STALE_MS || 120_000),
);
const MAX_AGE_SEC = Math.max(60, Number(process.env.SNAPSHOT_FRESHNESS_MAX_AGE_SEC || 900));
const SKIP_SOURCES = parseSkipSources(process.env.SNAPSHOT_FRESHNESS_SKIP_SOURCES);
const TELEGRAM_ON = !['0', 'false', 'no'].includes(
  String(process.env.COLLECTOR_HEALTH_TELEGRAM ?? '1').toLowerCase(),
);
const DRY_RUN = ['1', 'true', 'yes'].includes(
  String(process.env.COLLECTOR_HEALTH_DRY_RUN ?? '0').toLowerCase(),
);
const STATE_PATH =
  process.env.COLLECTOR_HEALTH_STATE_PATH ||
  path.join('data', 'collector-health-telegram-state.json');
const COLLECTOR_STATE_PATH =
  process.env.COLLECTOR_WATCH_STATE || path.join('data', 'collector-log-watch-state.json');
const DISCOVERY_PATH =
  process.env.LIVE_DISCOVERY_HEALTH_SNAPSHOT_PATH?.trim() ||
  path.join('data', 'live-discovery-health.json');
const LIVE_JSONL =
  process.env.COLLECTOR_HEALTH_LIVE_JSONL?.trim() ||
  path.join('data', 'live', 'pt1-oscar-live.jsonl');
const JSONL_TAIL_BYTES = Math.max(32_768, Number(process.env.COLLECTOR_HEALTH_JSONL_TAIL_BYTES || 524_288));
const DEX_GATE_PATH =
  process.env.DEXSCREENER_GLOBAL_GATE_PATH?.trim() ||
  path.join('data', 'dexscreener-api-gate.json');
const STRATEGY_TARGETS = [
  { pm2: 'live-oscar', heartbeatPath: 'data/ops-heartbeats/live-oscar.json', staleMs: 300_000 },
];

function envBool(key, fallback = false) {
  const v = process.env[key];
  if (v == null || v === '') return fallback;
  return !['0', 'false', 'no'].includes(String(v).toLowerCase());
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return {
      blind: false,
      lastAlertAt: 0,
      lastStatusAt: 0,
      log429Offsets: {},
      rate429Events: [],
    };
  }
}

function saveState(st) {
  const dir = path.dirname(STATE_PATH);
  if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true });
  const tmp = `${STATE_PATH}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(st, null, 2), 'utf8');
  fs.renameSync(tmp, STATE_PATH);
}

function readJsonFile(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function readHeartbeatAge(relPath) {
  const p = path.resolve(relPath);
  try {
    const raw = fs.readFileSync(p, 'utf8').trim().split('\n')[0];
    const j = JSON.parse(raw);
    if (typeof j.ts !== 'number') return null;
    return Math.max(0, Date.now() - j.ts);
  } catch {
    return null;
  }
}

function readFileAgeMs(p) {
  try {
    const st = fs.statSync(path.resolve(p));
    return Math.max(0, Date.now() - st.mtimeMs);
  } catch {
    return null;
  }
}

function tailText(absPath, maxBytes) {
  if (!fs.existsSync(absPath)) return '';
  const st = fs.statSync(absPath);
  const size = st.size;
  const start = Math.max(0, size - maxBytes);
  const fd = fs.openSync(absPath, 'r');
  try {
    const len = size - start;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    return buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function pm2Jlist() {
  try {
    const out = execSync('pm2 jlist', {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PM2_HOME: process.env.PM2_HOME || path.join(os.homedir(), '.pm2'),
      },
    });
    return JSON.parse(out);
  } catch {
    return [];
  }
}

function defaultCollectorLogPaths() {
  const pm2Home = process.env.PM2_HOME || path.join(os.homedir(), '.pm2');
  const logsDir = path.join(pm2Home, 'logs');
  return DEFAULT_DEX_COLLECTORS.map((n) => path.join(logsDir, `sa-${n}-out.log`));
}

function scan429SinceOffset(absPath, offset) {
  if (!fs.existsSync(absPath)) return { count: 0, offset: 0 };
  const st = fs.statSync(absPath);
  const size = st.size;
  let off = offset > size ? 0 : offset;
  if (off === size) return { count: 0, offset: size };
  const fd = fs.openSync(absPath, 'r');
  try {
    const len = size - off;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, off);
    const chunk = buf.toString('utf8');
    let count = 0;
    for (const line of chunk.split('\n')) {
      if (!line.includes('"status":429') && !line.includes('"status": 429')) continue;
      if (line.includes('request retry scheduled')) count += 1;
    }
    return { count, offset: size };
  } finally {
    fs.closeSync(fd);
  }
}

function readDexGate(nowMs) {
  const enabled = envBool('DEXSCREENER_GLOBAL_RATE_LIMIT', true);
  const maxRpm = Number(process.env.DEXSCREENER_GLOBAL_MAX_RPM || 60);
  const j = readJsonFile(path.resolve(DEX_GATE_PATH));
  return {
    enabled,
    maxRpm: Number.isFinite(maxRpm) ? maxRpm : 60,
    nextAllowedMs: typeof j?.nextAllowedMs === 'number' ? j.nextAllowedMs : 0,
    updatedAt: typeof j?.updatedAt === 'number' ? j.updatedAt : null,
    nowMs,
  };
}

async function fetchSnapshotRows(pool) {
  const out = [];
  for (const { source, table } of DEFAULT_SNAPSHOT_SOURCES) {
    try {
      const r = await pool.query(
        `SELECT MAX(ts) AS ts, EXTRACT(EPOCH FROM (now() - MAX(ts)))::int AS age_sec FROM ${table}`,
      );
      const ts = r.rows[0]?.ts ?? null;
      const ageSec = r.rows[0]?.age_sec != null ? Number(r.rows[0].age_sec) : null;
      const ok =
        ts != null && ageSec != null && Number.isFinite(ageSec) && ageSec >= 0 && ageSec <= MAX_AGE_SEC;
      out.push({ source, ageSec, ok });
    } catch (e) {
      out.push({ source, ageSec: null, ok: false, error: String(e?.message || e) });
    }
  }
  return out;
}

async function fetchNullRates(pool) {
  const out = [];
  for (const { source, table } of DEFAULT_SNAPSHOT_SOURCES) {
    if (SKIP_SOURCES.has(source)) continue;
    try {
      const r = await pool.query(`
        SELECT COUNT(*)::int AS total,
               ROUND(100.0 * COUNT(*) FILTER (WHERE market_cap_usd IS NULL) / NULLIF(COUNT(*), 0), 1) AS mcap_null_pct,
               ROUND(100.0 * COUNT(*) FILTER (WHERE volume_1h IS NULL) / NULLIF(COUNT(*), 0), 1) AS vol_null_pct
        FROM ${table}
        WHERE ts > now() - interval '15 minutes'
      `);
      const row = r.rows[0] ?? {};
      out.push({
        source,
        total: Number(row.total ?? 0),
        mcapNullPct: row.mcap_null_pct != null ? Number(row.mcap_null_pct) : null,
        volNullPct: row.vol_null_pct != null ? Number(row.vol_null_pct) : null,
      });
    } catch {
      out.push({ source, total: 0, mcapNullPct: null, volNullPct: null });
    }
  }
  return out;
}

function collectReasons(ctx) {
  const reasons = [];
  for (const c of ctx.collectors) {
    if (c.blind) reasons.push(`${c.collector}: tick stale ${formatAge(c.ageMs)}`);
  }
  for (const p of ctx.pm2) {
    if (p.blind) reasons.push(`${p.name}: pm2 ${p.status}`);
  }
  if (ctx.snapshots.blind) {
    for (const r of ctx.snapshots.staleRows) {
      reasons.push(`PG ${r.source}: stale age=${formatAgeSec(r.ageSec)}`);
    }
  }
  if (ctx.shyft.blind) {
    reasons.push(`Shyft: ${ctx.shyft.status ?? 'unknown'} age=${formatAge(ctx.shyft.ageMs)}`);
  }
  if (ctx.discovery.blind) {
    reasons.push(`Discovery snapshot stale (${formatAge(ctx.discovery.fileAgeMs)})`);
  }
  for (const s of ctx.strategies) {
    if (s.blind) reasons.push(`${s.name}: ${s.status}${s.heartbeatAgeMs != null ? ` hb=${formatAge(s.heartbeatAgeMs)}` : ''}`);
  }
  if (ctx.dexscreener.warn) reasons.push(`DexScreener throttled ~${formatAge(ctx.dexscreener.waitMs)}`);
  if (ctx.rate429Total >= 5) reasons.push(`HTTP 429 burst: ${ctx.rate429Total} in 15m window`);
  return reasons;
}

function formatAge(ageMs) {
  if (ageMs == null || !Number.isFinite(ageMs)) return '?';
  if (ageMs < 60_000) return `${Math.round(ageMs / 1000)}s`;
  return `${Math.round(ageMs / 60_000)}m`;
}

function formatAgeSec(ageSec) {
  if (ageSec == null || !Number.isFinite(ageSec)) return '?';
  if (ageSec < 120) return `${Math.round(ageSec)}s`;
  return `${Math.round(ageSec / 60)}m`;
}

async function gather(pool, state) {
  const nowMs = Date.now();
  const pm2Map = indexPm2Apps(pm2Jlist());
  const pm2Names = [
    ...DEFAULT_PM2_COLLECTORS,
    'sa-collector-watch',
    'sa-snapshot-freshness-watch',
    'live-oscar',
  ];
  const pm2 = assessPm2Processes(pm2Map, pm2Names);

  const collectorState = readJsonFile(path.resolve(COLLECTOR_STATE_PATH));
  const collectors = assessCollectorTickAges(
    collectorState?.lastTickCompletedAt,
    DEFAULT_DEX_COLLECTORS,
    nowMs,
    TICK_STALE_MS,
    TICK_STALE_BY_COLLECTOR,
  );

  const snapRows = pool ? await fetchSnapshotRows(pool) : DEFAULT_SNAPSHOT_SOURCES.map((s) => ({
    source: s.source,
    ageSec: null,
    ok: false,
    error: 'no_db',
  }));
  const snapshots = assessSnapshotRows(snapRows, MAX_AGE_SEC, SKIP_SOURCES);

  const shyftParsed = parseLastShyftStatusFromJsonlTail(tailText(path.resolve(LIVE_JSONL), JSONL_TAIL_BYTES), nowMs);
  const shyft = assessShyftStatus({
    shadowEnabled: envBool('PAPER_LIVE_LERA_SHYFT_SHADOW_ENABLED', false),
    primaryEnabled: envBool('SHYFT_PRICE_PRIMARY_ENABLED', false),
    defiMcapEnabled: envBool('SHYFT_DEFI_MCAP_ENABLED', false),
    lastStatus: shyftParsed.status,
    lastStatusAgeMs: shyftParsed.ageMs,
    maxStaleMs: SHYFT_MAX_STALE_MS,
  });

  const birdeye = assessBirdeyeConfig({
    birdeyePrimary: envBool('BIRDEYE_PRIMARY_ENABLED', false),
    birdeyeCollector: envBool('BIRDEYE_COLLECTOR_ENABLED', false),
  });

  const discoveryData = readJsonFile(path.resolve(DISCOVERY_PATH));
  const liveOscarOnline = pm2Map.get('live-oscar')?.status === 'online';
  const discovery = assessDiscoveryHealthFile(
    discoveryData,
    readFileAgeMs(DISCOVERY_PATH),
    DISCOVERY_MAX_AGE_MS,
    liveOscarOnline,
  );

  const strategies = assessStrategyHeartbeats(
    STRATEGY_TARGETS.map((t) => ({
      name: t.pm2,
      status: pm2Map.get(t.pm2)?.status ?? 'missing',
      heartbeatAgeMs: readHeartbeatAge(t.heartbeatPath),
      maxStaleMs: t.staleMs,
    })),
  );

  const dexscreener = assessDexscreenerGate(readDexGate(nowMs), nowMs);

  if (!state.log429Offsets) state.log429Offsets = {};
  if (!state.rate429Events) state.rate429Events = [];
  const windowCutoff = nowMs - 15 * 60_000;
  state.rate429Events = state.rate429Events.filter((e) => Number(e.ts) >= windowCutoff);
  for (const logPath of defaultCollectorLogPaths()) {
    const abs = path.resolve(logPath);
    const prevOff = state.log429Offsets[abs] ?? 0;
    const { count, offset } = scan429SinceOffset(abs, prevOff);
    state.log429Offsets[abs] = offset;
    if (count > 0) state.rate429Events.push({ ts: nowMs, count });
  }
  const rate429Total = state.rate429Events.reduce((sum, e) => sum + Number(e.count || 0), 0);

  const nullRateRows = pool ? await fetchNullRates(pool) : [];
  const nullRates = assessNullRates(nullRateRows);

  const blind =
    collectors.some((c) => c.blind) ||
    pm2.filter((p) => DEFAULT_PM2_COLLECTORS.includes(p.name)).some((p) => p.blind) ||
    snapshots.blind ||
    shyft.blind ||
    discovery.blind ||
    strategies.some((s) => s.blind);

  const warn =
    dexscreener.warn ||
    shyft.warn ||
    nullRates.warn ||
    rate429Total >= 3;

  const ctx = {
    blind,
    warn: warn && !blind,
    collectors,
    pm2: pm2.filter((p) => DEFAULT_PM2_COLLECTORS.includes(p.name)),
    snapshots,
    shyft,
    birdeye,
    discovery,
    strategies,
    dexscreener,
    nullRates,
    rate429Total,
    reasons: [],
  };
  ctx.reasons = collectReasons(ctx);
  return ctx;
}

async function tick(pool) {
  const state = loadState();
  const ctx = await gather(pool, state);
  const nowMs = Date.now();
  const body = buildCollectorHealthBody(ctx);

  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      msg: 'collector-health tick',
      blind: ctx.blind,
      warn: ctx.warn,
      reasons: ctx.reasons,
    }),
  );

  const prevBlind = state.blind === true;
  const sendAlert = shouldSendBlindAlert(prevBlind, ctx.blind, state.lastAlertAt ?? 0, nowMs, ALERT_REPEAT_MS);
  const sendRecoveryStatus = shouldSendStatusReport(
    ctx.blind || ctx.warn,
    state.lastStatusAt ?? 0,
    nowMs,
    STATUS_INTERVAL_MS,
    true,
    prevBlind,
  );
  const sendPeriodicOk =
    !ctx.blind &&
    !ctx.warn &&
    shouldSendStatusReport(false, state.lastStatusAt ?? 0, nowMs, STATUS_INTERVAL_MS, false, prevBlind);

  if (sendAlert) {
    state.lastAlertAt = nowMs;
    if (!DRY_RUN && TELEGRAM_ON) {
      await sendTagged('ALERT', 'collector_blind', body, { skipQuietHours: true });
    } else {
      console.log(`[ALERT][collector_blind]\n${body}`);
    }
  } else if (sendRecoveryStatus && prevBlind && !ctx.blind) {
    if (!DRY_RUN && TELEGRAM_ON) {
      await sendTagged('HEALTH', 'collector_status', body, { skipQuietHours: true });
    } else {
      console.log(`[HEALTH][collector_status]\n${body}`);
    }
    state.lastStatusAt = nowMs;
  } else if (sendPeriodicOk || (sendRecoveryStatus && !ctx.blind && ctx.warn)) {
    if (!DRY_RUN && TELEGRAM_ON) {
      await sendTagged('HEALTH', 'collector_status', body, { skipQuietHours: true });
    } else {
      console.log(`[HEALTH][collector_status]\n${body}`);
    }
    state.lastStatusAt = nowMs;
  }

  state.blind = ctx.blind;
  saveState(state);
}

async function main() {
  const pool = process.env.DATABASE_URL
    ? new Pool({ connectionString: process.env.DATABASE_URL })
    : null;
  if (!pool) {
    console.warn('[collector-health-telegram] DATABASE_URL missing — PG checks disabled');
  }

  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      msg: 'collector-health-telegram start',
      pollMs: POLL_MS,
      statusIntervalMs: STATUS_INTERVAL_MS,
      alertRepeatMs: ALERT_REPEAT_MS,
      tickStaleMs: TICK_STALE_MS,
      tickStaleByCollector: TICK_STALE_BY_COLLECTOR,
      telegram: TELEGRAM_ON,
      dryRun: DRY_RUN,
      statePath: STATE_PATH,
    }),
  );

  await tick(pool);
  setInterval(() => void tick(pool).catch((e) => console.error(e)), POLL_MS);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
