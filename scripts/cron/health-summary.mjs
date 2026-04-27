/**
 * Health summary cron — единый `[HEALTH][platform]` пост раз в час.
 *
 * Что включает:
 *  - pm2 jobs (alive / restart count / uptime)
 *  - QuickNode usage (data/quicknode-usage.json)
 *  - Очередь signatures_seed_queue: queued / processing / done / failed (за 24h)
 *  - rpc_features за 24h: tx_for_signature собрано, processed
 *  - swaps за 24h по source
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import pg from 'pg';
import { sendTagged } from '../lib/telegram.mjs';

const { Pool } = pg;

function parsePm2Jlist(raw, owner) {
  try {
    const arr = JSON.parse(raw);
    return arr.map((p) => ({
      owner,
      name: p.name,
      status: p.pm2_env?.status,
      restart: p.pm2_env?.restart_time ?? 0,
      uptime: p.pm2_env?.pm_uptime ? Date.now() - p.pm2_env.pm_uptime : 0,
    }));
  } catch { return []; }
}

function pm2ListSelf() {
  try {
    const out = execSync('pm2 jlist', { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    return parsePm2Jlist(out, process.env.USER || 'self');
  } catch { return []; }
}

// root-pm2 экспортируем минутным cron-job под root в /run/sa-root-pm2.json,
// чтобы health-summary под salpha мог его прочитать без sudo.
function pm2ListRoot() {
  const candidates = [
    process.env.ROOT_PM2_JSON_PATH,
    '/run/sa-root-pm2.json',
    '/tmp/sa-root-pm2.json',
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      const st = fs.statSync(p);
      const ageMs = Date.now() - st.mtimeMs;
      if (ageMs > 10 * 60 * 1000) continue; // старше 10 минут — не доверяем
      const raw = fs.readFileSync(p, 'utf8');
      return parsePm2Jlist(raw, 'root');
    } catch { /* try next */ }
  }
  return [];
}

function pm2List() {
  const self = pm2ListSelf();
  const root = pm2ListRoot();
  const seen = new Set();
  const all = [];
  for (const p of [...self, ...root]) {
    const key = `${p.owner}::${p.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    all.push(p);
  }
  return all;
}

function quicknodeUsage() {
  try {
    const p = process.env.QUICKNODE_USAGE_PATH || path.join('data', 'quicknode-usage.json');
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

async function dbStats() {
  const dsn = process.env.DATABASE_URL;
  if (!dsn) return null;
  const pool = new Pool({ connectionString: dsn, max: 2 });
  try {
    const out = {};
    const sigq = await pool.query(`
      SELECT status, count(*)::int AS n
      FROM signatures_seed_queue
      GROUP BY status
    `).catch(() => ({ rows: [] }));
    out.queue = sigq.rows;
    const f24 = await pool.query(`
      SELECT
        count(*) FILTER (WHERE feature_type='tx_for_signature' AND feature_ts >= now() - interval '24 hours')::int AS tx24,
        count(*) FILTER (WHERE feature_type='tx_for_signature' AND processed = true AND feature_ts >= now() - interval '24 hours')::int AS tx24_processed
      FROM rpc_features
    `).catch(() => ({ rows: [{}] }));
    out.tx24 = Number(f24.rows[0]?.tx24 ?? 0);
    out.tx24_processed = Number(f24.rows[0]?.tx24_processed ?? 0);
    const sw = await pool.query(`
      SELECT source, count(*)::int AS n
      FROM swaps
      WHERE block_time >= now() - interval '24 hours'
      GROUP BY source
      ORDER BY n DESC
    `).catch(() => ({ rows: [] }));
    out.swaps24 = sw.rows;
    return out;
  } finally {
    await pool.end().catch(() => {});
  }
}

function fmtMs(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

async function main() {
  const procs = pm2List();
  const qn = quicknodeUsage();
  const db = await dbStats();

  const lines = [];
  lines.push(`Платформа · ${new Date().toISOString().slice(0, 16)}Z`);
  if (procs.length) {
    const byOwner = procs.reduce((acc, p) => {
      (acc[p.owner] ||= []).push(p);
      return acc;
    }, {});
    for (const [owner, list] of Object.entries(byOwner)) {
      const offline = list.filter((p) => p.status !== 'online');
      lines.push(`pm2[${owner}]: ${list.length} процессов, online ${list.length - offline.length}, не online ${offline.length}`);
      if (offline.length) {
        for (const p of offline.slice(0, 6)) lines.push(`  ✗ ${p.name} status=${p.status} restart=${p.restart}`);
      }
      const top = [...list].sort((a, b) => b.restart - a.restart).slice(0, 3);
      for (const p of top) {
        lines.push(`  ${p.name}: status=${p.status} up=${fmtMs(p.uptime)} restart=${p.restart}`);
      }
    }
    if (!byOwner.root) {
      lines.push('  ⚠ root-pm2 dump не найден (нет /run/sa-root-pm2.json или старее 10 мин)');
    }
  } else {
    lines.push('pm2: нет данных');
  }

  if (qn) {
    const limit = Number(process.env.QUICKNODE_MONTHLY_CREDIT_BUDGET || 80_000_000);
    const used = Number(qn.creditsUsed ?? 0);
    const pct = ((used / Math.max(1, limit)) * 100).toFixed(2);
    lines.push(`QuickNode: ${used.toLocaleString('en-US')} / ${limit.toLocaleString('en-US')} (${pct}%) за ${qn.month}`);
  }
  if (db) {
    if (Array.isArray(db.queue) && db.queue.length) {
      const qstr = db.queue.map((q) => `${q.status}:${q.n}`).join(', ');
      lines.push(`sigseed_queue: ${qstr}`);
    }
    lines.push(`rpc_features.tx 24h: всего ${db.tx24}, обработано ${db.tx24_processed}`);
    if (Array.isArray(db.swaps24) && db.swaps24.length) {
      const sstr = db.swaps24.map((r) => `${r.source}:${r.n}`).join(', ');
      lines.push(`swaps 24h: ${sstr}`);
    }
  }

  await sendTagged('HEALTH', 'platform', lines.join('\n'));
  console.log('health-summary sent');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
