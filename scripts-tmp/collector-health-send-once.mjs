#!/usr/bin/env node
/** One-shot: build collector health body and optionally send to Telegram (Oscar VPS smoke). */
import 'dotenv/config';
import { execSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
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
  assessPm2Processes,
  assessShyftStatus,
  assessSnapshotRows,
  assessStrategyHeartbeats,
  buildCollectorHealthBody,
  indexPm2Apps,
  parseCollectorTickStaleOverrides,
  parseLastShyftStatusFromJsonlTail,
  parseSkipSources,
} from './collector-health-lib.mjs';

const sendNow = process.argv.includes('--send');
const PRODUCT_LABEL = String(process.env.COLLECTOR_HEALTH_PRODUCT_LABEL || 'Oscar').trim() || 'Oscar';

function pm2Jlist() {
  try {
    return JSON.parse(
      execSync('pm2 jlist', {
        encoding: 'utf8',
        env: { ...process.env, PM2_HOME: process.env.PM2_HOME || path.join(os.homedir(), '.pm2') },
      }),
    );
  } catch {
    return [];
  }
}

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function readHeartbeatAge(relPath) {
  try {
    const j = JSON.parse(fs.readFileSync(path.resolve(relPath), 'utf8').trim().split('\n')[0]);
    return typeof j.ts === 'number' ? Math.max(0, Date.now() - j.ts) : null;
  } catch {
    return null;
  }
}

function readFileAgeMs(p) {
  try {
    return Math.max(0, Date.now() - fs.statSync(path.resolve(p)).mtimeMs);
  } catch {
    return null;
  }
}

function tailText(absPath, maxBytes) {
  if (!fs.existsSync(absPath)) return '';
  const st = fs.statSync(absPath);
  const start = Math.max(0, st.size - maxBytes);
  const fd = fs.openSync(absPath, 'r');
  try {
    const buf = Buffer.alloc(st.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    return buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function parseStrategyTargets(raw) {
  const fallback = [{ pm2: 'live-oscar', heartbeatPath: 'data/ops-heartbeats/live-oscar.json', staleMs: 300_000 }];
  if (!raw?.trim()) return fallback;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length ? parsed : fallback;
  } catch {
    return fallback;
  }
}

const strategyTargets = parseStrategyTargets(process.env.COLLECTOR_HEALTH_STRATEGY_TARGETS);
const discoveryPath = process.env.LIVE_DISCOVERY_HEALTH_SNAPSHOT_PATH || 'data/live-discovery-health.json';
const liveJsonl = process.env.COLLECTOR_HEALTH_LIVE_JSONL || 'data/live/pt1-oscar-live.jsonl';
const skipSources = parseSkipSources(process.env.SNAPSHOT_FRESHNESS_SKIP_SOURCES);
const maxAgeSec = Math.max(60, Number(process.env.SNAPSHOT_FRESHNESS_MAX_AGE_SEC || 900));
const tickStaleMs = Math.max(30_000, Number(process.env.COLLECTOR_HEALTH_TICK_STALE_MS || 180_000));
const tickStaleBy = parseCollectorTickStaleOverrides(process.env.COLLECTOR_HEALTH_TICK_STALE_BY_COLLECTOR);
const discoveryMaxAgeMs = Math.max(30_000, Number(process.env.COLLECTOR_HEALTH_DISCOVERY_MAX_AGE_MS || 120_000));

const nowMs = Date.now();
const pm2Map = indexPm2Apps(pm2Jlist());
const collectorState = readJson(process.env.COLLECTOR_WATCH_STATE || 'data/collector-log-watch-state.json');
const collectors = assessCollectorTickAges(
  collectorState?.lastTickCompletedAt,
  DEFAULT_DEX_COLLECTORS,
  nowMs,
  tickStaleMs,
  tickStaleBy,
);
const pm2 = assessPm2Processes(pm2Map, DEFAULT_PM2_COLLECTORS);
const discoveryData = readJson(discoveryPath);
const liveOscarOnline = pm2Map.get('live-oscar')?.status === 'online';
const discovery = assessDiscoveryHealthFile(
  discoveryData,
  readFileAgeMs(discoveryPath),
  discoveryMaxAgeMs,
  liveOscarOnline,
);
const shyftParsed = parseLastShyftStatusFromJsonlTail(tailText(path.resolve(liveJsonl), 524_288), nowMs);
const shyft = assessShyftStatus({
  shadowEnabled: false,
  primaryEnabled: false,
  defiMcapEnabled: false,
  lastStatus: shyftParsed.status,
  lastStatusAgeMs: shyftParsed.ageMs,
  maxStaleMs: 120_000,
});
const birdeye = assessBirdeyeConfig({ birdeyePrimary: false, birdeyeCollector: false });
const dexscreener = assessDexscreenerGate({ enabled: true, maxRpm: 60, nextAllowedMs: 0 }, nowMs);
const strategies = assessStrategyHeartbeats(
  strategyTargets.map((t) => ({
    name: t.pm2,
    status: pm2Map.get(t.pm2)?.status ?? 'missing',
    heartbeatAgeMs: readHeartbeatAge(t.heartbeatPath),
    maxStaleMs: Number(t.staleMs || 300_000),
  })),
);

let snapshots = { rows: [], staleRows: [], worstAgeSec: null, blind: false };
if (process.env.DATABASE_URL) {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const rows = [];
  for (const { source, table } of DEFAULT_SNAPSHOT_SOURCES) {
    try {
      const r = await pool.query(
        `SELECT EXTRACT(EPOCH FROM (now() - MAX(ts)))::int AS age_sec FROM ${table}`,
      );
      const ageSec = r.rows[0]?.age_sec != null ? Number(r.rows[0].age_sec) : null;
      rows.push({ source, ageSec, ok: ageSec != null && ageSec <= maxAgeSec });
    } catch {
      rows.push({ source, ageSec: null, ok: false });
    }
  }
  snapshots = assessSnapshotRows(rows, maxAgeSec, skipSources);
  await pool.end();
}

const blind =
  collectors.some((c) => c.blind) ||
  pm2.some((p) => p.blind) ||
  snapshots.blind ||
  discovery.blind ||
  strategies.some((s) => s.blind);
const body = buildCollectorHealthBody(
  {
    blind,
    warn: false,
    collectors,
    pm2,
    snapshots,
    shyft,
    birdeye,
    discovery,
    strategies,
    dexscreener,
    nullRates: { flagged: [] },
    rate429Total: 0,
    reasons: [],
  },
  { productLabel: PRODUCT_LABEL },
);

console.log(`[HEALTH][collector_status]\n${body}`);
if (process.argv.includes('--send')) {
  const ok = await sendTagged('HEALTH', 'collector_status', body, { skipQuietHours: true });
  console.log(JSON.stringify({ sent: ok, product: PRODUCT_LABEL }));
}
